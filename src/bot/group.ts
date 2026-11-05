// Conversations de groupe : à qui s'adresse un message, qui parle, à qui le groupe est rattaché.
// En groupe, Koto ne traite que ce qui lui est adressé (commande pour lui, @mention, réponse à l'un de ses
// messages, bouton), même quand Telegram lui transmet davantage (Koto admin du groupe, mode privé coupé).
// Le groupe a son propre compte : sa mémoire, ses rappels et ses listes ne sont jamais ceux d'un membre.
import type { MiddlewareFn } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import { payerFor } from '../accounts.js';
import type { TurnRequest } from '../agent/agent.js';
import type { Config } from '../config.js';
import type { Store, User } from '../store.js';
import { formatDateTime } from '../time.js';
import type { Logger } from '../util.js';
import type { KotoContext } from './bot.js';
import { sendText } from './format.js';

/** Qui parle dans le groupe, et ce à quoi il répond. */
export interface Speaker {
  /** Prénom Telegram : jamais le nom d'usage réglé en privé. */
  name: string;
  /** Courte citation du message auquel il répond, s'il y en a un. */
  quote: string | null;
}

/** Ce que le bot sait d'un tour de groupe, en plus du compte du groupe (ctx.koto.user). */
export interface GroupTurn {
  /** Personne inscrite dont le budget paie les tours du groupe ; null tant que personne ne l'est. */
  payer: User | null;
  speaker: Speaker;
}

// ------------------------------------------------------------------ à qui s'adresse le message

