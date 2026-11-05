// Banc d'essai du bot Telegram : grammY réel, API Telegram interceptée (rien ne sort sur le réseau).
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Agent, TurnRequest } from '../../src/agent/agent.js';
import { createBot, type BotDeps, type KotoContext } from '../../src/bot/bot.js';
import { emptyUsage, type Store } from '../../src/store.js';
import { KeyedLock, silentLogger } from '../../src/util.js';
import { NOW, makeConfig, makeStore } from '../helpers.js';

export const BOT_INFO = {
  id: 42,
  is_bot: true,
  first_name: 'Koto',
  username: 'koto_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

export interface SetupOptions extends Partial<Pick<BotDeps, 'integrations' | 'transcriber' | 'synthesizer' | 'news' | 'weather' | 'downloadFile' | 'browserTasks'>> {
  /** Agent personnalisé ; par défaut, un écho qui enregistre les demandes. */
  agent?: (store: Store, requests: TurnRequest[]) => Agent;
  /** Missions de fond (/missions et ses boutons), construites sur la base du banc d'essai. */
  missions?: (store: Store) => NonNullable<BotDeps['missions']>;
  /** Membres admins des groupes (réponse de getChatMember) ; les autres sont de simples membres. */
  chatAdmins?: number[];
}

export function setupBot(config = makeConfig(), options: SetupOptions = {}) {
  const store = makeStore();
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const bot = new Bot<KotoContext>('test-token', { botInfo: BOT_INFO });
  // Intercepte tous les appels à l'API Telegram : rien ne sort sur le réseau.
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as Record<string, unknown>;
    const result =
      method === 'sendMessage'
        ? { message_id: calls.length, date: 0, chat: { id: 1, type: 'private' }, text: '' }
        : method === 'getChatMember'
          ? { status: options.chatAdmins?.includes(Number(p.user_id)) ? 'administrator' : 'member', user: { id: Number(p.user_id), is_bot: false, first_name: 'x' } }
          : true;
    return { ok: true, result } as never;
  });
  const requests: TurnRequest[] = [];
  const agent: Agent =
    options.agent?.(store, requests) ??
    (async (request) => {
      requests.push(request);
      return { text: `écho : ${request.text}`, status: 'ok', usage: emptyUsage(), pendingActions: [] };
    });
  createBot(
    {
      config,
      store,
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      now: () => NOW,
      integrations: options.integrations,
      transcriber: options.transcriber,
      synthesizer: options.synthesizer,
      news: options.news,
      weather: options.weather,
      downloadFile: options.downloadFile,
      browserTasks: options.browserTasks,
      missions: options.missions?.(store),
    },
    bot,
  );
  const messages = () => calls.filter((c) => c.method === 'sendMessage');
  const sent = () => messages().map((c) => String(c.payload.text));
  return { bot, store, calls, messages, sent, requests };
}

/** Boutons d'un message envoyé (texte et données de rappel ou URL). */
export function buttons(payload: Record<string, unknown>): { text: string; callback_data?: string; url?: string }[] {
  const markup = payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
}

let updateId = 1;
export function voiceUpdate(fromId: number, duration: number): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Ana' },
      from: { id: fromId, is_bot: false, first_name: 'Ana', language_code: 'fr' },
      voice: { file_id: 'voice-1', file_unique_id: 'u1', duration, mime_type: 'audio/ogg', file_size: 12_000 },
    },
  } as Update;
}

export function callbackUpdate(fromId: number, data: string, messageId = 99): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: fromId, is_bot: false, first_name: 'Ana' },
      chat_instance: 'ci',
      data,
      message: { message_id: messageId, date: Math.floor(NOW / 1000), chat: { id: fromId, type: 'private', first_name: 'Ana' }, text: 'carte' },
    },
  } as Update;
}

export function textUpdate(fromId: number, text: string): Update {
  const command = text.startsWith('/') ? text.split(' ')[0]! : null;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Ana' },
      from: { id: fromId, is_bot: false, first_name: 'Ana', language_code: 'fr' },
      text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
    },
  } as Update;
}

