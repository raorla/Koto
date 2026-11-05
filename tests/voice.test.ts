import { describe, expect, it } from 'vitest';
import { TranscriptionError, audioFormatFromMime, createOpenRouterTranscriber } from '../src/voice.js';

function fakeFetch(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

describe('transcription des vocaux', () => {
  it('envoie le vocal en base64 à OpenRouter et lit la transcription et son coût', async () => {
    const fetch = fakeFetch(200, { choices: [{ message: { content: ' Rappelle-moi de payer la JIRAMA. ' } }], usage: { cost: 0.0004 } });
    const transcriber = createOpenRouterTranscriber('sk-or-test', 'google/gemini-2.5-flash-lite', fetch.impl);

    const result = await transcriber.transcribe(Buffer.from('OggS-fake-audio'), 'ogg');

    expect(result).toEqual({ text: 'Rappelle-moi de payer la JIRAMA.', costUsd: 0.0004 });
    const [request] = fetch.requests;
    expect(request!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((request!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
    const body = JSON.parse(String(request!.init.body));
    expect(body.model).toBe('google/gemini-2.5-flash-lite');
    expect(body.messages[0].content[1]).toEqual({
      type: 'input_audio',
      input_audio: { data: Buffer.from('OggS-fake-audio').toString('base64'), format: 'ogg' },
    });
  });

  it("remonte l'erreur du fournisseur", async () => {
    const fetch = fakeFetch(400, { error: { message: 'unsupported audio format' } });
    const transcriber = createOpenRouterTranscriber('sk-or-test', 'model', fetch.impl);
    await expect(transcriber.transcribe(Buffer.from('x'), 'ogg')).rejects.toBeInstanceOf(TranscriptionError);
  });

  it('reconnaît les formats Telegram', () => {
    expect(audioFormatFromMime('audio/ogg')).toBe('ogg');
    expect(audioFormatFromMime('audio/mpeg')).toBe('mp3');
    expect(audioFormatFromMime('audio/x-m4a')).toBe('m4a');
    expect(audioFormatFromMime('video/mp4')).toBeNull();
  });
});