/** Statuts où un compte fait partie du groupe. */
export function isMemberStatus(member: { status: string; is_member?: boolean }): boolean {
  return ['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member === true);
}

/** La commande en tête du message (« /listes » ou « /listes@koto_bot »), s'il y en a une. */
export function leadingCommand(message: Message): { name: string; target: string | null } | null {
  const entity = message.entities?.[0];
  if (!message.text || entity?.type !== 'bot_command' || entity.offset !== 0) return null;
  const [name = '', target] = message.text.slice(1, entity.length).split('@');
  return { name: name.toLowerCase(), target: target?.toLowerCase() ?? null };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Le message mentionne-t-il Koto (« @koto_bot », ou mention d'un compte sans @) ? */
export function mentionsBot(message: Message, me: UserFromGetMe): boolean {
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  if (entities.some((e) => e.type === 'text_mention' && e.user.id === me.id)) return true;
  const handle = new RegExp(`(^|[^\\w@])@${escapeRegExp(me.username)}(?!\\w)`, 'i');
  return [message.text, message.caption].some((text) => text !== undefined && handle.test(text));
}

/**
 * Le message s'adresse-t-il à Koto ? Une réponse à l'un de ses messages, une commande pour lui (sans @,
 * seulement si c'est l'une des siennes : une commande d'un autre bot ne le concerne pas), ou une mention.
 */
export function isAddressedToBot(message: Message, me: UserFromGetMe, commands: ReadonlySet<string>): boolean {
  if (message.reply_to_message?.from?.id === me.id) return true;
  const command = leadingCommand(message);
  if (command?.target) return command.target === me.username.toLowerCase();
  if (command && commands.has(command.name)) return true;
  return mentionsBot(message, me);
}

/** Texte transmis au modèle : « @koto_bot » en tête disparaît, ailleurs il devient « Koto ». */
export function stripBotMention(text: string, username: string): string {
  const handle = escapeRegExp(username);
  return text
    .replace(new RegExp(`^\\s*@${handle}(?!\\w)[\\s,:;.!-]*`, 'i'), '')
    .replace(new RegExp(`@${handle}(?!\\w)`, 'gi'), 'Koto')
    .trim();
}

// ------------------------------------------------------------------ qui parle

/** Prénom Telegram de qui écrit, nettoyé : il entre tel quel dans le prompt. */
export function speakerName(from: { first_name?: string; username?: string } | undefined): string {
  const raw = from?.first_name?.trim() || from?.username || '';
  // Ni retour à la ligne, ni crochets, ni deux-points : un prénom ne doit pas imiter un horodatage ou un autre interlocuteur.
  const name = raw
    .replace(/[[\]:«»]/g, ' ')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, 40);
  return name || 'Quelqu’un';
}

/** Prénom Telegram d'une personne inscrite, tel que le groupe le connaît (jamais son nom d'usage privé). */
export function publicName(user: User): string {
  return user.firstName ?? (user.username ? `@${user.username}` : 'la personne qui m’a ajouté');
}

const QUOTE_CHARS = 150;

/** Le message auquel on répond, en courte citation : « en réponse à Bob : « On part à 7 h ? » ». */
export function replyQuote(message: Message, me: UserFromGetMe): string | null {
  const replied = message.reply_to_message;
  const source = message.quote?.text ?? replied?.text ?? replied?.caption;
  if (!replied || !source) return null;
  const who = replied.from?.id === me.id ? 'ton message' : speakerName(replied.from);
  const line = source.replace(/\s+/g, ' ').trim();
  return `en réponse à ${who} : « ${line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS)}…` : line} »`;
}

/** En groupe, chaque message transmis commence par le prénom de qui parle (et ce à quoi il répond). */
export function frameText(speaker: Speaker, text: string): string {
  return `${speaker.name}${speaker.quote ? ` (${speaker.quote})` : ''} : ${text}`;
}

/** /resume : résumé des échanges vus depuis `since`, d'après l'historique (rien de plus n'est envoyé). */
export function summaryRequest(account: User, asker: string | null, since: number, count: number): TurnRequest {
  const where = account.kind === 'group' ? 'dans ce groupe ' : '';
  return {
    userId: account.id,
    kind: 'chat',
    text: `[RÉSUMÉ] ${asker ?? 'La personne'} demande un résumé de ce qu'on t'a dit ${where}depuis le ${formatDateTime(since, account.timezone)} (${count} message${count > 1 ? 's' : ''}). D'après l'historique : décisions prises, qui fait quoi, dates et rappels prévus, listes en cours, questions encore ouvertes. Puces courtes, 120 mots maximum, sans titre. N'invente rien de ce que tu n'as pas vu ; s'il ne s'est rien passé de notable, dis-le en une phrase.`,
    historyText: `[RÉSUMÉ demandé${asker ? ` par ${asker}` : ''}]`,
  };
}

// ------------------------------------------------------------------ textes

export function groupWelcomeText(username: string, features: { weather: boolean; missions?: boolean }): string {
  const abilities = [
    'retenir ce qui compte pour le groupe (la sortie, les dates, qui fait quoi) : /memoire',
    `vous rappeler des choses ici même : « @${username} rappelez-nous samedi à 18 h »`,
    'tenir des listes partagées à cocher (courses d’une sortie, qui apporte quoi) : /listes',
    features.missions ? 'suivre une mission de fond pour le groupe et ne vous prévenir que s’il y a du nouveau : /missions' : null,
    'résumer ce qu’on m’a dit ici : /resume',
    features.weather ? 'donner la météo d’un lieu, chercher une info sur le web' : 'chercher une info sur le web',
  ];
  return `Salut tout le monde 👋 Moi c'est **Koto**.

Dans un groupe, je ne lis que ce qui m'est adressé : mentionnez-moi (@${username}), répondez à l'un de mes messages ou tapez une commande.

Je peux :
${abilities
  .filter(Boolean)
  .map((a) => `• ${a}`)
  .join('\n')}

Ce groupe a sa propre mémoire : je n'y parle jamais de ce que chacun me confie en privé.`;
}

export function groupHelpText(username: string, features: { weather: boolean; voice: boolean; missions?: boolean }): string {
  const examples = [
    `« @${username} on part à Andasibe samedi à 6 h, retiens-le »`,
    `« @${username} rappelez-nous vendredi à 18 h de confirmer le covoiturage »`,
    `« @${username} ajoute charbon, brochettes et eau à la liste de la sortie »`,
    features.weather ? `« @${username} il va pleuvoir à Andasibe samedi ? »` : null,
    features.missions ? `« @${username} surveille la météo à Andasibe jusqu'à samedi et préviens-nous s'il doit pleuvoir »` : null,
    'En réponse à l’un de mes messages : « et qui apporte quoi ? »',
    features.voice ? 'Un vocal en réponse à l’un de mes messages : je l’écoute' : null,
  ].filter(Boolean);
  return `Mentionnez-moi ou répondez à l'un de mes messages. Par exemple :
${examples.map((e) => `• ${e}`).join('\n')}

Commandes du groupe :
/memoire — ce que je sais du groupe
/rappels — les rappels du groupe
/listes — les listes partagées, à cocher${features.missions ? '\n/missions — les missions du groupe, avec un bouton Arrêter' : ''}
/resume — résumé de ce qu'on m'a dit ici (24 h, ou /resume 3 pour 3 jours)
/oublier_tout — effacer la mémoire du groupe (personne rattachée ou admins)

Pour ce qui ne concerne que toi (ta mémoire, tes listes, ton brief), écris-moi en privé : https://t.me/${username}`;
}

export function attachedText(owner: User): string {
  return `ℹ️ Ce groupe est rattaché à ${publicName(owner)} : nos échanges ici comptent dans son budget du jour sur Koto.`;
}

export function noOwnerText(username: string, registration: Config['registrationMode']): string {
  const join =
    registration === 'invite'
      ? ' Koto est sur invitation : demandez un lien à quelqu’un qui l’utilise déjà.'
      : registration === 'open'
        ? ` Pour s'inscrire, il suffit de m'écrire en privé : https://t.me/${username}`
        : '';
  return `Pour que je participe à ce groupe, il faut qu'une personne inscrite sur Koto m'y ajoute ou me parle ici la première : nos échanges compteront dans son budget du jour.${join}`;
}

export function privateOnlyText(username: string): string {
  return `Ça, c'est personnel : écris-moi en privé (https://t.me/${username}) 🙂`;
}

// ------------------------------------------------------------------ accès

export interface GroupAccessDeps {
  store: Store;
  config: Config;
  log: Logger;
  now: () => number;
  /** Commandes de Koto : une commande sans @ ne le concerne que si elle en fait partie. */
  commands: ReadonlySet<string>;
  features: { weather: boolean; missions?: boolean };
}

const NOTICE_EVERY_MS = 10 * 60_000;

/**
 * Accès en groupe. Gère d'abord les événements de service (Koto ajouté ou retiré, passage en
 * supergroupe, départ de la personne rattachée), puis ne laisse passer que ce qui s'adresse à Koto, avec
 * le compte du groupe dans ctx.koto.user. Ne crée jamais de compte pour une personne et ne touche jamais
 * au sien : son chat_id doit rester celui de sa conversation privée.
 */
export function createGroupAccess(deps: GroupAccessDeps): { middleware: MiddlewareFn<KotoContext>; notice: (ctx: KotoContext) => Promise<void> } {
  const { store, config, log, now, commands, features } = deps;
  const noticed = new Map<number, number>();

  /** Explique comment activer Koto dans ce groupe, au plus une fois toutes les 10 minutes (gratuit). */
  async function notice(ctx: KotoContext): Promise<void> {
    const chatId = ctx.chat!.id;
    const at = now();
    if (at - (noticed.get(chatId) ?? -Infinity) < NOTICE_EVERY_MS) return;
    noticed.set(chatId, at);
    await ctx.reply(noOwnerText(ctx.me.username, config.registrationMode));
  }

  /** Crée le compte du groupe, ou le rattache s'il ne l'est à personne. Renvoie la personne rattachée à l'instant. */
  function attach(group: User | null, chat: { id: number; title?: string }, person: User | null): { group: User | null; attached: User | null } {
    if (!person) return { group, attached: null };
    if (!group) {
      const created = store.createGroup(
        { chatId: chat.id, title: chat.title ?? null, username: null, ownerId: person.id, timezone: person.timezone, briefTime: config.defaultBriefTime },
        now(),
      );
      return { group: created, attached: created.ownerId === person.id ? person : null };
    }
    if (group.ownerId === null && store.claimGroup(group.id, person.id)) return { group: store.getUserById(group.id)!, attached: person };
    return { group, attached: null };
  }

  async function membership(ctx: KotoContext): Promise<void> {
    const update = ctx.myChatMember!;
    const chat = ctx.chat as { id: number; title?: string };
    const wasIn = isMemberStatus(update.old_chat_member);
    const isIn = isMemberStatus(update.new_chat_member);
    const current = store.getGroupByChatId(chat.id);
    if (wasIn && !isIn) {
      // Retiré du groupe : plus personne ne paie, et ses rappels ne pourraient plus partir.
      if (!current) return;
      store.releaseGroup(current.id);
      const cancelledJobs = store.cancelPendingJobs(current.id);
      // Ses missions non plus : leurs messages ne pourraient plus partir.
      const stoppedMissions = store.stopActiveMissions(current.id, 'removed', now());
      log.info('group left', { groupId: current.id, cancelledJobs, stoppedMissions });
      return;
    }
    if (wasIn || !isIn) return;
    const adder = update.from.is_bot ? null : store.getUserByTelegramId(update.from.id);
    const { group } = attach(current, chat, adder);
    const owner = group ? payerFor(store, group) : null;
    log.info('group joined', { groupId: group?.id ?? null, attached: owner !== null });
    if (!owner) noticed.set(chat.id, now());
    const status = owner ? attachedText(owner) : noOwnerText(ctx.me.username, config.registrationMode);
    await sendText(ctx.api, chat.id, `${groupWelcomeText(ctx.me.username, features)}\n\n${status}`);
  }

  /** Passage en supergroupe : Telegram change l'id, le groupe garde sa mémoire. Les deux messages de service arrivent. */
  function migrate(fromChatId: number, toChatId: number): void {
    const group = store.getGroupByChatId(fromChatId);
    if (!group) return;
    if (store.moveGroupChat(fromChatId, toChatId)) log.info('group migrated', { groupId: group.id });
    else log.warn('group migration conflict', { groupId: group.id, otherGroupId: store.getGroupByChatId(toChatId)?.id ?? null });
  }

  /** La personne rattachée quitte le groupe : elle ne paie plus, la prochaine personne inscrite prendra le relais. */
  async function memberLeft(ctx: KotoContext, group: User, memberId: number): Promise<void> {
    if (group.ownerId === null) return;
    const owner = store.getUserById(group.ownerId);
    if (!owner || owner.telegramId !== memberId) return;
    store.releaseGroup(group.id);
    log.info('group owner left', { groupId: group.id, userId: owner.id });
    await sendText(
      ctx.api,
      ctx.chat!.id,
      `ℹ️ ${publicName(owner)} a quitté le groupe : nos échanges ici ne comptent plus dans son budget. La prochaine personne inscrite sur Koto qui me parlera ici prendra le relais.`,
    );
  }

  const middleware: MiddlewareFn<KotoContext> = async (ctx, next) => {
    const chat = ctx.chat as { id: number; title?: string };
    if (ctx.myChatMember) return membership(ctx);
    const message = ctx.message;
    if (message?.migrate_to_chat_id) return migrate(chat.id, message.migrate_to_chat_id);
    if (message?.migrate_from_chat_id) return migrate(message.migrate_from_chat_id, chat.id);

    let group = store.getGroupByChatId(chat.id);
    if (group && chat.title && chat.title !== group.firstName) {
      store.setGroupTitle(group.id, chat.title);
      group = store.getUserById(group.id)!;
    }
    if (message?.left_chat_member) {
      if (group) await memberLeft(ctx, group, message.left_chat_member.id);
      return;
    }

    // Le reste : seulement ce qui s'adresse à Koto (les boutons sont toujours sur ses propres messages).
    if (!ctx.from || ctx.from.is_bot) return;
    if (!ctx.callbackQuery && !(message && isAddressedToBot(message, ctx.me, commands))) return;

    // Lecture seule : jamais ensureUser ni touchUser ici, sinon le chat_id de la personne deviendrait
    // celui du groupe, et ses rappels personnels partiraient dans le groupe.
    const person = store.getUserByTelegramId(ctx.from.id);
    const result = attach(group, chat, person);
    group = result.group;
    if (!group) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      else await notice(ctx);
      return;
    }
    if (result.attached) {
      log.info('group attached', { groupId: group.id, userId: result.attached.id });
      await sendText(ctx.api, chat.id, attachedText(result.attached));
    }
    ctx.koto = {
      user: group,
      created: false,
      group: { payer: payerFor(store, group), speaker: { name: speakerName(ctx.from), quote: message ? replyQuote(message, ctx.me) : null } },
    };
    await next();
  };

  return { middleware, notice };
}
