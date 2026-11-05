// Discuter avec Koto dans le terminal, sans Telegram : `npm run cli`.
// Utilise sa propre base (./data/cli.db) et un utilisateur local admin.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { applySettings, budgetStatus, ensureUser } from './accounts.js';
import { createAgent } from './agent/agent.js';
import { renderTaskQuestion } from './bot/delivery.js';
import { setupBrowser } from './browser/setup.js';
import { loadEnvFile, readConfig } from './config.js';
import { openDatabase } from './db.js';
import { cancelAction, confirmAction } from './integrations/actions.js';
import { TOOLKITS, TOOLKIT_LABELS, renderActionPreview, type Toolkit } from './integrations/catalog.js';
import { ComposioIntegrations } from './integrations/composio.js';
import type { Integrations } from './integrations/types.js';
import { createLlmClient } from './llm.js';
import { MemoryKeeper } from './memory/consolidate.js';
import { MissionRunner } from './missions/runner.js';
import { createNewsService } from './news.js';
import { briefNews, briefRequest, briefWeather, createScheduler } from './scheduler.js';
import { createWeatherService } from './weather.js';
import { buildExport } from './export.js';
import { setupSynthesizer, toSpeechText, voiceForBrief, voiceForReply, type Synthesizer } from './speech.js';
import { MEMORY_KIND_LABELS, Store, emptyUsage, type PendingAction, type User } from './store.js';
import { formatRelative, isValidTimezone, localDay } from './time.js';
import { KeyedLock, consoleLogger, silentLogger } from './util.js';

const LOCAL_TELEGRAM_ID = 0;

loadEnvFile();
const config = { ...readConfig(), adminTelegramIds: [LOCAL_TELEGRAM_ID] };
const db = openDatabase(process.env.KOTO_CLI_DB ?? './data/cli.db');
const store = new Store(db);
const locks = new KeyedLock();
const llm = createLlmClient(config);
const log = process.env.KOTO_DEBUG ? consoleLogger : silentLogger;

const registration = ensureUser(
  store,
  config,
  { telegramId: LOCAL_TELEGRAM_ID, chatId: LOCAL_TELEGRAM_ID, firstName: process.env.USER ?? null, username: null, language: 'fr' },
  null,
  Date.now(),
);
if (!registration.ok) throw new Error('Impossible de créer l’utilisateur local');
const userId = registration.user.id;

let integrations: Integrations | null = null;
if (config.composioApiKey) {
  try {
    integrations = await ComposioIntegrations.create({ apiKey: config.composioApiKey, store, log });
  } catch (err) {
    console.log(`[Composio indisponible : ${err instanceof Error ? err.message : String(err)}]`);
  }
}

const browserTasks = await setupBrowser({
  config,
  store,
  create: (params) => llm.beta.messages.create(params),
  log,
  notifier: {
    async question(_user, task, questionId, question) {
      const { text } = renderTaskQuestion(task, questionId, question);
      let capture = '';
      if (question.screenshot) {
        writeFileSync('./data/derniere-capture.jpg', question.screenshot);
        capture = '\n(capture : data/derniere-capture.jpg)';
      }
      const replies = question.kind === 'handover' ? `/fait ${questionId}  ou  /non ${questionId}` : `/oui ${questionId}  ou  /non ${questionId}`;
      process.stdout.write(`\n\n${text}${capture}\n→ ${replies}\n\ntoi › `);
    },
    async finished(_user, task, result) {
      process.stdout.write(`\n\n🌐 Tâche web #${task.id} (${result.status}, ${result.steps} étapes, ${result.usage.costUsd.toFixed(4)} $) :\n${result.summary}\n\ntoi › `);
    },
  },
});
browserTasks?.recoverInterrupted();

// Vocaux : pas de haut-parleur dans le terminal, le dernier vocal est enregistré dans data/.
let synthesizer: Synthesizer | null = null;
if (config.speech && config.openrouterApiKey) {
  try {
    synthesizer = (
      await setupSynthesizer({
        apiKey: config.openrouterApiKey,
        primary: { model: config.speechModel, voice: config.speechVoice },
        fallback: config.speechFallbackModel ? { model: config.speechFallbackModel, voice: config.speechFallbackVoice } : null,
        log,
      })
    ).synthesizer;
  } catch (err) {
    console.log(`[Vocaux indisponibles : ${err instanceof Error ? err.message : String(err)}]`);
  }
}
const news = createNewsService({ log });
const weather = createWeatherService({ userAgent: () => 'Koto/0.4 (assistant personnel; mode terminal)', log });

async function speakToFile(user: User, text: string): Promise<void> {
  const speech = toSpeechText(text);
  if (!synthesizer || !speech) return;
  try {
    const voice = await synthesizer.synthesize(speech);
    store.addUsage(user.id, localDay(Date.now(), user.timezone), { ...emptyUsage(), requests: 1, costUsd: voice.costUsd });
    writeFileSync('./data/dernier-vocal.mp3', voice.audio);
    console.log(`🔊 vocal de ${voice.seconds} s : data/dernier-vocal.mp3 (${voice.costUsd.toFixed(5)} $)\n`);
  } catch (err) {
    console.log(`[vocal impossible : ${err instanceof Error ? err.message : String(err)}]\n`);
  }
}

