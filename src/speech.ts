// Synthèse vocale via OpenRouter (/api/v1/audio/speech) : Koto peut répondre en message vocal.
// Comme la transcription (voice.ts), ce n'est pas un appel à Claude : HTTP brut vers un service audio.
// Par défaut, une voix gratuite (quota quotidien du compte OpenRouter), puis une voix quasi gratuite
// en secours : un vocal ne coûte presque rien.
import { FALLBACK_SPEECH_PRICING, speechCostUsd, type SpeechPricing } from './agent/pricing.js';
import type { Job, User } from './store.js';
import type { Logger } from './util.js';

/** Base de l'API OpenRouter (remplacée par un faux serveur dans les tests système). */
export const OPENROUTER_API = 'https://openrouter.ai/api';

/** Au-delà (environ 2 min 30 d'écoute), on coupe le vocal et on renvoie au message écrit. */
export const MAX_SPEECH_CHARS = 2_500;
const TRUNCATED_TAIL = ' La suite est dans le message écrit.';

export interface Speech {
  /** Audio MP3 : Telegram l'accepte tel quel comme message vocal. */
  audio: Buffer;
  /** Durée arrondie, affichée par Telegram sous le vocal. */
  seconds: number;
  /** Estimation (caractères × tarif du modèle) : OpenRouter ne renvoie pas le coût de la synthèse. */
  costUsd: number;
}

export interface Synthesizer {
  synthesize(text: string): Promise<Speech>;
}

export class SpeechError extends Error {}

// ------------------------------------------------------------------ quand parler

/** La réponse d'un tour de conversation part-elle aussi en vocal ? */
export function voiceForReply(user: Pick<User, 'voiceReplies'>, turn: { requested: boolean; spokenInput: boolean }): boolean {
  return turn.requested || user.voiceReplies === 'always' || (user.voiceReplies === 'mirror' && turn.spokenInput);
}

/** Le brief du matin part-il aussi en vocal ? */
export function voiceForBrief(user: Pick<User, 'voiceReplies' | 'briefVoice'>): boolean {
  return user.briefVoice || user.voiceReplies === 'always';
}

/** Un rappel ou une relance part-il aussi en vocal ? */
export function voiceForJob(user: Pick<User, 'voiceReplies'>, job: Pick<Job, 'voice'>): boolean {
  return job.voice || user.voiceReplies === 'always';
}

/** Le message d'une mission (résultat, question, bilan) part-il aussi en vocal ? */
export function voiceForMission(user: Pick<User, 'voiceReplies'>): boolean {
  return user.voiceReplies === 'always';
}

// ------------------------------------------------------------------ texte à lire

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/**
 * Texte écrit pour Telegram (petit Markdown, liens, émojis) → texte à lire à voix haute :
 * sans URL, sans balises ni émojis, une phrase par ligne. Coupé proprement au-delà de `maxChars`.
 */
