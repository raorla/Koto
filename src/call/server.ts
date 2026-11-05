// Serveur de la mini-app « Appeler Koto » : sert la page, puis traite chaque phrase dite pendant l'appel
// (transcription → tour de l'agent → réponse lue). Chaque requête doit porter l'initData signée par
// Telegram : seule une personne inscrite sur Koto peut appeler, avec son budget du jour.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { budgetStatus } from '../accounts.js';
import type { Agent } from '../agent/agent.js';
import type { Config } from '../config.js';
import { toSpeechText, type Synthesizer } from '../speech.js';
import { emptyUsage, type PendingAction, type Store, type User } from '../store.js';
import { localDay } from '../time.js';
import { RateLimiter, type KeyedLock, type Logger } from '../util.js';
import { SILENCE, type Transcriber } from '../voice.js';
import { verifyInitData } from './auth.js';
import { CALL_PAGE_HTML } from './page.js';

/** Environ une minute de parole en WAV 16 kHz mono : au-delà, la phrase est refusée. */
export const MAX_TURN_BYTES = 2 * 1024 * 1024;
const MAX_END_BYTES = 8 * 1024;

export interface CallDeps {
  config: Config;
  store: Store;
  agent: Agent;
  locks: KeyedLock;
  log: Logger;
  transcriber: Transcriber;
  /** Synthèse vocale ; absente = Koto répond seulement par écrit dans la page. */
  synthesizer: Synthesizer | null;
  /** Ce qui doit aussi arriver dans la conversation Telegram : cartes à confirmer, fin d'appel. */
  telegram: {
    confirm(chatId: number, action: PendingAction): Promise<void>;
    send(chatId: number, text: string): Promise<void>;
  };
  now?: () => number;
}

class TooLarge extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const ERRORS = {
  auth: 'Rouvre l’appel depuis Telegram (commande /appel).',
  unknown: 'Écris d’abord à Koto sur Telegram pour t’inscrire.',
  rate: 'Doucement 🙂 laisse-moi quelques secondes.',
  budget: 'Tu as atteint ta limite d’aujourd’hui. On reprend demain 🙏',
  large: 'Phrase trop longue pour moi : coupe-la en plusieurs.',
  server: 'Oups, un souci de mon côté. Réessaie dans un instant.',
};

export function createCallHandler(deps: CallDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, store, agent, locks, log } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(20, 60_000);

  /** La personne derrière une initData signée, ou la raison du refus. */
  function caller(initData: string): { user: User } | { error: 'auth' | 'unknown' } {
    const who = verifyInitData(initData, config.telegramToken, now());
    if (!who) return { error: 'auth' };
    const user = store.getUserByTelegramId(who.id);
    return user ? { user } : { error: 'unknown' };
  }

  function bearer(req: IncomingMessage): string {
    const header = req.headers.authorization ?? '';
    return header.startsWith('tma ') ? header.slice(4) : '';
  }

  async function turn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = caller(bearer(req));
    if ('error' in who) return sendJson(res, who.error === 'auth' ? 401 : 403, { erreur: ERRORS[who.error] });
    const { user } = who;
    const at = now();
    if (!limiter.allow(user.id, at)) return sendJson(res, 429, { erreur: ERRORS.rate });
    if (budgetStatus(store, config, user, at).over) return sendJson(res, 402, { erreur: ERRORS.budget });

    const audio = await readBody(req, MAX_TURN_BYTES);
    const heard = await deps.transcriber.transcribe(audio, 'wav');
    store.addUsage(user.id, localDay(at, user.timezone), { ...emptyUsage(), requests: 1, costUsd: heard.costUsd });
    if (!heard.text || heard.text === SILENCE) return sendJson(res, 200, { transcript: '' });

    const result = await locks.run(user.id, () =>
      agent({ userId: user.id, kind: 'chat', text: `[appel] ${heard.text}`, historyText: `[appel] ${heard.text}` }),
    );
    // Une action à confirmer (mail, rendez-vous…) arrive en carte dans Telegram, pas dans l'appel.
    for (const action of result.pendingActions) {
      await deps.telegram.confirm(user.chatId, action).catch((err) => log.error('call confirmation failed', err, { userId: user.id }));
    }

    let spoken: string | null = null;
    const speech = toSpeechText(result.text);
    if (deps.synthesizer && speech) {
      try {
        const voice = await deps.synthesizer.synthesize(speech);
        store.addUsage(user.id, localDay(at, user.timezone), { ...emptyUsage(), requests: 1, costUsd: voice.costUsd });
        spoken = voice.audio.toString('base64');
      } catch (err) {
        log.error('call voice failed', err, { userId: user.id });
      }
    }
    log.info('call turn', { userId: user.id, status: result.status, voice: spoken !== null, costUsd: Number(result.usage.costUsd.toFixed(5)) });
    sendJson(res, 200, { transcript: heard.text, reply: result.text, audio: spoken });
  }

  async function end(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // sendBeacon ne permet pas d'en-tête : l'initData peut aussi venir dans le corps.
    const body = JSON.parse((await readBody(req, MAX_END_BYTES)).toString('utf8') || '{}') as { initData?: string; tours?: number; secondes?: number };
    const who = caller(bearer(req) || (body.initData ?? ''));
    if ('error' in who) return sendJson(res, who.error === 'auth' ? 401 : 403, { erreur: ERRORS[who.error] });
    const turns = Math.max(0, Math.round(Number(body.tours) || 0));
    const minutes = Math.max(1, Math.round((Number(body.secondes) || 0) / 60));
    if (turns > 0) await deps.telegram.send(who.user.chatId, `📞 Appel terminé : ${turns} échange${turns > 1 ? 's' : ''}, environ ${minutes} min.`);
    res.writeHead(204).end();
  }

  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    try {
      if (req.method === 'GET' && path === '/appel') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(CALL_PAGE_HTML);
      } else if (req.method === 'GET' && path === '/sante') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      } else if (req.method === 'POST' && path === '/appel/tour') {
        await turn(req, res);
      } else if (req.method === 'POST' && path === '/appel/fin') {
        await end(req, res);
      } else {
        sendJson(res, 404, { erreur: 'Introuvable' });
      }
    } catch (err) {
      if (err instanceof TooLarge) return sendJson(res, 413, { erreur: ERRORS.large });
      log.error('call request failed', err);
      if (!res.headersSent) sendJson(res, 500, { erreur: ERRORS.server });
    }
  };
}

export interface RunningCallServer {
  port: number;
  close(): Promise<void>;
}

/** Démarre le serveur d'appel (par défaut sur 127.0.0.1 : on l'expose par un tunnel HTTPS ou un proxy). */
export async function startCallServer(deps: CallDeps, options: { port: number; host: string }): Promise<RunningCallServer> {
  const handler = createCallHandler(deps);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