// Missions : passages lancés par le scheduler local, messages affichés dans le terminal.
const missions = config.missions
  ? new MissionRunner({
      store,
      config,
      create: (params) => llm.beta.messages.create(params),
      locks,
      log,
      news,
      weather,
      integrations,
      browser: browserTasks,
      notifier: {
        send: async (_account, text) => void process.stdout.write(`\n\nkoto (mission) › ${text}\n\ntoi › `),
        confirm: async (_chatId, action) => showAction(action),
        proposeConclusion: async (_account, mission) =>
          void process.stdout.write(`\n🧠 Garder en mémoire : « ${mission.conclusion} » ?\n→ /retenir ${mission.id}\n\ntoi › `),
      },
    })
  : null;

// Ménage de la mémoire : par le scheduler local, ou tout de suite avec /ranger.
const memory = config.memoryConsolidation
  ? new MemoryKeeper({
      store,
      config,
      create: (params) => llm.beta.messages.create(params),
      locks,
      log,
      notifier: { send: async (_account, text) => void process.stdout.write(`\n\nkoto (mémoire) › ${text}\n\ntoi › `) },
    })
  : null;

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
  missions: missions?.settings ?? null,
  // KOTO_DEBUG=1 affiche le coût et les tokens de chaque tour (jamais le contenu).
  log,
});

function showAction(action: PendingAction): void {
  console.log(`${renderActionPreview(action.tool, action.args)}\n→ /confirmer ${action.id}  ou  /annuler ${action.id}\n`);
}

const scheduler = createScheduler({
  store,
  config,
  agent,
  locks,
  log: silentLogger,
  news,
  weather,
  missions,
  memory,
  notifier: {
    send: async (_chatId, text) => {
      process.stdout.write(`\n\nkoto (message programmé) › ${text}\n\ntoi › `);
    },
    confirm: async (_chatId, action) => showAction(action),
    ...(synthesizer ? { speak: speakToFile } : {}),
  },
});
scheduler.start(10_000);

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Avec une entrée pipée, readline se ferme dès la fin du flux alors que des lignes restent à traiter.
let inputClosed = false;
rl.on('close', () => (inputClosed = true));
const prompt = () => {
  if (!inputClosed) rl.prompt();
};
const extras =
  (integrations ? ' /connecter <gmail|googlecalendar> /confirmer <id> /annuler <id>' : '') +
  (browserTasks ? ' /taches /oui <id> /non <id> /fait <id> /arreter <id>' : '') +
  (missions ? ' /missions /arreter_mission <id> /retenir <id>' : '') +
  (memory ? ' /ranger' : '');
console.log(
  `Koto en local (${config.model} via ${config.provider}, effort ${config.effort}${integrations ? ', Gmail et Agenda activés' : ''}).\n` +
    `Commandes : /memoire /rappels /listes /brief /usage /exporter /fuseau <IANA> /reset /quit${extras}\n`,
);

