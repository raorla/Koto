import { run } from '@grammyjs/runner';
import { Bot } from 'grammy';
import { createAgent } from './agent/agent.js';
import { hasKnownPrice } from './agent/pricing.js';
import { backupDir, startDailyBackups } from './backup.js';
import { COMMANDS, GROUP_COMMANDS, createBot, telegramDownloader, type KotoContext } from './bot/bot.js';
import { startCallServer, type RunningCallServer } from './call/server.js';
import { sendConfirmation, telegramMissionNotifier, telegramTaskNotifier, telegramVoiceSender } from './bot/delivery.js';
import { setupBrowser } from './browser/setup.js';
import { sendText } from './bot/format.js';
import { loadEnvFile, readConfig } from './config.js';
import { openDatabase } from './db.js';
import { ComposioIntegrations } from './integrations/composio.js';
import type { Integrations } from './integrations/types.js';
import { createLlmClient } from './llm.js';
import { MemoryKeeper } from './memory/consolidate.js';
import { MissionRunner } from './missions/runner.js';
import { createNewsService } from './news.js';
import { createScheduler } from './scheduler.js';
import { setupSynthesizer, type Synthesizer } from './speech.js';
import { createOpenRouterTranscriber } from './voice.js';
import { Store } from './store.js';
import { createWeatherService } from './weather.js';
import { KeyedLock, consoleLogger as log } from './util.js';

loadEnvFile();
const config = readConfig();

if (!config.telegramToken) {
  log.error('TELEGRAM_BOT_TOKEN manquant : crée un bot avec @BotFather et mets son token dans .env');
  process.exit(1);
}
if (config.provider === 'openrouter' && !config.openrouterApiKey) {
  log.error('LLM_PROVIDER=openrouter mais OPENROUTER_API_KEY est vide dans .env');
  process.exit(1);
}
if (config.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  log.warn("Ni ANTHROPIC_API_KEY ni OPENROUTER_API_KEY : le SDK cherchera un profil `ant auth login`, sinon les appels échoueront");
}
if (!hasKnownPrice(config.model)) {
  log.warn(`Pas de tarif connu pour ${config.model} : les coûts seront estimés au tarif de claude-opus-5-5`);
}
if (config.registrationMode === 'invite' && config.adminTelegramIds.length === 0) {
  log.warn("Aucun admin (ADMIN_TELEGRAM_IDS) : personne ne peut créer la première invitation. Écris au bot pour connaître ton identifiant.");
}

const db = openDatabase(config.databasePath);
const store = new Store(db);
const llm = createLlmClient(config);
const locks = new KeyedLock();

// Gmail et Google Agenda (via Composio en MCP) : facultatifs, Koto démarre sans.
let integrations: Integrations | null = null;
if (config.composioApiKey) {
  try {
    integrations = await ComposioIntegrations.create({ apiKey: config.composioApiKey, store, log });
    log.info('intégrations prêtes', { tools: integrations.tools.length });
  } catch (err) {
    log.error('Composio injoignable : Gmail et Google Agenda désactivés pour cette session', err);
  }
} else {
  log.info('COMPOSIO_API_KEY vide : Gmail et Google Agenda désactivés');
}

const transcriber =
  config.voice && config.openrouterApiKey
    ? createOpenRouterTranscriber(config.openrouterApiKey, config.transcribeModel, fetch, config.openrouterBaseUrl)
    : null;
if (config.voice && !transcriber) log.warn('Vocaux désactivés : la transcription passe par OpenRouter (OPENROUTER_API_KEY)');

// Réponses vocales : voix gratuite d'OpenRouter, voix quasi gratuite en secours.
let synthesizer: Synthesizer | null = null;
if (config.speech && config.openrouterApiKey) {
  try {
    const speech = await setupSynthesizer({
      apiKey: config.openrouterApiKey,
      primary: { model: config.speechModel, voice: config.speechVoice },
      fallback: config.speechFallbackModel ? { model: config.speechFallbackModel, voice: config.speechFallbackVoice } : null,
      log,
      baseUrl: config.openrouterBaseUrl,
    });
    synthesizer = speech.synthesizer;
    log.info('réponses vocales prêtes', { voices: speech.voices.map((v) => v.model) });
  } catch (err) {
    log.error('Réponses vocales désactivées (KOTO_TTS_MODEL / KOTO_TTS_VOICE)', err);
  }
} else if (config.speech) {
  log.warn('Réponses vocales désactivées : la synthèse passe par OpenRouter (OPENROUTER_API_KEY)');
}

// Veille du brief : flux RSS et cours gratuits, partagés entre utilisateurs.
const news = createNewsService({ log });

// Le bot est créé d'abord : les tâches web ont besoin de son API pour envoyer captures et boutons.
const bot = new Bot<KotoContext>(config.telegramToken, { client: { apiRoot: config.telegramApiRoot } });

// Météo (MET Norway) et lieux (OpenStreetMap) : gratuits, à condition de s'identifier. Le lien du bot
// sert de contact une fois connu (bot.init plus bas).
let contact = 'Telegram';
const weather = createWeatherService({ userAgent: () => `Koto/0.4 (assistant personnel; +${contact})`, log });
const browserTasks = await setupBrowser({
  config,
  store,
  create: (params) => llm.beta.messages.create(params),
  notifier: telegramTaskNotifier(bot.api),
  log,
});
const interrupted = browserTasks?.recoverInterrupted() ?? [];
// Vocaux envoyés hors conversation : rappels, briefs, messages des missions.
const speak = synthesizer ? telegramVoiceSender({ api: bot.api, synthesizer, store, log }) : null;

