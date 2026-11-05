// Vérifie la configuration sans jamais afficher de secret : `npm run doctor`.
// Tous les appels sont gratuits : getMe / getWebhookInfo chez Telegram ; selon le fournisseur,
// comptage de tokens chez Anthropic, ou clé, crédits et catalogue de modèles chez OpenRouter.
import Anthropic from '@anthropic-ai/sdk';
import { DesktopAuth, createClient } from '@1password/sdk';
import { chromium } from 'playwright';
import { hasKnownPrice } from './agent/pricing.js';
import { launchWithFallback } from './browser/engine.js';
import { loadEnvFile, readConfig, type Config } from './config.js';
import { openDatabase } from './db.js';
import { ComposioIntegrations } from './integrations/composio.js';
import { OPENROUTER_BASE_URL } from './llm.js';
import { createNewsService } from './news.js';
import { checkSpeechModel, fetchSpeechCatalog, type VoiceSpec } from './speech.js';
import { Store } from './store.js';
import { silentLogger } from './util.js';

let failures = 0;
const ok = (message: string) => console.log(`✅ ${message}`);
const ko = (message: string) => {
  failures++;
  console.log(`❌ ${message}`);
};
const warn = (message: string) => console.log(`⚠️  ${message}`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

loadEnvFile();
let config: Config;
try {
  config = readConfig();
  ok(`Configuration valide (${config.model} via ${config.provider}, effort ${config.effort}, inscriptions : ${config.registrationMode})`);
} catch (err) {
  ko(errorText(err));
  process.exit(1);
}

/** GET JSON ; l'URL et les en-têtes (qui contiennent les secrets) ne sont jamais affichés. */
async function getJson<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; data?: T; description?: string; error?: { message?: string } };
  if (!response.ok || body.ok === false) {
    throw new Error(body.description ?? body.error?.message ?? `HTTP ${response.status}`);
  }
  return (body.result ?? body.data ?? body) as T;
}

async function checkTelegram(): Promise<void> {
  if (!config.telegramToken) return ko('TELEGRAM_BOT_TOKEN est vide dans .env');
  try {
    const api = `https://api.telegram.org/bot${config.telegramToken}`;
    const me = await getJson<{ username: string }>(`${api}/getMe`);
    ok(`Bot Telegram : @${me.username} (https://t.me/${me.username})`);
    const webhook = await getJson<{ url: string }>(`${api}/getWebhookInfo`);
    if (webhook.url) warn('Un webhook est configuré sur ce bot : Koto le supprimera au démarrage pour recevoir les messages.');
  } catch (err) {
    ko(`Telegram refuse le token : ${errorText(err)}`);
  }
}

async function checkOpenRouter(): Promise<void> {
  if (!config.openrouterApiKey) return ko('OPENROUTER_API_KEY est vide dans .env');
  try {
    const key = await getJson<{ limit: number | null; limit_remaining: number | null; is_free_tier?: boolean }>(
      `${OPENROUTER_BASE_URL}/v1/key`,
      config.openrouterApiKey,
    );
    ok('Clé OpenRouter valide');
    if (key.limit !== null && key.limit_remaining !== null) {
      (key.limit_remaining > 0 ? ok : ko)(`Plafond de la clé : ${key.limit_remaining.toFixed(2)} $ restants sur ${key.limit.toFixed(2)} $`);
    }
  } catch (err) {
    return ko(`OpenRouter refuse la clé : ${errorText(err)}`);
  }
  try {
    const credits = await getJson<{ total_credits: number; total_usage: number }>(`${OPENROUTER_BASE_URL}/v1/credits`, config.openrouterApiKey);
    const remaining = credits.total_credits - credits.total_usage;
    (remaining > 0 ? ok : ko)(`Crédits OpenRouter restants : ${remaining.toFixed(2)} $`);
  } catch (err) {
    warn(`Impossible de lire le solde de crédits OpenRouter (${errorText(err)}) : vérifie-le sur https://openrouter.ai/settings/credits`);
  }
  try {
    const models = await getJson<{ id: string }[]>(`${OPENROUTER_BASE_URL}/v1/models`);
    if (models.some((m) => m.id === config.model)) ok(`Modèle ${config.model} disponible sur OpenRouter`);
    else ko(`Modèle ${config.model} introuvable sur OpenRouter : vérifie KOTO_MODEL`);
    if (config.memoryConsolidation && config.memoryModel !== config.model) {
      if (models.some((m) => m.id === config.memoryModel)) ok(`Modèle du ménage de la mémoire ${config.memoryModel} disponible`);
      else ko(`Modèle ${config.memoryModel} introuvable sur OpenRouter : vérifie KOTO_MEMORY_MODEL`);
    }
  } catch (err) {
    warn(`Catalogue OpenRouter injoignable (${errorText(err)})`);
  }
}