// ------------------------------------------------------------------ groupes

export const GROUP_TITLE = 'Sortie Andasibe';

const groupChat = (chatId: number, title = GROUP_TITLE) => ({ id: chatId, type: 'supergroup', title });
const person = (id: number, firstName: string) => ({ id, is_bot: false, first_name: firstName, language_code: 'fr' });

/** Message de groupe à quoi l'on répond : un message de Koto (fromId 42) ou d'un autre membre. */
export interface RepliedMessage {
  fromId: number;
  firstName?: string;
  text: string;
}

/**
 * Message texte dans un groupe, avec les entités que Telegram y mettrait : la commande en tête et les
 * @mentions qui suivent.
 */
export function groupTextUpdate(
  chatId: number,
  fromId: number,
  text: string,
  options: { firstName?: string; replyTo?: RepliedMessage; title?: string } = {},
): Update {
  const command = text.startsWith('/') ? text.split(' ')[0]! : null;
  const mentions = [...text.matchAll(/@\w+/g)].filter((m) => m.index >= (command?.length ?? 0));
  const entities = [
    ...(command ? [{ type: 'bot_command', offset: 0, length: command.length }] : []),
    ...mentions.map((m) => ({ type: 'mention', offset: m.index, length: m[0].length })),
  ];
  const replied = options.replyTo;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: groupChat(chatId, options.title),
      from: person(fromId, options.firstName ?? 'Ana'),
      text,
      ...(entities.length > 0 ? { entities } : {}),
      ...(replied
        ? {
            reply_to_message: {
              message_id: 1,
              date: Math.floor(NOW / 1000),
              chat: groupChat(chatId, options.title),
              from: replied.fromId === BOT_INFO.id ? { id: BOT_INFO.id, is_bot: true, first_name: 'Koto', username: BOT_INFO.username } : person(replied.fromId, replied.firstName ?? 'Bob'),
              text: replied.text,
            },
          }
        : {}),
    },
  } as Update;
}

/** Message de service dans un groupe (départ d'un membre, passage en supergroupe…). */
export function groupServiceUpdate(chatId: number, fromId: number, service: Record<string, unknown>): Update {
  return {
    update_id: updateId++,
    message: { message_id: updateId, date: Math.floor(NOW / 1000), chat: groupChat(chatId), from: person(fromId, 'Ana'), ...service },
  } as Update;
}

/** Bouton pressé sous un message de Koto dans un groupe. */
export function groupCallbackUpdate(chatId: number, fromId: number, data: string, messageId = 99): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: person(fromId, 'Bob'),
      chat_instance: 'ci',
      data,
      message: { message_id: messageId, date: Math.floor(NOW / 1000), chat: groupChat(chatId), from: { id: BOT_INFO.id, is_bot: true, first_name: 'Koto' }, text: 'liste' },
    },
  } as Update;
}

/** Koto ajouté à un groupe (left → member) ou retiré (member → left) par `fromId`. */
export function botMembershipUpdate(chatId: number, fromId: number, change: 'added' | 'removed'): Update {
  const bot = { id: BOT_INFO.id, is_bot: true, first_name: 'Koto', username: BOT_INFO.username };
  const [before, after] = change === 'added' ? ['left', 'member'] : ['member', 'left'];
  return {
    update_id: updateId++,
    my_chat_member: {
      chat: groupChat(chatId),
      from: person(fromId, 'Ana'),
      date: Math.floor(NOW / 1000),
      old_chat_member: { status: before, user: bot },
      new_chat_member: { status: after, user: bot },
    },
  } as Update;
}

export function locationUpdate(fromId: number, latitude: number, longitude: number): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Ana' },
      from: { id: fromId, is_bot: false, first_name: 'Ana', language_code: 'fr' },
      location: { latitude, longitude },
    },
  } as Update;
}