// Missions de fond : le scheduler lance leurs passages en arrière-plan, avec les mêmes briques (gratuites d'abord).
const missions = config.missions
  ? new MissionRunner({
      store,
      config,
      create: (params) => llm.beta.messages.create(params),
      notifier: telegramMissionNotifier(bot.api, speak),
      locks,
      log,
      news,
      weather,
      integrations,
      browser: browserTasks,
    })
  : null;

// Ménage de la mémoire (fusions, archives) par le modèle le moins cher, lancé par le scheduler.
const memory = config.memoryConsolidation
  ? new MemoryKeeper({
      store,
      config,
      create: (params) => llm.beta.messages.create(params),
      notifier: { send: (account, text) => sendText(bot.api, account.chatId, text) },
      locks,
      log,
    })
  : null;

// Appels en direct (mini-app Telegram) : il faut une adresse HTTPS publique et la transcription.
const callsEnabled = config.publicUrl !== null && transcriber !== null;
if (config.publicUrl && !transcriber) log.warn('Appels désactivés : la transcription passe par OpenRouter (OPENROUTER_API_KEY)');

// Les photos et PDF reçus restent chez Telegram : open_document les y retélécharge quand la fiche ne suffit pas.
const download = telegramDownloader(config.telegramToken, config.telegramApiRoot);

const agent = createAgent({
  create: (params) => llm.beta.messages.create(params),
  store,
  provider: config.provider,
  model: config.model,
  effort: config.effort,
  webTools: config.webTools,
  integrations,
  browser: browserTasks,
  speech: synthesizer !== null,
  news: true,
  weather,
  calls: callsEnabled,
  missions: missions?.settings ?? null,
  fetchFile: (fileId, maxBytes) => download(bot.api, fileId, maxBytes),
  log,
});

createBot(
  { config, store, agent, locks, log, integrations, transcriber, synthesizer, news, weather, browserTasks, missions, callUrl: callsEnabled ? config.publicUrl : null },
  bot,
);
await bot.init();
contact = `https://t.me/${bot.botInfo.username}`;
for (const task of interrupted) {
  const owner = store.getUserById(task.userId);
  if (!owner) continue;
  await sendText(bot.api, owner.chatId, `⚠️ Ta tâche web #${task.id} a été interrompue par un redémarrage de Koto. Redemande-la-moi si besoin.`).catch(() => {});
}
// Le long polling échoue (409) si un webhook est configuré : on le retire, sans effet sinon.
await bot.api.deleteWebhook();
await bot.api.setMyCommands(COMMANDS);
// Dans les groupes, le menu ne propose que les commandes du groupe.
await bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
// Bouton « Appeler » à côté du champ de saisie (en privé), ou le menu habituel sans appels.
await bot.api
  .setChatMenuButton({
    menu_button: callsEnabled ? { type: 'web_app', text: 'Appeler', web_app: { url: `${config.publicUrl}/appel` } } : { type: 'default' },
  })
  .catch((err) => log.warn('bouton de menu non mis à jour', { error: err instanceof Error ? err.message : String(err) }));

let calls: RunningCallServer | null = null;
if (callsEnabled) {
  calls = await startCallServer(
    {
      config,
      store,
      agent,
      locks,
      log,
      transcriber: transcriber!,
      synthesizer,
      telegram: {
        confirm: (chatId, action) => sendConfirmation(bot.api, chatId, action),
        send: (chatId, text) => sendText(bot.api, chatId, text),
      },
    },
    { port: config.callPort, host: config.callHost },
  );
  log.info('appels prêts', { url: `${config.publicUrl}/appel`, port: calls.port });
}

const scheduler = createScheduler({
  store,
  config,
  agent,
  locks,
  log,
  news,
  weather,
  missions,
  memory,
  notifier: {
    send: (chatId, text) => sendText(bot.api, chatId, text),
    confirm: (chatId, action) => sendConfirmation(bot.api, chatId, action),
    ...(speak ? { speak: async (user, text) => void (await speak(user, text)) } : {}),
  },
});
scheduler.start(config.schedulerIntervalMs);

// Sauvegarde quotidienne de la base (API backup de SQLite) dans data/backups.
const backups =
  config.backupKeep > 0 ? startDailyBackups({ db, dir: backupDir(config.databasePath), keep: config.backupKeep, log }) : null;

const runner = run(bot);
// deploy/deploy.sh attend cette ligne pour confirmer le démarrage sur le serveur.
log.info(`Koto est en ligne : https://t.me/${bot.botInfo.username}`, {
  provider: config.provider,
  model: config.model,
  effort: config.effort,
  registration: config.registrationMode,
  integrations: integrations !== null,
  voice: transcriber !== null,
  speech: synthesizer !== null,
  calls: callsEnabled,
  browser: browserTasks !== null,
  browserHeaded: config.browserHeaded,
  missions: missions !== null,
  memoryModel: memory ? config.memoryModel : null,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`arrêt (${signal})`);
  scheduler.stop();
  backups?.stop();
  await calls?.close();
  browserTasks?.shutdown();
  if (runner.isRunning()) await runner.stop();
  await integrations?.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