async function checkAnthropic(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return ko('Aucune clé de modèle : remplis OPENROUTER_API_KEY ou ANTHROPIC_API_KEY dans .env');
  }
  try {
    const client = new Anthropic();
    const count = await client.messages.countTokens({ model: config.model, messages: [{ role: 'user', content: 'ping' }] });
    ok(`Clé Anthropic valide, ${config.model} accessible (test gratuit : ${count.input_tokens} tokens comptés)`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) ko('Clé API Anthropic refusée : vérifie ANTHROPIC_API_KEY');
    else if (err instanceof Anthropic.PermissionDeniedError) ko(`Cette clé n'a pas accès à ${config.model}`);
    else if (err instanceof Anthropic.NotFoundError) ko(`Modèle ${config.model} introuvable : vérifie KOTO_MODEL`);
    else if (err instanceof Anthropic.APIConnectionError) ko("Impossible de joindre l'API Anthropic (réseau)");
    else ko(`Appel Anthropic en échec : ${errorText(err)}`);
  }
}

async function checkComposio(): Promise<void> {
  if (!config.composioApiKey) {
    return warn('COMPOSIO_API_KEY vide : Gmail et Google Agenda désactivés (clé sur https://dashboard.composio.dev/~/project/settings/api-keys)');
  }
  try {
    // Base en mémoire : on ne charge que le catalogue d'outils, aucun compte n'est touché.
    const integrations = await ComposioIntegrations.create({
      apiKey: config.composioApiKey,
      store: new Store(openDatabase(':memory:')),
      log: silentLogger,
    });
    ok(`Composio : ${integrations.tools.length} outils Gmail et Google Agenda disponibles en MCP`);
    await integrations.close();
  } catch (err) {
    ko(`Composio refuse la clé ou est injoignable : ${errorText(err)}`);
  }
}

async function checkVoice(): Promise<void> {
  if (!config.voice) return warn('Vocaux désactivés (KOTO_VOICE=off)');
  if (!config.openrouterApiKey) return warn('Vocaux désactivés : la transcription passe par OpenRouter (OPENROUTER_API_KEY)');
  try {
    const models = await getJson<{ id: string; architecture?: { input_modalities?: string[] } }[]>(`${OPENROUTER_BASE_URL}/v1/models`);
    const model = models.find((m) => m.id === config.transcribeModel);
    if (!model) ko(`Modèle de transcription ${config.transcribeModel} introuvable sur OpenRouter (KOTO_TRANSCRIBE_MODEL)`);
    else if (!model.architecture?.input_modalities?.includes('audio')) ko(`${config.transcribeModel} n'accepte pas l'audio`);
    else ok(`Vocaux : transcription par ${config.transcribeModel}`);
  } catch (err) {
    warn(`Catalogue OpenRouter injoignable (${errorText(err)})`);
  }
}

async function checkSpeech(): Promise<void> {
  if (!config.speech) return warn('Réponses vocales désactivées (KOTO_TTS=off)');
  if (!config.openrouterApiKey) return warn('Réponses vocales désactivées : la synthèse passe par OpenRouter (OPENROUTER_API_KEY)');
  const voices: [string, VoiceSpec][] = [['voix principale', { model: config.speechModel, voice: config.speechVoice }]];
  if (config.speechFallbackModel) voices.push(['voix de secours', { model: config.speechFallbackModel, voice: config.speechFallbackVoice }]);
  try {
    const catalog = await fetchSpeechCatalog();
    const usable = voices.filter(([label, spec]) => {
      const check = checkSpeechModel(catalog, spec);
      if (!check.ok) {
        warn(`Réponses vocales, ${label} écartée : ${check.reason}`);
        return false;
      }
      const price = check.info.usdPerChar === 0 ? 'gratuite' : `${(check.info.usdPerChar * 1000).toFixed(4)} $ les 1 000 caractères`;
      ok(`Réponses vocales, ${label} : ${spec.model}${spec.voice ? ` (${spec.voice})` : ''}, ${price}`);
      return true;
    });
    if (usable.length === 0) ko('Réponses vocales : aucune voix utilisable (KOTO_TTS_MODEL, KOTO_TTS_FALLBACK_MODEL)');
  } catch (err) {
    warn(`Catalogue des voix OpenRouter injoignable (${errorText(err)})`);
  }
}

