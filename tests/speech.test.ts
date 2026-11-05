import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SPEECH_CHARS,
  SpeechError,
  checkSpeechModel,
  createOpenRouterSynthesizer,
  mp3Duration,
  setupSynthesizer,
  toSpeechText,
  voiceForBrief,
  voiceForJob,
  voiceForReply,
  withFallback,
  type Synthesizer,
} from '../src/speech.js';
import { silentLogger } from '../src/util.js';

/** MP3 factice : `frames` trames MPEG-1 couche III à 128 kb/s, 44,1 kHz (417 octets, 1 152 échantillons chacune). */
function fakeMp3(frames: number, id3 = false): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  const tag = id3 ? Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]) : Buffer.alloc(0);
  return Buffer.concat([tag, ...Array.from({ length: frames }, () => frame)]);
}

function audioResponse(audio: Buffer): Response {
  return new Response(new Uint8Array(audio), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

describe('texte lu à voix haute', () => {
  it('retire la mise en forme, les liens, les sources et les émojis', () => {
    const spoken = toSpeechText(
      "☀️ **Bonjour Ana !** Ton point du matin :\n- Appel avec Rado à _10 h_\n- Relire le [devis](https://exemple.com/devis) 📄\n\n`npm test` passe → https://ci.exemple.com/42\n\nSources : [CoinDesk](https://coindesk.com) · [Cryptoast](https://cryptoast.fr)",
    );
    expect(spoken).toBe('Bonjour Ana ! Ton point du matin : Appel avec Rado à 10 h. Relire le devis. npm test passe.');
  });

  it('écrit les signes des variations en toutes lettres, sans toucher aux plages horaires', () => {
    expect(toSpeechText('Bitcoin à 81 900 $ (−1,6 % en 24 h), RLC +6 %, ETH -3 %. Réunion 10-12 h.')).toBe(
      'Bitcoin à 81 900 $ (moins 1,6 % en 24 h), RLC plus 6 %, ETH moins 3 %. Réunion 10-12 h.',
    );
  });

  it('ne lit rien quand il n’y a que des émojis', () => {
    expect(toSpeechText('👍')).toBe('');
  });

  it('coupe un texte trop long à la fin d’une phrase et renvoie au message écrit', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Phrase numéro ${i} assez longue pour remplir le vocal.`).join(' ');
    const spoken = toSpeechText(long);
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(spoken).toMatch(/vocal\. La suite est dans le message écrit\.$/);
  });
});

describe('durée d’un MP3', () => {
  it('compte les trames, avec ou sans étiquette ID3', () => {
    expect(mp3Duration(fakeMp3(100))).toBeCloseTo((100 * 1152) / 44100, 3);
    expect(mp3Duration(fakeMp3(10, true))).toBeCloseTo((10 * 1152) / 44100, 3);
    expect(mp3Duration(Buffer.from('pas du tout un mp3'))).toBeNaN();
  });
});

describe('quand Koto parle', () => {
  it('suit le réglage de la personne, une demande ponctuelle, le brief et les rappels vocaux', () => {
    expect(voiceForReply({ voiceReplies: 'mirror' }, { requested: false, spokenInput: true })).toBe(true);
    expect(voiceForReply({ voiceReplies: 'mirror' }, { requested: false, spokenInput: false })).toBe(false);
    expect(voiceForReply({ voiceReplies: 'off' }, { requested: true, spokenInput: false })).toBe(true);
    expect(voiceForReply({ voiceReplies: 'off' }, { requested: false, spokenInput: true })).toBe(false);
    expect(voiceForReply({ voiceReplies: 'always' }, { requested: false, spokenInput: false })).toBe(true);
    expect(voiceForBrief({ voiceReplies: 'mirror', briefVoice: true })).toBe(true);
    expect(voiceForBrief({ voiceReplies: 'mirror', briefVoice: false })).toBe(false);
    expect(voiceForJob({ voiceReplies: 'off' }, { voice: true })).toBe(true);
    expect(voiceForJob({ voiceReplies: 'mirror' }, { voice: false })).toBe(false);
  });
});

describe('synthèse via OpenRouter', () => {
  it('demande un MP3, omet la voix par défaut et estime le coût au caractère', async () => {
    const fetchImpl = vi.fn(async () => audioResponse(fakeMp3(200)));
    const synthesizer = createOpenRouterSynthesizer({
      apiKey: 'sk-or-test',
      model: 'hexgrad/kokoro-82m',
      voice: '',
      pricing: { usdPerChar: 0.00000062, usdPerSecond: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const speech = await synthesizer.synthesize('Bonjour Ana');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'hexgrad/kokoro-82m', input: 'Bonjour Ana', response_format: 'mp3' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
    expect(speech.seconds).toBe(5);
    expect(speech.costUsd).toBeCloseTo(11 * 0.00000062, 10);
  });

  it('remonte le message d’erreur d’OpenRouter', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } }), { status: 429 });
    const synthesizer = createOpenRouterSynthesizer({ apiKey: 'k', model: 'm', voice: 'v', pricing: { usdPerChar: 0, usdPerSecond: 0 }, fetchImpl });
    await expect(synthesizer.synthesize('x')).rejects.toThrow(new SpeechError('Rate limit exceeded: free-models-per-day'));
  });

  it('passe à la voix de secours quand la gratuite échoue, puis la laisse de côté 10 minutes', async () => {
    let now = 0;
    const primary: Synthesizer = { synthesize: vi.fn(async () => Promise.reject(new SpeechError('quota'))) };
    const fallback: Synthesizer = { synthesize: vi.fn(async () => ({ audio: Buffer.alloc(1), seconds: 1, costUsd: 0.0001 })) };
    const synthesizer = withFallback(primary, fallback, { log: silentLogger, now: () => now });

    await synthesizer.synthesize('un');
    await synthesizer.synthesize('deux');
    now = 11 * 60_000;
    await synthesizer.synthesize('trois');

    expect(primary.synthesize).toHaveBeenCalledTimes(2);
    expect(fallback.synthesize).toHaveBeenCalledTimes(3);
  });

  it('vérifie modèle et voix dans le catalogue, en citant les voix françaises', () => {
    const catalog = [
      { id: 'fish-audio/s2.1-pro-free:free', usdPerChar: 0, usdPerSecond: 0, voices: [] },
      { id: 'hexgrad/kokoro-82m', usdPerChar: 0.00000062, usdPerSecond: 0, voices: ['af_heart', 'ff_siwis'] },
    ];
    expect(checkSpeechModel(catalog, { model: 'fish-audio/s2.1-pro-free:free', voice: '' }).ok).toBe(true);
    expect(checkSpeechModel(catalog, { model: 'hexgrad/kokoro-82m', voice: 'ff_siwis' }).ok).toBe(true);
    expect(checkSpeechModel(catalog, { model: 'hexgrad/kokoro-82m', voice: '' })).toMatchObject({ ok: false, reason: expect.stringContaining('ff_siwis') });
    expect(checkSpeechModel(catalog, { model: 'inconnu/tts', voice: '' })).toMatchObject({ ok: false, reason: expect.stringContaining('introuvable') });
  });

  it('écarte une voix mal configurée tant que l’autre fonctionne', async () => {
    const catalog = { data: [{ id: 'fish-audio/s2.1-pro-free:free', pricing: { prompt: '0', completion: '0' }, supported_voices: null }] };
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).includes('/models') ? new Response(JSON.stringify(catalog)) : audioResponse(fakeMp3(50));
    const warnings: string[] = [];
    const log = { ...silentLogger, warn: (message: string) => void warnings.push(message) };

    const { synthesizer, voices } = await setupSynthesizer({
      apiKey: 'k',
      primary: { model: 'fish-audio/s2.1-pro-free:free', voice: '' },
      fallback: { model: 'hexgrad/kokoro-82m', voice: 'ff_siwis' },
      log,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(voices.map((v) => v.model)).toEqual(['fish-audio/s2.1-pro-free:free']);
    expect(warnings[0]).toContain('kokoro');
    expect((await synthesizer.synthesize('Salut')).costUsd).toBe(0);
  });
});
