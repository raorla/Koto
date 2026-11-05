// La vraie page d'appel dans un vrai Chrome, micro simulé par un fichier WAV : détection de la voix,
// envoi de la phrase en WAV 16 kHz signé par Telegram, réponse lue, raccrochage.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import { signInitData } from '../src/call/auth.js';
import { startCallServer, type RunningCallServer } from '../src/call/server.js';
import { emptyUsage } from '../src/store.js';
import { KeyedLock, silentLogger } from '../src/util.js';
import type { AudioFormat } from '../src/voice.js';
import { makeConfig, makeStore, makeUser } from './helpers.js';
import { makeWav } from './support/wav.js';

const TOKEN = '123456:TEST-appel-chrome';
const dir = mkdtempSync(join(tmpdir(), 'koto-appel-'));
const micFile = join(dir, 'micro.wav');
// Ce que « dit » le micro, en boucle : un silence, une phrase d'environ une seconde, un long silence.
writeFileSync(micFile, makeWav([{ seconds: 0.8, voice: false }, { seconds: 1.2, voice: true }, { seconds: 3, voice: false }], 48_000));

let browser: Browser | null = null;
let server: RunningCallServer | null = null;
const heard: Buffer[] = [];
const telegram = { confirm: vi.fn(async () => {}), send: vi.fn(async (_chatId: number, _text: string) => {}) };

beforeAll(async () => {
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`],
    });
  } catch {
    browser = null; // Chrome absent : le test est sauté
    return;
  }
  const store = makeStore();
  makeUser(store, { telegramId: 5000 });
  const agent: Agent = async () => ({ text: 'Il est 10 h.', status: 'ok', usage: emptyUsage(), pendingActions: [] });
  server = await startCallServer(
    {
      config: makeConfig({ telegramToken: TOKEN }),
      store,
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      transcriber: {
        transcribe: async (audio: Buffer, _format: AudioFormat) => {
          heard.push(audio);
          return { text: 'Quelle heure est-il ?', costUsd: 0 };
        },
      },
      // Un WAV court : Chrome le décode comme le MP3 de la vraie voix.
      synthesizer: { synthesize: async () => ({ audio: makeWav([{ seconds: 0.4, voice: true }]), seconds: 1, costUsd: 0 }) },
      telegram,
    },
    { port: 0, host: '127.0.0.1' },
  );
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('page d’appel dans Chrome', () => {
  it('écoute, envoie la phrase, joue la réponse, puis raccroche', async (context) => {
    if (!browser || !server) return context.skip();
    const page = await browser.newPage();
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 5000, first_name: 'Ana' }) }, TOKEN);
    // Le SDK Telegram est remplacé par un bouchon qui fournit l'initData signée.
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)}, ready() {}, expand() {}, HapticFeedback: { impactOccurred() {} } } };`,
      }),
    );
    await page.goto(`http://127.0.0.1:${server.port}/appel`);

    await page.click('#call');
    await page.locator('#log .me', { hasText: 'Quelle heure est-il ?' }).first().waitFor({ timeout: 20_000 });
    await page.locator('#log .koto', { hasText: 'Il est 10 h.' }).first().waitFor({ timeout: 10_000 });

    // La phrase est arrivée en WAV mono 16 kHz, d'une durée plausible.
    const wav = heard[0]!;
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    const seconds = (wav.length - 44) / 2 / 16_000;
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(5);

    await page.click('#hangup');
    await expect.poll(() => telegram.send.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(telegram.send.mock.calls[0]![1]).toMatch(/^📞 Appel terminé : \d+ échanges?, environ \d+ min\.$/);
    expect(await page.locator('#status').textContent()).toBe('Appel terminé.');
  }, 60_000);
});
