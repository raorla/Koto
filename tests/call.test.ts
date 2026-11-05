import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, TurnRequest } from '../src/agent/agent.js';
import { signInitData, verifyInitData } from '../src/call/auth.js';
import { MAX_TURN_BYTES, startCallServer, type CallDeps, type RunningCallServer } from '../src/call/server.js';
import { emptyUsage, type PendingAction } from '../src/store.js';
import { KeyedLock, silentLogger } from '../src/util.js';
import { NOW, makeConfig, makeStore, makeUser } from './helpers.js';
import { makeWav } from './support/wav.js';

const TOKEN = '123456:TEST-appel';
const initData = (telegramId: number, authDate = Math.floor(NOW / 1000)) =>
  signInitData({ auth_date: String(authDate), query_id: 'q1', user: JSON.stringify({ id: telegramId, first_name: 'Ana' }) }, TOKEN);

describe('signature Telegram de la mini-app', () => {
  it('accepte une initData signée et récente, refuse le reste', () => {
    expect(verifyInitData(initData(5000), TOKEN, NOW)).toEqual({ id: 5000, firstName: 'Ana', username: null, languageCode: null });
    expect(verifyInitData(initData(5000), '999:autre-bot', NOW)).toBeNull();
    expect(verifyInitData(initData(5000).replace('5000', '6000'), TOKEN, NOW)).toBeNull();
    expect(verifyInitData(initData(5000, Math.floor(NOW / 1000) - 2 * 86_400), TOKEN, NOW)).toBeNull();
    expect(verifyInitData('', TOKEN, NOW)).toBeNull();
  });
});

describe('serveur d’appel', () => {
  let running: RunningCallServer | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  async function setup(options: { agentText?: string; pending?: PendingAction[]; transcript?: string; synthesize?: () => Promise<never> } = {}) {
    const store = makeStore();
    const user = makeUser(store, { telegramId: 5000 });
    const requests: TurnRequest[] = [];
    const agent: Agent = async (request) => {
      requests.push(request);
      return { text: options.agentText ?? '**Il est** 10 h.', status: 'ok', usage: { ...emptyUsage(), costUsd: 0.001 }, pendingActions: options.pending ?? [] };
    };
    const transcriber = { transcribe: vi.fn(async () => ({ text: options.transcript ?? 'Quelle heure est-il ?', costUsd: 0.0001 })) };
    const synthesizer = { synthesize: vi.fn(options.synthesize ?? (async () => ({ audio: Buffer.from('ID3-son'), seconds: 2, costUsd: 0 }))) };
    const telegram = { confirm: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    const deps: CallDeps = {
      config: makeConfig({ telegramToken: TOKEN }),
      store,
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      transcriber,
      synthesizer,
      telegram,
      now: () => NOW,
    };
    running = await startCallServer(deps, { port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${running.port}`;
    const say = (body: Buffer, auth = initData(5000)) =>
      fetch(`${base}/appel/tour`, { method: 'POST', headers: { Authorization: `tma ${auth}`, 'Content-Type': 'audio/wav' }, body: new Uint8Array(body) });
    return { store, user, requests, transcriber, synthesizer, telegram, base, say };
  }

  it('sert la page d’appel', async () => {
    const { base } = await setup();
    const page = await fetch(`${base}/appel`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('📞 Appeler');
  });

  it('écoute une phrase, fait répondre Koto et renvoie sa voix, coûts comptés', async () => {
    const { store, user, requests, transcriber, synthesizer, say } = await setup();
    const wav = makeWav([{ seconds: 1, voice: true }]);

    const response = await say(wav);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      transcript: 'Quelle heure est-il ?',
      reply: '**Il est** 10 h.',
      audio: Buffer.from('ID3-son').toString('base64'),
    });
    expect(transcriber.transcribe).toHaveBeenCalledWith(wav, 'wav');
    expect(requests).toEqual([{ userId: user.id, kind: 'chat', text: '[appel] Quelle heure est-il ?', historyText: '[appel] Quelle heure est-il ?' }]);
    expect(synthesizer.synthesize).toHaveBeenCalledWith('Il est 10 h.');
    expect(store.getUsage(user.id, '2026-10-14')).toMatchObject({ requests: 2, costUsd: 0.0001 });
  });

  it('refuse sans signature, et une personne qui ne s’est jamais inscrite', async () => {
    const { say, requests } = await setup();
    expect((await say(makeWav([{ seconds: 1, voice: true }]), 'faux')).status).toBe(401);
    expect((await say(makeWav([{ seconds: 1, voice: true }]), initData(7777))).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it('respecte le budget du jour et refuse une phrase trop longue', async () => {
    const { store, user, say, transcriber } = await setup();
    expect((await say(Buffer.alloc(MAX_TURN_BYTES + 1))).status).toBe(413);

    store.addUsage(user.id, '2026-10-14', { ...emptyUsage(), costUsd: 5 });
    const over = await say(makeWav([{ seconds: 1, voice: true }]));
    expect(over.status).toBe(402);
    expect(((await over.json()) as { erreur: string }).erreur).toContain('limite');
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it('ne répond pas au silence', async () => {
    const { say, requests } = await setup({ transcript: '[silence]' });
    expect(await (await say(makeWav([{ seconds: 1, voice: false }]))).json()).toEqual({ transcript: '' });
    expect(requests).toHaveLength(0);
  });

  it('envoie les actions à confirmer dans Telegram, et garde la réponse écrite si la voix échoue', async () => {
    const action = { id: 3, userId: 1, tool: 'GMAIL_SEND_EMAIL', args: {}, status: 'pending', result: null, createdAt: NOW, decidedAt: null } as PendingAction;
    const { user, say, telegram } = await setup({ pending: [action], synthesize: () => Promise.reject(new Error('quota')) });

    const body = await (await say(makeWav([{ seconds: 1, voice: true }]))).json();

    expect(telegram.confirm).toHaveBeenCalledWith(user.chatId, action);
    expect(body).toMatchObject({ reply: '**Il est** 10 h.', audio: null });
  });

  it('prévient dans Telegram à la fin de l’appel', async () => {
    const { user, base, telegram } = await setup();
    const end = await fetch(`${base}/appel/fin`, { method: 'POST', body: JSON.stringify({ initData: initData(5000), tours: 3, secondes: 130 }) });
    expect(end.status).toBe(204);
    expect(telegram.send).toHaveBeenCalledWith(user.chatId, '📞 Appel terminé : 3 échanges, environ 2 min.');
  });
});