export function toSpeechText(markdown: string, maxChars = MAX_SPEECH_CHARS): string {
  let s = markdown.replace(/\r\n/g, '\n');
  s = s.replace(/```[\s\S]*?```/g, '\n'); // un bloc de code ne se lit pas
  s = s.replace(/^\s*Sources?\s*:.*$/gim, ''); // sources web ajoutées en fin de réponse
  s = s.replace(/\[([^\]\n]+)\]\((?:https?:\/\/|mailto:)[^\s)]+\)/g, '$1');
  s = s.replace(/<?https?:\/\/[^\s>)]+>?/g, '');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(EMOJI, '');
  s = s.replace(/#(\d+)/g, '$1').replace(/\s*[→·]\s*/g, ', ');
  // Signes des variations (« −1,6 % », « +6 % ») : les voix les prononcent mal, on les écrit en toutes lettres.
  s = s.replace(/−\s?(?=\d)/g, 'moins ').replace(/(^|[\s(])-(?=\d)/g, '$1moins ').replace(/(^|[\s(])\+(?=\d)/g, '$1plus ');

  // Titres, puces et lignes sans ponctuation finale deviennent des phrases : la voix y marque une pause.
  const text = s
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .map((line) => (/[.!?…:;]$/.test(line) ? line : `${line}.`))
    .join(' ');
  if (text.length <= maxChars) return text;

  const room = maxChars - TRUNCATED_TAIL.length;
  const head = text.slice(0, room);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('… '));
  const cut = end > room / 2 ? end + 1 : head.lastIndexOf(' ');
  return `${head.slice(0, cut > 0 ? cut : room).trim()}${TRUNCATED_TAIL}`;
}

// ------------------------------------------------------------------ durée d'un MP3

const SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Durée d'un MP3 (MPEG 1, 2 ou 2.5, couche III) en secondes, en comptant ses trames ; NaN si illisible. */
export function mp3Duration(audio: Buffer): number {
  let i = 0;
  if (audio.subarray(0, 3).toString('latin1') === 'ID3' && audio.length >= 10) {
    i = 10 + ((audio[6]! & 0x7f) << 21) + ((audio[7]! & 0x7f) << 14) + ((audio[8]! & 0x7f) << 7) + (audio[9]! & 0x7f);
  }
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= audio.length) {
    const b1 = audio[i + 1]!;
    const b2 = audio[i + 2]!;
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = b2 >> 4;
    const rateIndex = (b2 >> 2) & 3;
    // Synchro sur 11 bits, couche III (01), version, débit et fréquence valides.
    if (audio[i] !== 0xff || (b1 & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      i++;
      continue;
    }
    const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
    const kbps = (version === 3 ? KBPS_V1 : KBPS_V2)[bitrateIndex]!;
    const samples = version === 3 ? 1152 : 576;
    seconds += samples / sampleRate;
    frames++;
    i += Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + ((b2 >> 1) & 1);
  }
  return frames > 0 ? seconds : NaN;
}

// ------------------------------------------------------------------ catalogue et synthèse

export interface SpeechModelInfo extends SpeechPricing {
  id: string;
  /** Voix proposées ; vide si le catalogue ne les liste pas. */
  voices: string[];
}

/** Modèles de synthèse d'OpenRouter, avec leur tarif et leurs voix (catalogue public, sans clé). */
export async function fetchSpeechCatalog(fetchImpl: typeof fetch = fetch, baseUrl = OPENROUTER_API): Promise<SpeechModelInfo[]> {
  const response = await fetchImpl(`${baseUrl}/v1/models?output_modalities=speech`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new SpeechError(`catalogue OpenRouter : HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { id?: unknown; pricing?: Record<string, unknown>; supported_voices?: unknown }[] };
  const price = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return (body.data ?? []).flatMap((entry) =>
    typeof entry.id === 'string'
      ? [
          {
            id: entry.id,
            usdPerChar: price(entry.pricing?.prompt),
            usdPerSecond: price(entry.pricing?.completion),
            voices: Array.isArray(entry.supported_voices) ? entry.supported_voices.filter((v): v is string => typeof v === 'string') : [],
          },
        ]
      : [],
  );
}

/** Une voix : un modèle de synthèse et, s'il en propose plusieurs, l'identifiant de la voix ('' = voix par défaut). */
export interface VoiceSpec {
  model: string;
  voice: string;
}

/** Le modèle et la voix existent-ils ? Sinon, une explication qui liste les voix françaises. */
export function checkSpeechModel(catalog: SpeechModelInfo[], spec: VoiceSpec): { ok: true; info: SpeechModelInfo } | { ok: false; reason: string } {
  const info = catalog.find((m) => m.id === spec.model);
  if (!info) return { ok: false, reason: `modèle de synthèse « ${spec.model} » introuvable sur OpenRouter` };
  if (info.voices.length > 0 && !info.voices.includes(spec.voice)) {
    const french = info.voices.filter((v) => /^(fr[-_]|ff_)/i.test(v));
    return {
      ok: false,
      reason: `${spec.voice ? `voix « ${spec.voice} » inconnue` : 'il faut choisir une voix'} pour ${spec.model}${french.length > 0 ? ` (voix françaises : ${french.join(', ')})` : ''}`,
    };
  }
  return { ok: true, info };
}

export function createOpenRouterSynthesizer(
  options: VoiceSpec & { apiKey: string; pricing: SpeechPricing; fetchImpl?: typeof fetch; baseUrl?: string },
): Synthesizer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl ?? OPENROUTER_API}/v1/audio/speech`;
  return {
    async synthesize(text) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Koto' },
        body: JSON.stringify({ model: options.model, input: text, ...(options.voice ? { voice: options.voice } : {}), response_format: 'mp3' }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        // Les erreurs arrivent en JSON, l'audio en binaire.
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new SpeechError(body.error?.message ?? `HTTP ${response.status}`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      const duration = mp3Duration(audio);
      if (!(duration > 0)) throw new SpeechError('audio vide ou illisible');
      return { audio, seconds: Math.max(1, Math.round(duration)), costUsd: speechCostUsd(text.length, duration, options.pricing) };
    },
  };
}

const PRIMARY_COOLDOWN_MS = 10 * 60_000;

/**
 * Voix principale d'abord (gratuite, mais plafonnée chaque jour), voix de secours sinon.
 * Après un échec (quota atteint, modèle indisponible), la principale est laissée de côté 10 minutes.
 */
export function withFallback(primary: Synthesizer, fallback: Synthesizer, options: { log: Logger; now?: () => number }): Synthesizer {
  const now = options.now ?? Date.now;
  let primaryPausedUntil = 0;
  return {
    async synthesize(text) {
      if (now() >= primaryPausedUntil) {
        try {
          return await primary.synthesize(text);
        } catch (err) {
          primaryPausedUntil = now() + PRIMARY_COOLDOWN_MS;
          options.log.warn('voix principale indisponible : voix de secours pendant 10 min', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return fallback.synthesize(text);
    },
  };
}

/**
 * Synthèse prête à l'emploi : vérifie chaque voix dans le catalogue (et y prend son vrai tarif).
 * Une voix mal configurée est écartée si l'autre fonctionne ; lève si aucune n'est utilisable.
 * Catalogue injoignable : on garde les deux voix, au tarif de repli (jamais sous-estimé).
 */
export async function setupSynthesizer(options: {
  apiKey: string;
  primary: VoiceSpec;
  fallback: VoiceSpec | null;
  log: Logger;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<{ synthesizer: Synthesizer; voices: VoiceSpec[] }> {
  let catalog: SpeechModelInfo[] | null = null;
  try {
    catalog = await fetchSpeechCatalog(options.fetchImpl, options.baseUrl);
  } catch (err) {
    options.log.warn('catalogue des voix OpenRouter injoignable : coût des vocaux estimé au tarif de repli', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const usable: { spec: VoiceSpec; synthesizer: Synthesizer }[] = [];
  const problems: string[] = [];
  for (const spec of [options.primary, options.fallback]) {
    if (!spec) continue;
    let pricing: SpeechPricing = FALLBACK_SPEECH_PRICING;
    if (catalog) {
      const check = checkSpeechModel(catalog, spec);
      if (!check.ok) {
        problems.push(check.reason);
        continue;
      }
      pricing = check.info;
    }
    usable.push({
      spec,
      synthesizer: createOpenRouterSynthesizer({ ...spec, apiKey: options.apiKey, pricing, fetchImpl: options.fetchImpl, baseUrl: options.baseUrl }),
    });
  }
  if (usable.length === 0) throw new SpeechError(problems.join(' ; ') || 'aucune voix configurée');
  for (const problem of problems) options.log.warn(`voix écartée : ${problem}`);
  const [first, second] = usable;
  return {
    synthesizer: second ? withFallback(first!.synthesizer, second.synthesizer, { log: options.log }) : first!.synthesizer,
    voices: usable.map((u) => u.spec),
  };
}
