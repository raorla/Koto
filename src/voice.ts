// Transcription des messages vocaux Telegram via OpenRouter (modèle audio type Gemini Flash Lite).
// Ce n'est pas un appel à Claude : c'est un service de transcription, appelé en HTTP brut.

export const AUDIO_FORMATS = ['ogg', 'mp3', 'm4a', 'wav', 'aac', 'flac'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export interface Transcription {
  text: string;
  /** Coût réel renvoyé par OpenRouter (USD), 0 s'il n'est pas fourni. */
  costUsd: number;
}

export interface Transcriber {
  transcribe(audio: Buffer, format: AudioFormat): Promise<Transcription>;
}

export class TranscriptionError extends Error {}

/** Réponse quand le vocal ne contient pas de parole. */
export const SILENCE = '[silence]';

const PROMPT =
  "Transcris fidèlement ce message vocal, dans sa langue d'origine (français, malgache, anglais…). " +
  `Réponds uniquement avec la transcription, sans guillemets ni commentaire. S'il n'y a pas de parole, réponds exactement : ${SILENCE}`;

const MIME_TO_FORMAT: Record<string, AudioFormat> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

/** Format audio à partir du type MIME Telegram ; null si non pris en charge. Les vocaux sont en OGG/Opus. */
export function audioFormatFromMime(mime: string | undefined): AudioFormat | null {
  return MIME_TO_FORMAT[(mime ?? '').toLowerCase()] ?? null;
}

export function createOpenRouterTranscriber(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = 'https://openrouter.ai/api',
): Transcriber {
  return {
    async transcribe(audio, format) {
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Koto' },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                { type: 'input_audio', input_audio: { data: audio.toString('base64'), format } },
              ],
            },
          ],
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { cost?: unknown };
        error?: { message?: string };
      };
      if (!response.ok || body.error) throw new TranscriptionError(body.error?.message ?? `HTTP ${response.status}`);
      const content = body.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content.trim() : '';
      return { text, costUsd: typeof body.usage?.cost === 'number' ? body.usage.cost : 0 };
    },
  };
}