async function ask(request: Parameters<typeof agent>[0], forceVoice = false): Promise<void> {
  process.stdout.write('… ');
  try {
    const result = await locks.run(userId, () => agent(request));
    console.log(`\rkoto › ${result.text}\n`);
    result.pendingActions.forEach(showAction);
    const user = store.getUserById(userId)!;
    if (result.status === 'ok' && (forceVoice || voiceForReply(user, { requested: result.voice ?? false, spokenInput: false }))) {
      await speakToFile(user, result.text);
    }
  } catch (err) {
    console.log(`\r[erreur] ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// L'itérateur garde en file les lignes reçues pendant qu'on traite la précédente
// (utile quand on colle plusieurs lignes ou qu'on pipe un script).
rl.setPrompt('toi › ');
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    prompt();
    continue;
  }
  const user = store.getUserById(userId)!;
  const [command, ...args] = line.split(/\s+/);

  if (command === '/quit' || command === '/exit') break;
  if (command === '/memoire') {
    const memories = store.listMemories(userId);
    const archived = store.listArchivedMemories(userId, 10);
    console.log(memories.length === 0 ? '(mémoire vide)\n' : memories.map((m) => `[${m.id}] ${MEMORY_KIND_LABELS[m.kind]} · ${'★'.repeat(m.importance)} · ${m.content}`).join('\n') + '\n');
    if (archived.length > 0) console.log(`Archivés :\n${archived.map((m) => `[${m.id}] ${m.content} (${m.archiveReason ?? 'archivé'})`).join('\n')}\n`);
  } else if (memory && command === '/ranger') {
    process.stdout.write('… ');
    try {
      const { status, report } = await memory.consolidate(user, Date.now());
      if (!report || report.merged.length + report.updated.length + report.archived.length === 0) console.log(`\rRien à ranger (${status}).\n`);
    } catch (err) {
      console.log(`\r[erreur] ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else if (command === '/rappels') {
    const jobs = store.listPendingJobs(userId);
    console.log(jobs.length === 0 ? '(aucun)\n' : jobs.map((j) => `#${j.id} ${j.kind} ${formatRelative(j.dueAt, user.timezone, Date.now())} — ${j.text}`).join('\n') + '\n');
  } else if (command === '/brief') {
    const at = Date.now();
    const spoken = synthesizer !== null && voiceForBrief(user);
    const options = { news: await briefNews(news, user, at), weather: await briefWeather(weather, user, at), webSearch: config.webTools, spoken };
    await ask(briefRequest(store, user, at, options), spoken);
  } else if (command === '/listes') {
    const items = store.listOpenItems(userId);
    console.log(items.length === 0 ? '(aucune liste)\n' : items.map((i) => `[${i.id}] ${i.list} · ${i.text}`).join('\n') + '\n');
  } else if (command === '/exporter') {
    writeFileSync('./data/mes-donnees.json', JSON.stringify(buildExport(store, user, Date.now()), null, 2));
    console.log('Export : data/mes-donnees.json\n');
  } else if (command === '/usage') {
    console.log(`Aujourd'hui : ${budgetStatus(store, config, user, Date.now()).spentUsd.toFixed(4)} $\n`);
  } else if (command === '/fuseau' && args[0]) {
    if (isValidTimezone(args[0])) {
      applySettings(store, userId, { timezone: args[0] }, Date.now());
      console.log(`Fuseau : ${args[0]}\n`);
    } else {
      console.log(`Fuseau inconnu : ${args[0]} (ex : Europe/Paris)\n`);
    }
  } else if (command === '/connecter' && integrations) {
    const toolkit = args[0] as Toolkit;
    if (!TOOLKITS.includes(toolkit)) {
      const status = await integrations.connectionStatus(user);
      for (const t of TOOLKITS) store.setConnection(userId, t, status[t], Date.now());
      console.log(`${TOOLKITS.map((t) => `${status[t] ? '✅' : '⚪️'} ${TOOLKIT_LABELS[t]} (${t})`).join('\n')}\n→ /connecter gmail  ou  /connecter googlecalendar\n`);
    } else {
      const attempt = await integrations.connect(user, toolkit);
      console.log(`Ouvre ce lien pour autoriser ${TOOLKIT_LABELS[toolkit]} :\n${attempt.url}\n`);
      void attempt.completion.then((connected) => {
        if (!connected) return;
        store.setConnection(userId, toolkit, true, Date.now());
        process.stdout.write(`\n\n✅ ${TOOLKIT_LABELS[toolkit]} est connecté.\n\ntoi › `);
      });
    }
  } else if ((command === '/confirmer' || command === '/annuler') && integrations && args[0]) {
    const id = Number(args[0]);
    if (command === '/annuler') console.log(cancelAction(store, user, id, Date.now()) ? '❌ Annulé.\n' : 'Déjà traitée ou introuvable.\n');
    else console.log(`${(await locks.run(userId, () => confirmAction(store, integrations!, user, id, Date.now()))).message}\n`);
  } else if (browserTasks && ['/oui', '/non', '/fait'].includes(command!) && args[0]) {
    const answer = command === '/oui' ? 'yes' : command === '/fait' ? 'done' : 'no';
    console.log(browserTasks.answer(user, Number(args[0]), answer) ? 'Réponse transmise.\n' : 'Cette question a expiré ou a déjà reçu une réponse.\n');
  } else if (browserTasks && command === '/taches') {
    const tasks = store.listBrowserTasks(userId, 5);
    console.log(tasks.length === 0 ? '(aucune tâche)\n' : tasks.map((t) => `#${t.id} [${t.status}] ${t.goal}${t.result ? `\n   → ${t.result}` : ''}`).join('\n') + '\n');
  } else if (browserTasks && command === '/arreter' && args[0]) {
    console.log(browserTasks.cancel(user, Number(args[0])) ? 'Arrêt demandé.\n' : 'Tâche introuvable ou déjà terminée.\n');
  } else if (missions && command === '/missions') {
    const list = store.listMissions(userId, 10);
    console.log(
      list.length === 0
        ? '(aucune mission)\n'
        : list.map((m) => `#${m.id} [${m.status}] ${m.title} · ${m.runs} passage(s) · ${m.costUsd.toFixed(4)} $ / ${m.maxCostUsd} $`).join('\n') + '\n',
    );
  } else if (missions && command === '/arreter_mission' && args[0]) {
    console.log(missions.stop(user, Number(args[0]), Date.now()) ? 'Mission arrêtée.\n' : 'Mission introuvable ou déjà terminée.\n');
  } else if (missions && command === '/retenir' && args[0]) {
    const kept = missions.keepConclusion(user, Number(args[0]), Date.now());
    console.log(kept === 'kept' ? 'Gardé en mémoire.\n' : kept === 'full' ? 'Mémoire pleine.\n' : 'Rien à garder pour cette mission.\n');
  } else if (command === '/reset') {
    store.wipeUserData(userId);
    console.log('Mémoire et historique effacés.\n');
  } else {
    await ask({ userId, kind: 'chat', text: line });
  }
  prompt();
}

scheduler.stop();
browserTasks?.shutdown();
await integrations?.close();
if (!inputClosed) rl.close();
db.close();
