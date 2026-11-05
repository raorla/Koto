import { z } from 'zod';
import { cheapestModel } from './agent/pricing.js';
import { canonicalModel, openRouterModel } from './models.js';
import { isValidTimezone } from './time.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Où partent les appels au modèle : API Anthropic directe, ou OpenRouter (même SDK, même format). */
export const PROVIDERS = ['anthropic', 'openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type RegistrationMode = 'invite' | 'open' | 'closed';

export interface Config {
  telegramToken: string;
  provider: Provider;
  openrouterApiKey: string;
  /** Id du modèle au format du fournisseur choisi. */
  model: string;
  effort: Effort;
  webTools: boolean;
  /** Clé Composio : vide = Gmail et Google Agenda désactivés. */
  composioApiKey: string;
  /** Transcription des messages vocaux (nécessite une clé OpenRouter). */
  voice: boolean;
  transcribeModel: string;
  /** Réponses en message vocal : synthèse via OpenRouter (nécessite une clé OpenRouter). */
  speech: boolean;
  /** Voix principale ('' = voix par défaut du modèle). */
  speechModel: string;
  speechVoice: string;
  /** Voix de secours quand la principale échoue (quota du modèle gratuit atteint) ; null = aucune. */
  speechFallbackModel: string | null;
  speechFallbackVoice: string;
  /** Tâches dans un vrai navigateur (Playwright). */
  browser: boolean;
  /** Fenêtre visible : le propriétaire peut prendre la main (connexion, CAPTCHA). */
  browserHeaded: boolean;
  /** « chrome » = Chrome installé ; null = Chromium de Playwright. */
  browserChannel: string | null;
  browserModel: string;
  browserMaxSteps: number;
  browserMaxCostUsd: number;
  /** 1Password : jeton de compte de service, ou nom du compte de l'appli de bureau. */
  onePasswordToken: string;
  onePasswordAccount: string;
  /** Seule personne autorisée à utiliser 1Password (le propriétaire du bot). */
  onePasswordOwnerId: number | null;
  /** Missions : des objectifs suivis en arrière-plan pendant plusieurs jours. */
  missions: boolean;
  /** Modèle des passages de mission, au format du fournisseur choisi. */
  missionModel: string;
  /** Heures minimum entre deux passages d'une même mission. */
  missionMinHours: number;
  /** Plafond de coût d'une mission quand la personne n'en donne pas. */
  missionMaxCostUsd: number;
  /** Plafond de coût d'un passage. */
  missionRunMaxCostUsd: number;
  /** Ménage de la mémoire (fusions, archives) lancé par le scheduler. */
  memoryConsolidation: boolean;
  /** Modèle du ménage, au format du fournisseur choisi : le moins cher par défaut. */
  memoryModel: string;
  adminTelegramIds: number[];
  registrationMode: RegistrationMode;
  invitesPerUser: number;
  dailyBudgetUsd: number;
  defaultTimezone: string;
  defaultBriefTime: string;
  databasePath: string;
  /** Sauvegardes quotidiennes gardées dans data/backups (0 = aucune). */
  backupKeep: number;
  /** Adresses des services : à ne changer que pour les tests système (faux serveurs locaux). */
  telegramApiRoot: string;
  openrouterBaseUrl: string;
  /** Intervalle du scheduler (rappels, briefs). */
  schedulerIntervalMs: number;
  /** Adresse HTTPS publique du serveur d'appel (mini-app Telegram) ; null = appels désactivés. */
  publicUrl: string | null;
  callPort: number;
  callHost: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  LLM_PROVIDER: z.enum(PROVIDERS).optional(),
  OPENROUTER_API_KEY: z.string().default(''),
  KOTO_MODEL: z.string().min(1).default('claude-opus-5-5'),
  KOTO_EFFORT: z.enum(EFFORTS).default('low'),
  KOTO_WEB: z.enum(['on', 'off']).default('on'),
  COMPOSIO_API_KEY: z.string().default(''),
  KOTO_VOICE: z.enum(['on', 'off']).default('on'),
  KOTO_TRANSCRIBE_MODEL: z.string().min(1).default('google/gemini-2.5-flash-lite'),
  KOTO_TTS: z.enum(['on', 'off']).default('on'),
  KOTO_TTS_MODEL: z.string().min(1).default('fish-audio/s2.1-pro-free:free'),
  KOTO_TTS_VOICE: z.string().default(''),
  KOTO_TTS_FALLBACK_MODEL: z.string().min(1).default('hexgrad/kokoro-82m'),
  KOTO_TTS_FALLBACK_VOICE: z.string().default('ff_siwis'),
  KOTO_BROWSER: z.enum(['on', 'off']).default('on'),
  KOTO_BROWSER_HEADED: z.enum(['on', 'off']).default('off'),
  KOTO_BROWSER_CHANNEL: z.string().default('chrome'),
  KOTO_BROWSER_MODEL: z.string().optional(),
  KOTO_BROWSER_MAX_STEPS: z.coerce.number().int().min(5).max(200).default(40),
  KOTO_BROWSER_MAX_COST_USD: z.coerce.number().min(0.01).default(0.3),
  OP_SERVICE_ACCOUNT_TOKEN: z.string().default(''),
  OP_ACCOUNT: z.string().default(''),
  OP_OWNER_TELEGRAM_ID: z.coerce.number().int().optional(),
  KOTO_MISSIONS: z.enum(['on', 'off']).default('on'),
  KOTO_MISSION_MODEL: z.string().optional(),
  // Pas plus d'un passage par heure par défaut : chaque passage coûte.
  KOTO_MISSION_MIN_HOURS: z.coerce.number().min(0.25).max(168).default(1),
  // 2 $ au plus : c'est aussi le plafond le plus haut qu'une mission puisse demander (MISSION_LIMITS).
  KOTO_MISSION_MAX_COST_USD: z.coerce.number().min(0.01).max(2).default(0.25),
  KOTO_MISSION_RUN_MAX_COST_USD: z.coerce.number().min(0.005).max(1).default(0.05),
  KOTO_MEMORY_CONSOLIDATION: z.enum(['on', 'off']).default('on'),
  KOTO_MEMORY_MODEL: z.string().optional(),
  ADMIN_TELEGRAM_IDS: z.string().default(''),
  REGISTRATION_MODE: z.enum(['invite', 'open', 'closed']).default('invite'),
  INVITES_PER_USER: z.coerce.number().int().min(0).default(3),
  DAILY_BUDGET_USD: z.coerce.number().min(0).default(0.5),
  DEFAULT_TIMEZONE: z.string().default('Indian/Antananarivo'),
  DEFAULT_BRIEF_TIME: z.string().regex(HHMM, 'format HH:MM attendu').default('07:30'),
  DATABASE_PATH: z.string().min(1).default('./data/koto.db'),
  KOTO_BACKUP_KEEP: z.coerce.number().int().min(0).max(365).default(14),
  TELEGRAM_API_ROOT: z.string().url().default('https://api.telegram.org'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api'),
  KOTO_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(100).default(20_000),
  KOTO_PUBLIC_URL: z.string().url().optional(),
  KOTO_CALL_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  KOTO_CALL_HOST: z.string().min(1).default('127.0.0.1'),
});

/** Charge `.env` s'il existe (Node >= 20.12), sans dépendance externe. */
export function loadEnvFile(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Pas de fichier .env : on lit l'environnement tel quel.
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Les variables vides (ex: "KOTO_MODEL=") comptent comme absentes.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuration invalide — ${details}`);
  }
  const e = parsed.data;

  const adminTelegramIds = e.ADMIN_TELEGRAM_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const id = Number(s);
      if (!Number.isSafeInteger(id)) throw new Error(`ADMIN_TELEGRAM_IDS : "${s}" n'est pas un identifiant Telegram`);
      return id;
    });

  if (e.KOTO_MODEL.endsWith(':batch')) {
    throw new Error(
      `KOTO_MODEL : la variante « :batch » est réservée à l'API Batch (réponses différées) et refusée en direct — utilise ${e.KOTO_MODEL.replace(/:batch$/, '')}`,
    );
  }

  if (!isValidTimezone(e.DEFAULT_TIMEZONE)) {
    throw new Error(`DEFAULT_TIMEZONE : fuseau inconnu "${e.DEFAULT_TIMEZONE}" (ex: Indian/Antananarivo, Europe/Paris)`);
  }

  // Sans LLM_PROVIDER explicite, une clé OpenRouter suffit à passer par OpenRouter.
  const provider: Provider = e.LLM_PROVIDER ?? (e.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic');

  return {
    telegramToken: e.TELEGRAM_BOT_TOKEN,
    provider,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    // KOTO_MODEL peut s'écrire dans l'un ou l'autre format : on le convertit pour le fournisseur choisi.
    model: provider === 'openrouter' ? openRouterModel(e.KOTO_MODEL) : canonicalModel(e.KOTO_MODEL),
    effort: e.KOTO_EFFORT,
    webTools: e.KOTO_WEB === 'on',
    composioApiKey: e.COMPOSIO_API_KEY,
    voice: e.KOTO_VOICE === 'on',
    transcribeModel: e.KOTO_TRANSCRIBE_MODEL,
    speech: e.KOTO_TTS === 'on',
    speechModel: e.KOTO_TTS_MODEL,
    speechVoice: e.KOTO_TTS_VOICE,
    speechFallbackModel: e.KOTO_TTS_FALLBACK_MODEL === 'off' ? null : e.KOTO_TTS_FALLBACK_MODEL,
    speechFallbackVoice: e.KOTO_TTS_FALLBACK_VOICE,
    browser: e.KOTO_BROWSER === 'on',
    browserHeaded: e.KOTO_BROWSER_HEADED === 'on',
    browserChannel: e.KOTO_BROWSER_CHANNEL === 'chromium' ? null : e.KOTO_BROWSER_CHANNEL,
    browserModel: provider === 'openrouter'
      ? openRouterModel(e.KOTO_BROWSER_MODEL ?? e.KOTO_MODEL)
      : canonicalModel(e.KOTO_BROWSER_MODEL ?? e.KOTO_MODEL),
    browserMaxSteps: e.KOTO_BROWSER_MAX_STEPS,
    browserMaxCostUsd: e.KOTO_BROWSER_MAX_COST_USD,
    onePasswordToken: e.OP_SERVICE_ACCOUNT_TOKEN,
    onePasswordAccount: e.OP_ACCOUNT,
    onePasswordOwnerId: e.OP_OWNER_TELEGRAM_ID ?? null,
    missions: e.KOTO_MISSIONS === 'on',
    missionModel: provider === 'openrouter'
      ? openRouterModel(e.KOTO_MISSION_MODEL ?? e.KOTO_MODEL)
      : canonicalModel(e.KOTO_MISSION_MODEL ?? e.KOTO_MODEL),
    missionMinHours: e.KOTO_MISSION_MIN_HOURS,
    missionMaxCostUsd: e.KOTO_MISSION_MAX_COST_USD,
    missionRunMaxCostUsd: e.KOTO_MISSION_RUN_MAX_COST_USD,
    memoryConsolidation: e.KOTO_MEMORY_CONSOLIDATION === 'on',
    // Ranger une mémoire est une tâche simple : le modèle connu le moins cher suffit (Haiku), quel que soit KOTO_MODEL.
    memoryModel: provider === 'openrouter'
      ? openRouterModel(e.KOTO_MEMORY_MODEL ?? cheapestModel())
      : canonicalModel(e.KOTO_MEMORY_MODEL ?? cheapestModel()),
    adminTelegramIds,
    registrationMode: e.REGISTRATION_MODE,
    invitesPerUser: e.INVITES_PER_USER,
    dailyBudgetUsd: e.DAILY_BUDGET_USD,
    defaultTimezone: e.DEFAULT_TIMEZONE,
    defaultBriefTime: e.DEFAULT_BRIEF_TIME,
    databasePath: e.DATABASE_PATH,
    backupKeep: e.KOTO_BACKUP_KEEP,
    telegramApiRoot: e.TELEGRAM_API_ROOT.replace(/\/+$/, ''),
    openrouterBaseUrl: e.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
    schedulerIntervalMs: e.KOTO_SCHEDULER_INTERVAL_MS,
    publicUrl: e.KOTO_PUBLIC_URL ? publicUrl(e.KOTO_PUBLIC_URL) : null,
    callPort: e.KOTO_CALL_PORT,
    callHost: e.KOTO_CALL_HOST,
  };
}

/** Telegram n'ouvre une mini-app qu'en HTTPS ; http n'est accepté qu'en local (tests). */
function publicUrl(raw: string): string {
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`KOTO_PUBLIC_URL doit commencer par https:// (Telegram n'ouvre pas les mini-apps en http) : « ${raw} »`);
  }
  return raw.replace(/\/+$/, '');
}