async function checkNews(): Promise<void> {
  // Flux crypto et cours CoinGecko : gratuits, sans clé.
  const digest = await createNewsService({ log: silentLogger }).digest('crypto', Date.now());
  const headlines = digest.text.split('\n').filter((line) => line.startsWith('- ')).length;
  if (headlines > 0 || digest.text.includes('Cours')) ok(`Veille du brief : flux gratuits joignables (${headlines} titres crypto récents, cours CoinGecko${digest.text.includes('Cours') ? '' : ' indisponibles'})`);
  else warn('Veille du brief : flux RSS injoignables pour le moment, le brief se rabattra sur la recherche web');
}

async function checkBrowser(): Promise<void> {
  if (!config.browser) return warn('Tâches web désactivées (KOTO_BROWSER=off)');
  if (config.browserHeaded && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    ko("KOTO_BROWSER_HEADED=on mais cette machine n'a pas d'écran : mets KOTO_BROWSER_HEADED=off sur un serveur");
  }
  try {
    const { result: browser, channel } = await launchWithFallback(config.browserChannel, (candidate) =>
      chromium.launch({ headless: true, ...(candidate ? { channel: candidate } : {}) }),
    );
    const version = browser.version();
    await browser.close();
    if (config.browserChannel && channel === null) {
      warn(`Navigateur « ${config.browserChannel} » introuvable : Koto utilisera le Chromium de Playwright (mets KOTO_BROWSER_CHANNEL=chromium)`);
    }
    ok(`Navigateur : ${channel ?? 'chromium'} ${version} (${config.browserHeaded ? 'fenêtre visible' : 'invisible'}), modèle ${config.browserModel}`);
  } catch (err) {
    ko(`Le navigateur ne démarre pas : ${errorText(err).split('\n')[0]} (installe Chrome, ou lance « npx playwright install --with-deps chromium »)`);
  }
}

/** Missions : rien à joindre, on rappelle seulement leurs limites (gratuit). */
function checkMissions(): void {
  if (!config.missions) return warn('Missions désactivées (KOTO_MISSIONS=off)');
  if (!hasKnownPrice(config.missionModel)) warn(`Pas de tarif connu pour ${config.missionModel} : le coût des missions sera estimé au tarif de claude-opus-5-5`);
  const hours = String(config.missionMinHours).replace('.', ',');
  ok(
    `Missions : modèle ${config.missionModel}, un passage toutes les ${hours} h au plus, plafonds ${config.missionRunMaxCostUsd} $ par passage et ${config.missionMaxCostUsd} $ par mission (par défaut)`,
  );
}

async function checkOnePassword(): Promise<void> {
  if (!config.onePasswordToken && !config.onePasswordAccount) return;
  if (config.onePasswordOwnerId === null) return ko('1Password configuré mais OP_OWNER_TELEGRAM_ID est vide');
  try {
    const client = await createClient({
      auth: config.onePasswordToken || new DesktopAuth(config.onePasswordAccount),
      integrationName: 'Koto',
      integrationVersion: '0.3.0',
    });
    const vaults = await client.vaults.list();
    ok(`1Password : ${vaults.length} coffre(s) accessible(s), réservé au compte Telegram ${config.onePasswordOwnerId}`);
  } catch (err) {
    ko(`1Password refuse l'accès : ${errorText(err)}`);
  }
}

await checkTelegram();
await (config.provider === 'openrouter' ? checkOpenRouter() : checkAnthropic());
await checkComposio();
await checkVoice();
await checkSpeech();
await checkNews();
await checkBrowser();
checkMissions();
await checkOnePassword();

if (config.adminTelegramIds.length > 0) ok(`Admins : ${config.adminTelegramIds.join(', ')}`);
else if (config.registrationMode === 'invite') {
  warn("ADMIN_TELEGRAM_IDS est vide : lance le bot et écris-lui, il te donnera ton identifiant Telegram à y mettre.");
}

console.log(failures === 0 ? '\nTout est prêt : npm run dev' : `\n${failures} problème(s) à corriger.`);
process.exit(failures === 0 ? 0 : 1);
