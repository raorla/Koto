// Banc de tests système : le vrai Koto (src/index.ts) tourne dans un processus à part, branché sur un
// faux Telegram et un faux OpenRouter qui écoutent en local. Rien ne sort sur Internet, aucune clé réelle.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeMp3 } from '../support/audio.js';

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
  files: Record<string, { name: string; bytes: Buffer }>;
  /** Ce que le faux Telegram a répondu (ex : le message créé, avec son message_id). */
  result?: unknown;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Découpe un corps multipart/form-data (le parseur de Node est trop strict pour celui de grammY). */
function multipart(contentType: string, body: Buffer): { name: string; filename: string | null; data: Buffer }[] {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: { name: string; filename: string | null; data: Buffer }[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const chunk = body.subarray(start + delimiter.length, next);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8');
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      // grammY écrit « filename=koto.mp3 » sans guillemets.
      const filename = /filename="?([^";\r\n]*)"?/i.exec(headers)?.[1] ?? null;
      // Le contenu se termine par « \r\n » avant le délimiteur suivant.
      if (name !== undefined) parts.push({ name, filename, data: chunk.subarray(headerEnd + 4, chunk.length - 2) });
    }
    start = next;
  }
  return parts;
}

/** Corps JSON ou multipart (fichiers envoyés par grammY), champs JSON décodés. */
async function parsePayload(contentType: string, body: Buffer): Promise<Pick<RecordedCall, 'payload' | 'files'>> {
  if (body.length === 0) return { payload: {}, files: {} };
  if (!contentType.includes('multipart/form-data')) return { payload: JSON.parse(body.toString('utf8')) as Record<string, unknown>, files: {} };
  const payload: Record<string, unknown> = {};
  const parts: Record<string, { name: string; bytes: Buffer }> = {};
  for (const part of multipart(contentType, body)) {
    if (part.filename === null) {
      const value = part.data.toString('utf8');
      payload[part.name] = /^[[{]/.test(value) ? JSON.parse(value) : value;
    } else {
      parts[part.name] = { name: part.filename, bytes: Buffer.from(part.data) };
    }
  }
  // grammY référence les fichiers par « attach://<clé> » : on les rattache à leur champ.
  const files: RecordedCall['files'] = {};
  for (const [key, value] of Object.entries(payload)) {
    const ref = typeof value === 'string' ? /^attach:\/\/(.+)$/.exec(value)?.[1] : undefined;
    if (ref && parts[ref]) files[key] = parts[ref];
  }
  for (const [key, part] of Object.entries(parts)) if (!Object.values(files).includes(part)) files[key] = part;
  return { payload, files };
}

// ------------------------------------------------------------------ faux Telegram

export class FakeTelegram {
  readonly token = '123456:TEST-token-system';
  readonly calls: RecordedCall[] = [];
  url = '';
  private server!: Server;
  private readonly updates: Record<string, unknown>[] = [];
  private readonly files = new Map<string, Buffer>();
  private nextUpdateId = 1;
  private nextMessageId = 100;
  private wake: (() => void) | null = null;

  static async start(): Promise<FakeTelegram> {
    const telegram = new FakeTelegram();
    telegram.server = createServer((req, res) => void telegram.handle(req, res));
    telegram.url = `http://127.0.0.1:${await listen(telegram.server)}`;
    return telegram;
  }

  close(): Promise<void> {
    this.wake?.();
    return close(this.server);
  }

  addFile(fileId: string, bytes: Buffer): void {
    this.files.set(fileId, bytes);
  }

  /** Comme un file_id expiré : getFile le refuse ensuite, comme le vrai Telegram. */
  removeFile(fileId: string): void {
    this.files.delete(fileId);
  }

  private push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
    this.wake?.();
  }

  private message(fromId: number, extra: Record<string, unknown>): void {
    this.push({
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: 'private', first_name: 'Ana' },
        from: { id: fromId, is_bot: false, first_name: 'Ana', language_code: 'fr' },
        ...extra,
      },
    });
  }

  sendText(fromId: number, text: string): void {
    const command = text.startsWith('/') ? text.split(' ')[0]! : null;
    this.message(fromId, { text, ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}) });
  }

  sendVoice(fromId: number, fileId: string, duration: number): void {
    this.message(fromId, { voice: { file_id: fileId, file_unique_id: `u-${fileId}`, duration, mime_type: 'audio/ogg', file_size: this.files.get(fileId)?.length ?? 0 } });
  }

  /** Un fichier (PDF, image…) envoyé en document, avec sa légende éventuelle. */
  sendDocument(fromId: number, fileId: string, fileName: string, mimeType: string, caption?: string): void {
    this.message(fromId, {
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: fileName, mime_type: mimeType, file_size: this.files.get(fileId)?.length ?? 0 },
      ...(caption ? { caption } : {}),
    });
  }

  /** Koto est ajouté au groupe `chatId` par `fromId` (mise à jour my_chat_member, comme sur Telegram). */
  addBotToGroup(chatId: number, title: string, fromId: number, firstName: string): void {
    const bot = { id: 42, is_bot: true, first_name: 'Koto', username: 'koto_test_bot' };
    this.push({
      my_chat_member: {
        chat: { id: chatId, type: 'supergroup', title },
        from: { id: fromId, is_bot: false, first_name: firstName, language_code: 'fr' },
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'left', user: bot },
        new_chat_member: { status: 'member', user: bot },
      },
    });
  }

  /**
   * Message dans un groupe, avec les entités que Telegram y met (commande en tête, @mentions) ;
   * `replyTo` en fait une réponse à un message envoyé par Koto.
   */
  sendGroupText(chatId: number, title: string, fromId: number, firstName: string, text: string, options: { replyTo?: RecordedCall } = {}): void {
    const command = text.startsWith('/') ? text.split(' ')[0]! : null;
    const entities = [
      ...(command ? [{ type: 'bot_command', offset: 0, length: command.length }] : []),
      ...[...text.matchAll(/@\w+/g)].filter((m) => m.index >= (command?.length ?? 0)).map((m) => ({ type: 'mention', offset: m.index, length: m[0].length })),
    ];
    const chat = { id: chatId, type: 'supergroup', title };
    const replied = options.replyTo;
    this.push({
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: { id: fromId, is_bot: false, first_name: firstName, language_code: 'fr' },
        text,
        ...(entities.length > 0 ? { entities } : {}),
        ...(replied
          ? {
              reply_to_message: {
                message_id: (replied.result as { message_id: number }).message_id,
                date: Math.floor(Date.now() / 1000),
                chat,
                from: { id: 42, is_bot: true, first_name: 'Koto', username: 'koto_test_bot' },
                text: String(replied.payload.text),
              },
            }
          : {}),
      },
    });
  }

  pressButton(fromId: number, data: string, messageId: number): void {
    this.push({
      callback_query: {
        id: `cb-${this.nextUpdateId}`,
        from: { id: fromId, is_bot: false, first_name: 'Ana' },
        chat_instance: 'ci',
        data,
        message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: fromId, type: 'private', first_name: 'Ana' }, text: 'liste' },
      },
    });
  }

  /** Attend un appel de Koto à l'API (après les `since` premiers), sinon échoue avec ce qui a été vu. */
  async waitFor(predicate: (call: RecordedCall) => boolean, options: { since?: number; timeoutMs?: number } = {}): Promise<RecordedCall> {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (;;) {
      const found = this.calls.slice(options.since ?? 0).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`appel attendu introuvable ; reçus : ${this.calls.map((c) => c.method).join(', ')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const file = /^\/file\/bot([^/]+)\/voice\/(.+)$/.exec(url.pathname);
    if (file) {
      const bytes = file[1] === this.token ? this.files.get(file[2]!) : undefined;
      if (!bytes) return sendJson(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end(bytes);
      return;
    }
    const route = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!route || route[1] !== this.token) return sendJson(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const method = route[2]!;
    const { payload, files } = await parsePayload(req.headers['content-type'] ?? '', await readBody(req));
    if (method === 'getUpdates') {
      const offset = Number(payload.offset ?? 0);
      const pending = () => this.updates.filter((u) => (u.update_id as number) >= offset);
      if (pending().length === 0) {
        // Long polling raccourci (1 s au plus) pour que l'arrêt de Koto reste rapide.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(Number(payload.timeout ?? 0), 1) * 1000);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
      return sendJson(res, 200, { ok: true, result: pending() });
    }
    const call: RecordedCall = { method, payload, files };
    this.calls.push(call);
    const ok = (result: unknown) => {
      call.result = result;
      sendJson(res, 200, { ok: true, result });
    };
    switch (method) {
      case 'getMe':
        return ok({ id: 42, is_bot: true, first_name: 'Koto', username: 'koto_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false });
      case 'getFile': {
        const id = String(payload.file_id);
        if (!this.files.has(id)) {
          return sendJson(res, 400, { ok: false, error_code: 400, description: 'Bad Request: wrong file_id or the file is temporarily unavailable' });
        }
        return ok({ file_id: id, file_unique_id: `u-${id}`, file_size: this.files.get(id)?.length ?? 0, file_path: `voice/${id}` });
      }
      case 'sendMessage':
      case 'sendVoice':
      case 'sendDocument':
      case 'sendPhoto':
        return ok({ message_id: this.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text ?? '' });
      default:
        return ok(true);
    }
  }
}

// ------------------------------------------------------------------ faux OpenRouter

type Block = Record<string, unknown>;
/** Réponse scriptée du modèle à partir du corps de la requête Messages. */
export type ScriptedModel = (body: { model: string; system?: Block[]; messages: { role: string; content: string | Block[] }[] }) => { content: Block[]; stop_reason: string };

const SPEECH_CATALOG = {
  data: [
    { id: 'fish-audio/s2.1-pro-free:free', pricing: { prompt: '0', completion: '0' }, supported_voices: null },
    { id: 'hexgrad/kokoro-82m', pricing: { prompt: '0.00000062', completion: '0' }, supported_voices: ['ff_siwis', 'af_heart'] },
  ],
};

export class FakeOpenRouter {
  readonly requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  /** Ce que la « transcription » renvoie pour tout vocal. */
  transcript = '';
  url = '';
  private server!: Server;
  private nextId = 1;

  constructor(private readonly model: ScriptedModel) {}

  static async start(model: ScriptedModel): Promise<FakeOpenRouter> {
    const fake = new FakeOpenRouter(model);
    fake.server = createServer((req, res) => void fake.handle(req, res));
    fake.url = `http://127.0.0.1:${await listen(fake.server)}/api`;
    return fake;
  }

  close(): Promise<void> {
    return close(this.server);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const raw = await readBody(req);
    const body = raw.length > 0 && (req.headers['content-type'] ?? '').includes('json') ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, body });

    if (url.pathname === '/api/v1/models') return sendJson(res, 200, SPEECH_CATALOG);
    if (url.pathname === '/api/v1/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(fakeMp3(120));
      return;
    }
    if (url.pathname === '/api/v1/chat/completions') {
      return sendJson(res, 200, { choices: [{ message: { role: 'assistant', content: this.transcript } }], usage: { cost: 0.0001 } });
    }
    if (url.pathname === '/api/v1/messages') {
      const reply = this.model(body as Parameters<ScriptedModel>[0]);
      return sendJson(res, 200, {
        id: `msg_${this.nextId++}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: reply.content,
        stop_reason: reply.stop_reason,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost: 0.0003 },
      });
    }
    sendJson(res, 404, { error: { message: `route inconnue ${url.pathname}` } });
  }
}

// ------------------------------------------------------------------ le vrai Koto

export interface RunningKoto {
  dbPath: string;
  output: () => string;
  /** Envoie SIGTERM et renvoie le code de sortie. */
  stop: () => Promise<number | null>;
}

const ROOT = resolve(import.meta.dirname, '../..');

/** Lance `src/index.ts` dans un dossier vide (aucun .env lu) avec une base temporaire. */
export async function startKoto(env: Record<string, string>): Promise<RunningKoto> {
  const dir = mkdtempSync(join(tmpdir(), 'koto-systeme-'));
  const dbPath = join(dir, 'koto.db');
  const child: ChildProcess = spawn(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'src/index.ts')], {
    cwd: dir,
    // Environnement reconstruit de zéro : aucune vraie clé ne peut fuiter vers le processus testé.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, DATABASE_PATH: dbPath, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  const deadline = Date.now() + 30_000;
  while (!output.includes('Koto est en ligne')) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`Koto n'a pas démarré :\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    dbPath,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const code = await exited;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      return code;
    },
  };
}
