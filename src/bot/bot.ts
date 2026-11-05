import Anthropic from '@anthropic-ai/sdk';
import { sequentialize } from '@grammyjs/runner';
import { Bot, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from 'grammy';
import {
  applySettings,
  budgetStatus,
  createInviteFor,
  displayName,
  ensureUser,
  recordUsage,
  type Registration,
} from '../accounts.js';
import type { Agent, TurnRequest } from '../agent/agent.js';
import type { BrowserTasks } from '../browser/tasks.js';
import type { Config } from '../config.js';
import { buildExport, exportFileName } from '../export.js';
import { cancelAction, confirmAction } from '../integrations/actions.js';
import { TOOLKITS, TOOLKIT_LABELS, type Toolkit } from '../integrations/catalog.js';
import type { Integrations } from '../integrations/types.js';
import { DOCUMENT_MAX_BYTES, FileGone, FileTooLarge } from '../memory/documents.js';
import type { MissionRunner } from '../missions/runner.js';
import type { NewsService } from '../news.js';
import { briefNews, briefRequest, briefWeather } from '../scheduler.js';
import type { WeatherService } from '../weather.js';
import { voiceForBrief, voiceForReply, type Synthesizer } from '../speech.js';
import { MEMORY_KINDS, MEMORY_KIND_LABELS, emptyUsage, type Store, type User, type VoiceMode } from '../store.js';
import { REPEAT_LABELS, formatRelative } from '../time.js';
import { RateLimiter, type KeyedLock, type Logger } from '../util.js';
import { SILENCE, audioFormatFromMime, type Transcriber } from '../voice.js';
import {
  ACTION_CALLBACK,
  LIST_CALLBACK,
  MISSION_CALLBACK,
  TASK_CALLBACK,
  TASK_CANCEL_CALLBACK,
  deliverTurn,
  renderList,
  renderMissions,
  telegramVoiceSender,
} from './delivery.js';
import { markdownToTelegramHtml, sendText, type SendOptions } from './format.js';
import {
  createGroupAccess,
  frameText,
  groupHelpText,
  groupWelcomeText,
  noOwnerText,
  privateOnlyText,
  publicName,
  stripBotMention,
  summaryRequest,
  type GroupTurn,
} from './group.js';

type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * `koto.user` est le compte dont on lit et écrit les données : la personne en privé, le groupe dans un
 * groupe (et `koto.group` dit alors qui paie et qui parle).
 */
export type KotoContext = Context & { koto?: { user: User; created: boolean; group?: GroupTurn } };

export type FileDownloader = (api: Api, fileId: string, maxBytes: number) => Promise<Buffer>;

export interface BotDeps {
  config: Config;
  store: Store;
  agent: Agent;
  locks: KeyedLock;
  log: Logger;
  now?: () => number;
  /** Gmail / Google Agenda ; absent = /connecter désactivé. */
  integrations?: Integrations | null;
  /** Transcription des vocaux ; absent = vocaux refusés poliment. */
  transcriber?: Transcriber | null;
  /** Synthèse vocale ; absent = Koto ne répond jamais en vocal. */
  synthesizer?: Synthesizer | null;
  /** Veille d'actualité du brief (flux gratuits) ; absent = sujets de veille cherchés sur le web. */
  news?: NewsService | null;
  /** Météo et lieux gratuits ; absent = positions partagées ignorées. */
  weather?: WeatherService | null;
  /** Tâches dans le navigateur ; absent = /taches désactivé. */
  browserTasks?: BrowserTasks | null;
  /** Missions de fond ; absent = /missions désactivé. */
  missions?: MissionRunner | null;
  /** Adresse HTTPS de la page d'appel (mini-app) ; absente = /appel explique comment l'activer. */
  callUrl?: string | null;
  /** Remplaçable dans les tests ; par défaut, télécharge depuis l'API fichiers de Telegram. */
  downloadFile?: FileDownloader;
}

export const COMMANDS = [
  { command: 'memoire', description: 'Ce que Koto sait de toi' },
  { command: 'rappels', description: 'Tes rappels et relances à venir' },
  { command: 'listes', description: 'Tes listes (courses, tâches…) à cocher' },
  { command: 'missions', description: 'Tes missions en arrière-plan' },
  { command: 'brief', description: 'Recevoir ton brief maintenant' },
  { command: 'appel', description: 'M’appeler pour parler de vive voix' },
  { command: 'connecter', description: 'Relier Gmail et Google Agenda' },
  { command: 'taches', description: 'Tes tâches web en cours' },
  { command: 'inviter', description: 'Inviter quelqu’un sur Koto' },
  { command: 'usage', description: 'Ta consommation du jour' },
  { command: 'exporter', description: 'Télécharger toutes tes données' },
  { command: 'oublier_tout', description: 'Effacer tes données' },
  { command: 'aide', description: 'Ce que Koto sait faire' },
];

/** Menu des groupes (scope « all_group_chats ») : seulement les commandes du groupe. */
export const GROUP_COMMANDS = [
  { command: 'memoire', description: 'Ce que Koto sait du groupe' },
  { command: 'rappels', description: 'Les rappels du groupe' },
  { command: 'listes', description: 'Les listes partagées du groupe' },
  { command: 'missions', description: 'Les missions du groupe' },
  { command: 'resume', description: 'Résumé de ce qu’on a dit à Koto ici' },
  { command: 'aide', description: 'Ce que Koto sait faire en groupe' },
  { command: 'oublier_tout', description: 'Effacer la mémoire du groupe' },
];

/** Commandes personnelles : dans un groupe, Koto renvoie en privé. */
const PRIVATE_ONLY_COMMANDS = ['brief', 'appel', 'connecter', 'taches', 'inviter', 'exporter', 'stats'];

/** Toutes les commandes de Koto : en groupe, une commande sans @ ne le concerne que si elle en fait partie. */
const KNOWN_COMMANDS = new Set([...COMMANDS, ...GROUP_COMMANDS].map((c) => c.command).concat(['start', 'help', 'stats']));

const IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** Souvenirs archivés montrés par /memoire (tous sont dans /exporter). */
const MEMORY_ARCHIVES_SHOWN = 8;
const MAX_IMAGE_BYTES = DOCUMENT_MAX_BYTES.image;
const MAX_PDF_BYTES = DOCUMENT_MAX_BYTES.pdf;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_VOICE_SECONDS = 300;

const CONNECTED_TIPS: Record<Toolkit, string> = {
  googlecalendar: 'Essaie : « Qu’est-ce que j’ai demain ? »',
  gmail: 'Essaie : « J’ai des mails importants aujourd’hui ? »',
};

export function createBot(deps: BotDeps, bot = new Bot<KotoContext>(deps.config.telegramToken)): Bot<KotoContext> {
  const { config, store, agent, locks, log } = deps;
  const integrations = deps.integrations ?? null;
  const transcriber = deps.transcriber ?? null;
  const browserTasks = deps.browserTasks ?? null;
  const missions = deps.missions ?? null;
  const now = deps.now ?? Date.now;
  const speak = deps.synthesizer ? telegramVoiceSender({ api: bot.api, synthesizer: deps.synthesizer, store, log, now }) : null;
  const features = {
    voice: transcriber !== null,
    speech: speak !== null,
    news: deps.news !== undefined && deps.news !== null,
    weather: deps.weather !== undefined && deps.weather !== null,
    integrations: integrations !== null,
    browser: browserTasks !== null,
    calls: Boolean(deps.callUrl),
    missions: missions !== null,
  };
  const download = deps.downloadFile ?? telegramDownloader(config.telegramToken, config.telegramApiRoot);
  const limiter = new RateLimiter(8, 60_000);
  const groupAccess = createGroupAccess({ store, config, log, now, commands: KNOWN_COMMANDS, features: { weather: features.weather, missions: features.missions } });

  // Les messages d'une même conversation sont traités dans l'ordre, les conversations en parallèle.
  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  // Accès : en privé, inscription sur invitation (ou selon REGISTRATION_MODE) ; en groupe, seulement ce qui
  // s'adresse à Koto, au nom du groupe (group.ts). Les canaux sont ignorés.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') return groupAccess.middleware(ctx, next);
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    const registration = ensureUser(
      store,
      config,
      {
        telegramId: ctx.from.id,
        chatId: ctx.chat.id,
        firstName: ctx.from.first_name ?? null,
        username: ctx.from.username ?? null,
        language: ctx.from.language_code ?? null,
      },
      startPayload(ctx.message?.text),
      now(),
    );
    if (!registration.ok) {
      log.info('access refused', { telegramId: ctx.from.id, reason: registration.reason });
      await ctx.reply(rejectionText(registration, ctx.from.id));
      return;
    }
    if (registration.created) log.info('user registered', { userId: registration.user.id });
    ctx.koto = { user: registration.user, created: registration.created };
    await next();
  });

  // Commandes réservées aux conversations privées, et leurs variantes de groupe (ou un renvoi en privé).
  const dm = bot.chatType('private');
  const groups = bot.chatType(['group', 'supergroup']);

  dm.command('start', async (ctx) => {
    const { user, created } = ctx.koto!;
    if (!created) {
      await ctx.reply(`Re ${displayName(user)} 👋 Je suis là, dis-moi ce dont tu as besoin.`);
      return;
    }
    const welcome = welcomeText(user, features);
    // Gardé dans l'historique (précédé du /start, car il doit commencer par un message de la
    // personne) pour que Koto sache qu'il vient de lui demander sur quoi elle travaille.
    const at = now();
    store.addMessage(user.id, 'user', '/start', 'chat', at);
    store.addMessage(user.id, 'assistant', welcome, 'chat', at);
    await sendText(ctx.api, ctx.chat.id, welcome);
  });

  groups.command('start', async (ctx) => {
    const payer = ctx.koto!.group?.payer ?? null;
    const status = payer ? '' : `\n\n${noOwnerText(ctx.me.username, config.registrationMode)}`;
    await sendText(ctx.api, ctx.chat.id, `${groupWelcomeText(ctx.me.username, features)}${status}`);
  });

  groups.command(PRIVATE_ONLY_COMMANDS, (ctx) => ctx.reply(privateOnlyText(ctx.me.username)));

  groups.command('usage', async (ctx) => {
    const payer = ctx.koto!.group?.payer ?? null;
    await ctx.reply(
      payer
        ? `Ce groupe est rattaché à ${publicName(payer)} : nos échanges ici comptent dans son budget du jour. Le détail se voit en privé, avec /usage.`
        : noOwnerText(ctx.me.username, config.registrationMode),
    );
  });

  bot.command(['aide', 'help'], (ctx) =>
    sendText(ctx.api, ctx.chat!.id, ctx.koto!.group ? groupHelpText(ctx.me.username, features) : helpText(features)),
  );

  dm.command('appel', async (ctx) => {
    if (!deps.callUrl) {
      await ctx.reply(
        "Les appels en direct ne sont pas encore activés sur ce Koto (il lui faut une adresse HTTPS publique). En attendant, envoie-moi un message vocal : je te réponds en vocal 🎙️",
      );
      return;
    }
    await ctx.reply('Touche le bouton pour m’appeler. Ton téléphone te demandera l’accès au micro la première fois.', {
      reply_markup: new InlineKeyboard().webApp('📞 Appeler Koto', `${deps.callUrl}/appel`),
    });
  });

  bot.command('memoire', async (ctx) => {
    const { user, group } = ctx.koto!;
    const memories = store.listMemories(user.id);
    const archived = store.countArchivedMemories(user.id);
    if (memories.length === 0 && archived === 0) {
      await ctx.reply(
        group
          ? 'Je ne sais encore rien de durable sur ce groupe. Parlez-moi de vos projets en me mentionnant : je m’en souviendrai.'
          : "Je ne sais encore rien de durable sur toi. Parle-moi de ce sur quoi tu travailles, de ce qui compte pour toi : je m'en souviendrai.",
      );
      return;
    }
    const sections = MEMORY_KINDS.flatMap((kind) => {
      const items = memories.filter((m) => m.kind === kind);
      return items.length === 0 ? [] : [`**${MEMORY_KIND_LABELS[kind]}**\n${items.map((m) => `• [${m.id}] ${m.content}`).join('\n')}`];
    });
    // Les archives du ménage : hors de la mémoire active, mais visibles et restaurables (les plus récentes d'abord).
    if (archived > 0) {
      const recent = store.listArchivedMemories(user.id, MEMORY_ARCHIVES_SHOWN);
      const more = archived - recent.length;
      sections.push(
        `**🗄️ Archivés** (hors de ma mémoire active)\n${recent.map((m) => `• [${m.id}] ${m.content} _(${m.archiveReason ?? 'archivé'})_`).join('\n')}${
          more > 0 ? `\n• … et ${more} autre${more > 1 ? 's' : ''} (/exporter)` : ''
        }`,
      );
    }
    const [title, hint] = group
      ? ['🧠 **Ce que je sais du groupe**', '_Pour corriger, mentionnez-moi : « oublie le 12 », « mets à jour le 12 : … » ou « remets le 12 »._']
      : ['🧠 **Ce que je sais de toi**', '_Pour corriger : « oublie le 12 », « mets à jour le 12 : … » ou « remets le 12 »._'];
    await sendText(ctx.api, ctx.chat!.id, `${title}\n\n${sections.join('\n\n')}\n\n${hint}`);
  });

  bot.command('rappels', async (ctx) => {
    const { user, group } = ctx.koto!;
    const jobs = store.listPendingJobs(user.id, 30);
    const at = now();
    const settings = (
      group
        ? [`🌍 Fuseau du groupe : ${user.timezone}`, features.speech ? `🔊 Réponses vocales : ${GROUP_VOICE_MODE_LABELS[user.voiceReplies]}` : null]
        : [
            user.briefEnabled
              ? `☀️ Brief du matin : chaque jour à ${user.briefTime} (${user.timezone})${features.speech && user.briefVoice ? ', aussi en vocal' : ''}`
              : '☀️ Brief du matin : désactivé',
            features.news ? `📰 Veille : ${user.newsTopics ?? 'aucune (dis-moi les sujets à suivre)'}` : null,
            features.speech ? `🔊 Réponses vocales : ${VOICE_MODE_LABELS[user.voiceReplies]}` : null,
          ]
    ).filter(Boolean);
    const lines = jobs.map(
      (j) =>
        `• #${j.id} ${j.kind === 'reminder' ? '⏰' : '💬'}${features.speech && j.voice ? '🔊' : ''} ${formatRelative(j.dueAt, user.timezone, at)}` +
        `${j.repeat === 'none' ? '' : ` (${REPEAT_LABELS[j.repeat]})`} — ${j.text}`,
    );
    const body = lines.length > 0 ? lines.join('\n') : group ? 'Aucun rappel à venir pour le groupe.' : 'Aucun rappel ni relance à venir.';
    const hint = group ? '_Pour annuler, mentionnez-moi : « annule le rappel 5 »._' : '_Pour annuler : « annule le rappel 5 »._';
    await sendText(ctx.api, ctx.chat!.id, `${body}\n\n${settings.join('\n')}\n\n${hint}`);
  });

  bot.command('listes', async (ctx) => {
    const { user, group } = ctx.koto!;
    const names = [...new Set(store.listOpenItems(user.id).map((item) => item.list))];
    if (names.length === 0) {
      await ctx.reply(
        group
          ? `Aucune liste en cours pour le groupe. Dites-moi par exemple « @${ctx.me.username} ajoute charbon et brochettes à la liste de la sortie ».`
          : 'Aucune liste en cours. Dis-moi par exemple « ajoute lait et pain à ma liste de courses » ou « note dans mes tâches : appeler Rado ».',
      );
      return;
    }
    for (const name of names.slice(0, 8)) {
      const { text, keyboard } = renderList(name, store.listItems(user.id, name));
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });

  // En groupe, ctx.koto.user est le groupe : un bouton ne coche que les listes du groupe, jamais celles d'un membre.
  bot.callbackQuery(LIST_CALLBACK, async (ctx) => {
    const user = ctx.koto!.user;
    const item = store.getListItem(user.id, Number(ctx.match[1]));
    if (!item) {
      await ctx.answerCallbackQuery({ text: 'Cet élément n’existe plus.' });
      return;
    }
    store.setListItemsDone(user.id, [item.id], !item.done, now());
    await ctx.answerCallbackQuery({ text: item.done ? `Décoché : ${item.text}` : `Coché : ${item.text}` });
    const { text, keyboard } = renderList(item.list, store.listItems(user.id, item.list));
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  });

  // Missions : la liste, gratuite, avec un bouton Arrêter. En groupe, ce sont celles du groupe.
  bot.command('missions', async (ctx) => {
    const { user, group } = ctx.koto!;
    if (!missions) {
      await ctx.reply("Les missions ne sont pas activées sur ce Koto.");
      return;
    }
    const list = store.listMissions(user.id, 10);
    if (list.length === 0) {
      await ctx.reply(
        group
          ? `Aucune mission pour le groupe. Par exemple : « @${ctx.me.username} surveille la météo à Andasibe jusqu'à samedi et préviens-nous s'il doit pleuvoir ».`
          : "Aucune mission pour l'instant. Demande-moi par exemple : « Surveille le vol Tana → Paris du 4 décembre et préviens-moi s'il passe sous 600 € ».",
      );
      return;
    }
    const { text, keyboard } = renderMissions(list, user.timezone, now(), Boolean(group));
    await ctx.reply(markdownToTelegramHtml(text), { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  });

  // En groupe, ctx.koto.user est le groupe : un bouton n'atteint que ses missions, jamais celles d'un membre.
  bot.callbackQuery(MISSION_CALLBACK, async (ctx) => {
    const user = ctx.koto!.user;
    const id = Number(ctx.match[1]);
    const action = ctx.match[2];
    if (!missions) {
      await ctx.answerCallbackQuery({ text: 'Les missions sont désactivées.' });
      return;
    }
    if (action === 'stop') {
      const stopped = await locks.run(user.id, async () => missions.stop(user, id, now()));
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup().catch(() => {});
      await ctx.reply(stopped ? `⏹️ Mission #${id} arrêtée.` : 'Cette mission est déjà terminée.');
      return;
    }
    if (action === 'drop') {
      missions.dropConclusion(user, id, now());
      await ctx.answerCallbackQuery({ text: 'D’accord, je ne garde rien.' });
      await ctx.editMessageReplyMarkup().catch(() => {});
      return;
    }
    const kept = await locks.run(user.id, async () => missions.keepConclusion(user, id, now()));
    if (kept === 'full') {
      await ctx.answerCallbackQuery({ text: 'Mémoire pleine : fais-moi d’abord oublier quelque chose.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: kept === 'kept' ? 'Gardé en mémoire 🧠' : 'Déjà traité.' });
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (kept === 'kept') await ctx.reply(ctx.koto!.group ? '🧠 C’est noté dans la mémoire du groupe.' : '🧠 C’est noté dans ma mémoire (/memoire).');
  });

  // Résumé à la demande de ce qu'on a dit à Koto (24 h, ou « /resume 3 » pour 3 jours).
  bot.command('resume', async (ctx) => {
    const { user, group } = ctx.koto!;
    const days = Math.min(7, Math.max(1, Number.parseInt(ctx.match, 10) || 1));
    const since = now() - days * 86_400_000;
    const seen = store
      .listMessagesAfter(user.id, user.historyStartId)
      .filter((m) => m.role === 'user' && m.kind === 'chat' && m.createdAt >= since && !m.content.startsWith('[RÉSUMÉ'));
    if (seen.length === 0) {
      // Rien à résumer : réponse gratuite, sans appeler le modèle.
      const period = days === 1 ? '24 h' : `${days} jours`;
      await ctx.reply(group ? `Rien à résumer : personne ne m'a écrit ici depuis ${period}.` : `Rien à résumer : on ne s'est rien dit depuis ${period}.`);
      return;
    }
    if (!(await guard(ctx))) return;
    await runTurnUnchecked(ctx, summaryRequest(user, group?.speaker.name ?? null, since, seen.length));
  });

  dm.command('inviter', async (ctx) => {
    const user = ctx.koto!.user;
    const code = createInviteFor(store, user, now());
    if (!code) {
      await ctx.reply("Tu n'as plus d'invitation disponible pour le moment.");
      return;
    }
    const left = user.isAdmin ? 'illimitées (admin)' : String(store.getUserById(user.id)!.invitesLeft);
    await ctx.reply(
      `Voici un lien d'invitation à usage unique :\nhttps://t.me/${ctx.me.username}?start=${code}\n\nInvitations restantes : ${left}`,
      { link_preview_options: { is_disabled: true } },
    );
  });

  dm.command('usage', async (ctx) => {
    const user = ctx.koto!.user;
    const budget = budgetStatus(store, config, user, now());
    const text =
      budget.limitUsd === null
        ? `Aujourd'hui : ${usd(budget.spentUsd)} (pas de limite).`
        : `Aujourd'hui : ${usd(budget.spentUsd)} sur ${usd(budget.limitUsd)} (${Math.min(100, Math.round((budget.spentUsd / budget.limitUsd) * 100))} % de ton budget quotidien).`;
    await ctx.reply(text);
  });

  dm.command('exporter', async (ctx) => {
    const user = ctx.koto!.user;
    const at = now();
    const data = Buffer.from(JSON.stringify(buildExport(store, user, at), null, 2), 'utf8');
    await ctx.replyWithDocument(new InputFile(data, exportFileName(at)), {
      caption: 'Voici tout ce que je garde sur toi : profil, mémoire (archives comprises), documents reçus, listes, rappels, missions, tâches web, historique et consommation. Pour tout effacer : /oublier_tout',
    });
  });

  dm.command('stats', async (ctx) => {
    const user = ctx.koto!.user;
    if (!user.isAdmin) return;
    const since = new Date(now() - 24 * 3_600_000).toISOString().slice(0, 10);
    const { costUsd, activeUsers } = store.totalCostSince(since);
    await ctx.reply(
      `👥 ${store.countUsers()} utilisateurs\n🫂 ${store.countGroups()} groupes\n📈 ${activeUsers} actifs depuis hier\n💸 ${usd(costUsd)} dépensés depuis hier`,
    );
  });

  dm.command('brief', async (ctx) => {
    const user = ctx.koto!.user;
    if (!(await guard(ctx))) return;
    const at = now();
    const spoken = speak !== null && voiceForBrief(user);
    const [news, weather] = await Promise.all([briefNews(deps.news, user, at), briefWeather(deps.weather, user, at)]);
    await runTurnUnchecked(ctx, briefRequest(store, user, at, { news, weather, webSearch: config.webTools, spoken }), { forceVoice: spoken });
  });

  // ---------------------------------------------------------------- connexions Gmail / Agenda

  dm.command('connecter', async (ctx) => {
    const user = ctx.koto!.user;
    if (!integrations) {
      await ctx.reply("Les connexions à Gmail et Google Agenda ne sont pas activées sur ce Koto.");
      return;
    }
    let status: Record<Toolkit, boolean>;
    try {
      status = await integrations.connectionStatus(user);
      for (const toolkit of TOOLKITS) store.setConnection(user.id, toolkit, status[toolkit], now());
    } catch (err) {
      log.error('connection status failed', err, { userId: user.id });
      await ctx.reply("Je n'arrive pas à joindre le service de connexion pour l'instant. Réessaie dans un moment.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const toolkit of TOOLKITS) {
      const label = TOOLKIT_LABELS[toolkit];
      keyboard.text(status[toolkit] ? `🔌 Déconnecter ${label}` : `🔗 Connecter ${label}`, `${status[toolkit] ? 'disconnect' : 'connect'}:${toolkit}`).row();
    }
    const lines = TOOLKITS.map((toolkit) => `${status[toolkit] ? '✅' : '⚪️'} ${TOOLKIT_LABELS[toolkit]}`);
    const text = `**Tes connexions**\n${lines.join('\n')}\n\nTu autorises l'accès sur la page de Google (via Composio) et tu peux le retirer quand tu veux. Je ne vois jamais ton mot de passe, et aucun mail ni événement ne part sans ton « ✅ Confirmer ».`;
    await ctx.reply(markdownToTelegramHtml(text), { parse_mode: 'HTML', reply_markup: keyboard });
  });

  dm.callbackQuery(/^connect:(googlecalendar|gmail)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!integrations) return;
    const user = ctx.koto!.user;
    const chatId = ctx.chat.id;
    const toolkit = ctx.match[1] as Toolkit;
    const label = TOOLKIT_LABELS[toolkit];
    let attempt;
    try {
      attempt = await integrations.connect(user, toolkit);
    } catch (err) {
      log.error('connect link failed', err, { userId: user.id, toolkit });
      await ctx.reply("Je n'ai pas pu créer le lien de connexion. Réessaie dans un moment.");
      return;
    }
    await ctx.reply(`Ouvre ce lien pour autoriser ${label} (il expire dans 10 minutes). Je te préviens dès que c'est fait.`, {
      reply_markup: new InlineKeyboard().url(`🔗 Connecter ${label}`, attempt.url),
    });
    // En arrière-plan : la conversation n'attend pas que la personne termine sur la page de Google.
    void attempt.completion
      .then(async (connected) => {
        if (!connected) return;
        store.setConnection(user.id, toolkit, true, now());
        log.info('integration connected', { userId: user.id, toolkit });
        await ctx.api.sendMessage(chatId, `✅ ${label} est connecté ! ${CONNECTED_TIPS[toolkit]}`);
      })
      .catch((err) => log.error('connection follow-up failed', err, { userId: user.id, toolkit }));
  });

  dm.callbackQuery(/^disconnect:(googlecalendar|gmail)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!integrations) return;
    const user = ctx.koto!.user;
    const toolkit = ctx.match[1] as Toolkit;
    const label = TOOLKIT_LABELS[toolkit];
    try {
      const removed = await integrations.disconnect(user, toolkit);
      store.setConnection(user.id, toolkit, false, now());
      log.info('integration disconnected', { userId: user.id, toolkit });
      await ctx.reply(removed ? `🔌 ${label} est déconnecté : je n'y ai plus accès.` : `${label} n'était pas connecté.`);
    } catch (err) {
      log.error('disconnect failed', err, { userId: user.id, toolkit });
      await ctx.reply("La déconnexion n'a pas abouti. Réessaie dans un moment.");
    }
  });

  // ---------------------------------------------------------------- actions à confirmer

  dm.callbackQuery(ACTION_CALLBACK, async (ctx) => {
    const user = ctx.koto!.user;
    const actionId = Number(ctx.match[1]);
    const confirmed = ctx.match[2] === 'ok';
    if (!integrations) {
      await ctx.answerCallbackQuery({ text: 'Les intégrations sont désactivées.' });
      return;
    }
    await ctx.answerCallbackQuery(confirmed ? { text: "C'est parti…" } : undefined);
    // Les boutons disparaissent tout de suite ; la base garantit de toute façon une seule exécution.
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!confirmed) {
      const cancelled = await locks.run(user.id, async () => cancelAction(store, user, actionId, now()));
      await ctx.reply(cancelled ? "❌ Annulé : je n'ai rien fait." : 'Cette action a déjà été traitée.');
      return;
    }
    const outcome = await locks.run(user.id, () => confirmAction(store, integrations, user, actionId, now()));
    log.info('action decided', { userId: user.id, actionId, status: outcome.status });
    await ctx.reply(outcome.message);
  });

  // ---------------------------------------------------------------- tâches web

  dm.callbackQuery(TASK_CALLBACK, async (ctx) => {
    const user = ctx.koto!.user;
    const answer = ctx.match[2] as 'yes' | 'no' | 'done';
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!browserTasks?.answer(user, Number(ctx.match[1]), answer)) {
      await ctx.reply('Cette question a expiré ou a déjà reçu une réponse.');
      return;
    }
    await ctx.reply(answer === 'yes' ? '👍 Je continue.' : answer === 'done' ? 'Merci, je reprends.' : "D'accord, je m'arrête là.");
  });

  dm.command('taches', async (ctx) => {
    const user = ctx.koto!.user;
    if (!browserTasks) {
      await ctx.reply("Les tâches web ne sont pas activées sur ce Koto.");
      return;
    }
    const tasks = store.listBrowserTasks(user.id, 5);
    if (tasks.length === 0) {
      await ctx.reply("Aucune tâche web pour l'instant. Demande-moi par exemple : « Compare les prix d'un vol Tana → Paris en décembre ».");
      return;
    }
    const icons = { queued: '⏳', running: '🌐', waiting: '✋', done: '✅', failed: '⚠️', stopped: '⏹️' } as const;
    const lines = tasks.map((t) => `${icons[t.status]} #${t.id} — ${t.goal.length > 90 ? `${t.goal.slice(0, 90)}…` : t.goal}`);
    const keyboard = new InlineKeyboard();
    for (const t of tasks) if (['queued', 'running', 'waiting'].includes(t.status)) keyboard.text(`⏹️ Arrêter #${t.id}`, `btcancel:${t.id}`).row();
    await ctx.reply(`Tes dernières tâches web :\n${lines.join('\n')}`, { reply_markup: keyboard });
  });

  dm.callbackQuery(TASK_CANCEL_CALLBACK, async (ctx) => {
    const user = ctx.koto!.user;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    const cancelled = browserTasks?.cancel(user, Number(ctx.match[1])) ?? false;
    await ctx.reply(cancelled ? "⏹️ J'arrête la tâche." : 'Cette tâche est déjà terminée.');
  });

  // ---------------------------------------------------------------- effacement

  dm.command('oublier_tout', async (ctx) => {
    const owned = store.listGroupsOwnedBy(ctx.koto!.user.id).length;
    const keyboard = new InlineKeyboard()
      .text('🧹 Effacer mémoire et historique', 'wipe:data')
      .row()
      .text('🗑️ Supprimer mon compte', 'wipe:account')
      .row()
      .text('Annuler', 'wipe:cancel');
    const groupsNote =
      owned > 0
        ? `\n\nLes groupes rattachés à toi (${owned}) gardent leur propre mémoire : elle s'efface avec /oublier_tout dans chaque groupe. Si tu supprimes ton compte, ils ne sont plus rattachés à toi.`
        : '';
    await ctx.reply(
      `Que veux-tu effacer ?\n\n• Mémoire et historique (archives, documents reçus, listes et missions compris) : je repars de zéro avec toi, ton compte reste actif.\n• Compte : tout est supprimé définitivement, accès à Gmail et à l'agenda compris (il faudra une nouvelle invitation pour revenir).${groupsNote}`,
      { reply_markup: keyboard },
    );
  });

  dm.callbackQuery(/^wipe:(data|account|cancel)$/, async (ctx) => {
    const user = ctx.koto!.user;
    const choice = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    if (choice === 'cancel') {
      await ctx.reply('Ok, je ne touche à rien.');
      return;
    }
    await locks.run(user.id, async () => {
      if (choice === 'data') {
        store.wipeUserData(user.id);
        return;
      }
      // Avant de supprimer le compte, on retire aussi les accès donnés à Google.
      if (integrations) {
        const connections = store.getConnections(user.id);
        for (const toolkit of TOOLKITS) {
          if (connections[toolkit]) await integrations.disconnect(user, toolkit).catch((err) => log.error('disconnect failed', err, { userId: user.id }));
        }
      }
      store.deleteUser(user.id);
    });
    log.info(choice === 'data' ? 'user data wiped' : 'user deleted', { userId: user.id });
    await ctx.reply(
      choice === 'data'
        ? "C'est fait : j'ai effacé ma mémoire et notre historique. On repart de zéro 🙂"
        : "C'est fait : ton compte et toutes tes données sont supprimés. Merci d'avoir essayé Koto 🙏",
    );
  });

  // En groupe : la mémoire du groupe, effacée par la personne rattachée ou un admin du groupe.
  groups.command('oublier_tout', async (ctx) => {
    if (!(await canManageGroup(ctx))) {
      await ctx.reply('Seule la personne à qui ce groupe est rattaché, ou un admin du groupe, peut effacer sa mémoire.');
      return;
    }
    const keyboard = new InlineKeyboard().text('🧹 Effacer la mémoire du groupe', 'wipe:group').row().text('Annuler', 'wipe:cancel');
    await ctx.reply(
      "Effacer la mémoire du groupe ? Je supprime ce que je sais du groupe, nos échanges ici, ses listes, ses missions et ses rappels à venir. Les mémoires personnelles de chacun ne sont pas touchées.",
      { reply_markup: keyboard },
    );
  });

  groups.callbackQuery(/^wipe:(group|cancel)$/, async (ctx) => {
    const group = ctx.koto!.user;
    // N'importe quel membre peut appuyer sur le bouton : on revérifie qui appuie.
    if (!(await canManageGroup(ctx))) {
      await ctx.answerCallbackQuery({ text: 'Réservé à la personne rattachée et aux admins du groupe.' });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (ctx.match[1] === 'cancel') {
      await ctx.reply('Ok, je ne touche à rien.');
      return;
    }
    await locks.run(group.id, async () => store.wipeUserData(group.id));
    log.info('group data wiped', { groupId: group.id });
    await ctx.reply("C'est fait : j'ai effacé la mémoire du groupe, nos échanges ici, ses listes, ses missions et ses rappels. On repart de zéro 🙂");
  });

  // ---------------------------------------------------------------- messages

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await ctx.reply('Commande inconnue. Tape /aide pour voir ce que je sais faire.');
      return;
    }
    const { user, group } = ctx.koto!;
    if (!group) {
      await runTurn(ctx, { userId: user.id, kind: 'chat', text });
      return;
    }
    const said = stripBotMention(text, ctx.me.username);
    if (!said && !group.speaker.quote) {
      // Une mention seule : réponse gratuite, sans appeler le modèle.
      await ctx.reply('Oui ? Dites-moi ce dont le groupe a besoin 🙂');
      return;
    }
    await runTurn(ctx, { userId: user.id, kind: 'chat', text: frameText(group.speaker, said || '(te mentionne, sans rien ajouter)') });
  });

  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const user = ctx.koto!.user;
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media) return;
    if (!transcriber) {
      await ctx.reply("Je ne sais pas encore écouter les vocaux. Écris-moi, je réponds tout de suite 🙂");
      return;
    }
    const format = audioFormatFromMime(media.mime_type ?? (ctx.message.voice ? 'audio/ogg' : undefined));
    if (!format) {
      await ctx.reply('Je ne reconnais pas ce format audio. Envoie plutôt un message vocal Telegram 🎙️');
      return;
    }
    if (media.duration > MAX_VOICE_SECONDS) {
      await ctx.reply('Ton vocal est un peu long pour moi (5 minutes max). Tu peux le couper en plusieurs ?');
      return;
    }
    if (!(await guard(ctx))) return;

    const stopTyping = keepTyping(ctx.api, ctx.chat.id);
    let transcript;
    try {
      const audio = await download(ctx.api, media.file_id, MAX_AUDIO_BYTES);
      transcript = await transcriber.transcribe(audio, format);
      // En groupe, la transcription est payée par la personne rattachée.
      recordUsage(store, user, now(), { ...emptyUsage(), requests: 1, costUsd: transcript.costUsd });
    } catch (err) {
      log.error('transcription failed', err, { userId: user.id });
      await ctx.reply(err instanceof FileTooLarge ? 'Ce vocal est trop lourd pour moi.' : "Je n'ai pas réussi à écouter ton vocal. Tu peux réessayer ou me l'écrire ?");
      return;
    } finally {
      stopTyping();
    }
    if (!transcript.text || transcript.text === SILENCE) {
      await ctx.reply("Je n'ai rien entendu dans ce vocal 🤔 Tu peux réessayer ?");
      return;
    }
    log.info('voice transcribed', { userId: user.id, seconds: media.duration, costUsd: transcript.costUsd });
    await runTurnUnchecked(
      ctx,
      {
        userId: user.id,
        kind: 'chat',
        text: framed(ctx, `[message vocal transcrit] ${transcript.text}`),
        historyText: framed(ctx, `[vocal] ${transcript.text}`),
      },
      { spokenInput: true },
    );
  });

  bot.on('message:photo', async (ctx) => {
    const photo = ctx.message.photo.at(-1)!; // la plus grande résolution
    const caption = captionOf(ctx);
    await withAttachment(ctx, async () => {
      const data = await download(ctx.api, photo.file_id, MAX_IMAGE_BYTES);
      return {
        block: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } },
        text: caption || '(photo envoyée sans message)',
        historyText: `[photo] ${caption}`.trim(),
        document: { kind: 'photo', name: 'photo', fileId: photo.file_id },
      };
    });
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? '';
    const caption = captionOf(ctx);
    const name = doc.file_name ?? 'document';
    if (mime !== 'application/pdf' && !IMAGE_TYPES.has(mime)) {
      await ctx.reply('Je sais lire les photos et les PDF. Pour les autres fichiers, copie-moi le texte directement 🙏');
      return;
    }
    await withAttachment(ctx, async () => {
      const isPdf = mime === 'application/pdf';
      const data = await download(ctx.api, doc.file_id, isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES);
      const base64 = data.toString('base64');
      const block: BetaContentBlockParam = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, title: name }
        : { type: 'image', source: { type: 'base64', media_type: mime as ImageMediaType, data: base64 } };
      return {
        block,
        text: caption || `(fichier « ${name} » envoyé sans message)`,
        historyText: `[fichier : ${name}] ${caption}`.trim(),
        document: { kind: isPdf ? 'pdf' : 'image', name, fileId: doc.file_id },
      };
    });
  });

  bot.on('message:location', async (ctx) => {
    const { user, group } = ctx.koto!;
    if (!deps.weather) {
      await ctx.reply('Merci ! Je ne sais pas encore utiliser les positions ici.');
      return;
    }
    // Arrondie à ~1 km : assez pour la météo, sans garder l'adresse exacte.
    const { latitude, longitude } = ctx.message.location;
    const place = await deps.weather.reverse(Math.round(latitude * 100) / 100, Math.round(longitude * 100) / 100);
    const at = now();
    applySettings(store, user.id, { place }, at);
    const reply = group
      ? `📍 C'est noté : ${place.name} devient le lieu du groupe pour la météo.`
      : `📍 C'est noté : ${place.name}. Je te donnerai la météo du jour dans ton brief, et tu peux me demander « il va pleuvoir demain ? ».`;
    // Gardé dans l'historique pour que Koto sache d'où vient ce lieu.
    store.addMessage(user.id, 'user', framed(ctx, `[position partagée : ${place.name}]`), 'chat', at);
    store.addMessage(user.id, 'assistant', reply, 'chat', at);
    await ctx.reply(reply);
  });

  bot.on(['message:video', 'message:video_note'], (ctx) =>
    ctx.reply("Je ne sais pas encore regarder les vidéos. Écris-moi ou envoie un vocal 🙂"),
  );

  bot.on('message', async (ctx) => {
    // En groupe, un autocollant ou un sondage en réponse à Koto ne mérite pas d'excuse : il se tait.
    if (ctx.koto?.group) return;
    await ctx.reply('Je ne sais pas encore lire ce type de message. Écris-moi en texte 🙂');
  });

  bot.catch((err) => log.error('telegram update failed', err.error, { updateId: err.ctx.update.update_id }));

  /** En groupe, le texte transmis dit qui parle (et à quoi il répond) ; en privé, il reste tel quel. */
  function framed(ctx: KotoContext, text: string): string {
    const group = ctx.koto!.group;
    return group ? frameText(group.speaker, text) : text;
  }

  /** Légende d'une photo ou d'un fichier, sans la mention de Koto en groupe. */
  function captionOf(ctx: KotoContext): string {
    const caption = ctx.message?.caption?.trim() ?? '';
    return ctx.koto!.group ? stripBotMention(caption, ctx.me.username) : caption;
  }

  async function withAttachment(
    ctx: KotoContext,
    load: () => Promise<{ block: BetaContentBlockParam; text: string; historyText: string; document: NonNullable<TurnRequest['document']> }>,
  ): Promise<void> {
    let attachment: Awaited<ReturnType<typeof load>>;
    try {
      attachment = await load();
    } catch (err) {
      if (err instanceof FileTooLarge) {
        await ctx.reply('Ce fichier est trop lourd pour moi (5 Mo max pour une image, 20 Mo pour un PDF).');
        return;
      }
      log.error('attachment download failed', err, { userId: ctx.koto!.user.id });
      await ctx.reply("Je n'ai pas réussi à récupérer ton fichier. Tu peux réessayer ?");
      return;
    }
    await runTurn(ctx, {
      userId: ctx.koto!.user.id,
      kind: 'chat',
      text: framed(ctx, attachment.text),
      historyText: framed(ctx, attachment.historyText),
      attachments: [attachment.block],
      document: attachment.document,
    });
  }

  /** Effacer la mémoire d'un groupe : la personne rattachée, ou un admin Telegram du groupe. */
  async function canManageGroup(ctx: KotoContext): Promise<boolean> {
    const group = ctx.koto!.user;
    const person = store.getUserByTelegramId(ctx.from!.id);
    if (person && person.id === group.ownerId) return true;
    try {
      const { status } = await ctx.getChatMember(ctx.from!.id);
      return status === 'creator' || status === 'administrator';
    } catch {
      return false;
    }
  }

  /**
   * Limite de débit et budget du jour ; répond et renvoie false si on s'arrête là. En groupe, c'est le
   * budget de la personne rattachée qui compte, et sans elle rien de payant ne part.
   */
  async function guard(ctx: KotoContext): Promise<boolean> {
    const { user, group } = ctx.koto!;
    const at = now();
    const payer = group ? group.payer : user;
    if (!payer) {
      await groupAccess.notice(ctx);
      return false;
    }
    if (!limiter.allow(user.id, at)) {
      await ctx.reply('Doucement 🙂 laisse-moi quelques secondes.');
      return false;
    }
    const budget = budgetStatus(store, config, payer, at);
    if (budget.over) {
      await ctx.reply(
        group
          ? `${publicName(payer)} a atteint son budget du jour, qui paie nos échanges ici. On reprend demain 🙏`
          : `Tu as atteint ta limite d'aujourd'hui (${usd(budget.limitUsd ?? 0)}). On reprend demain 🙏`,
      );
      return false;
    }
    return true;
  }

  async function runTurn(ctx: KotoContext, request: TurnRequest): Promise<void> {
    if (await guard(ctx)) await runTurnUnchecked(ctx, request);
  }

  async function runTurnUnchecked(
    ctx: KotoContext,
    request: TurnRequest,
    voice: { spokenInput?: boolean; forceVoice?: boolean } = {},
  ): Promise<void> {
    const { user, group } = ctx.koto!;
    const chatId = ctx.chat!.id;
    // En groupe, la réponse cite le message de la personne : chacun voit à qui Koto répond.
    const reply: SendOptions =
      group && ctx.msg
        ? { replyTo: ctx.msg.message_id, ...(ctx.msg.is_topic_message ? { threadId: ctx.msg.message_thread_id } : {}) }
        : {};
    await locks.run(user.id, async () => {
      const stopTyping = keepTyping(ctx.api, chatId);
      try {
        const result = await agent(request);
        stopTyping();
        await deliverTurn(ctx.api, chatId, result, reply);
        // Réglages relus après le tour : la personne vient peut-être de demander « réponds-moi toujours en vocal ».
        const fresh = store.getUserById(user.id) ?? user;
        const wanted = voice.forceVoice || voiceForReply(fresh, { requested: result.voice ?? false, spokenInput: voice.spokenInput ?? false });
        if (speak && wanted && result.status === 'ok') await speak(fresh, result.text);
      } catch (err) {
        log.error('turn failed', err, { userId: user.id });
        await ctx.reply(errorText(err));
      } finally {
        stopTyping();
      }
    });
  }

  return bot;
}

/** Extrait le code d'invitation d'un « /start CODE » (lien t.me/<bot>?start=CODE). */
export function startPayload(text: string | undefined): string | null {
  const match = /^\/start(?:@\w+)?\s+(\S+)/.exec(text ?? '');
  return match?.[1] ?? null;
}

function rejectionText(registration: Extract<Registration, { ok: false }>, telegramId: number): string {
  switch (registration.reason) {
    case 'invite_required':
      return `Salut 👋 Koto est pour l'instant sur invitation. Demande un lien à quelqu'un qui l'utilise déjà.\n\n(Ton identifiant Telegram : ${telegramId} — utile si c'est toi qui administres ce bot.)`;
    case 'invalid_invite':
      return "Ce lien d'invitation n'est pas valide ou a déjà servi. Demande-en un nouveau 🙏";
    case 'closed':
      return "Koto n'accepte pas de nouvelles inscriptions pour le moment.";
  }
}

interface Features {
  calls?: boolean;
  voice: boolean;
  speech: boolean;
  news: boolean;
  weather: boolean;
  integrations: boolean;
  browser: boolean;
  missions?: boolean;
}

const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  off: 'jamais',
  mirror: "quand tu m'envoies un vocal",
  always: 'à chaque réponse',
};

const GROUP_VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  off: 'jamais',
  mirror: "quand on m'envoie un vocal",
  always: 'à chaque réponse',
};

function welcomeText(user: User, features: Features): string {
  const brief = user.briefEnabled ? `à ${user.briefTime}` : 'quand tu veux';
  const abilities = [
    'retenir tes projets, tes priorités et les gens importants pour toi',
    'te rappeler des choses et prendre de tes nouvelles au bon moment',
    'tenir tes listes (courses, tâches, à lire…) que tu coches d’un geste : /listes',
    `t'envoyer un brief chaque matin (${brief}, tu peux changer l'heure)${features.news ? ", avec l'actu des sujets que tu suis" : ''}`,
    features.integrations ? 'lire ton agenda et tes mails, et préparer tes réponses (rien ne part sans ton accord) : /connecter' : null,
    features.browser ? 'agir pour toi sur des sites : chercher, comparer, préparer une réservation (tu valides avant tout paiement)' : null,
    features.missions ? 'mener des missions de fond sur plusieurs jours (surveiller un prix, préparer un dossier) et ne te prévenir que s’il y a du nouveau : /missions' : null,
    features.voice && features.speech
      ? 'écouter tes messages vocaux et te répondre en vocal'
      : features.voice
        ? 'écouter tes messages vocaux'
        : null,
    features.calls ? 'm’appeler pour parler de vive voix : /appel' : null,
    'chercher sur le web, lire tes photos et tes PDF',
    'retrouver ce qu’on s’est dit et les documents que tu m’as envoyés, même il y a des mois',
    'm’occuper d’un groupe : ajoute-moi à un groupe Telegram, j’y aurai une mémoire à part',
  ].filter(Boolean);
  return `Salut ${displayName(user)} 👋 Moi c'est **Koto**, ton agent perso.

Mon truc : comprendre sur quoi tu travailles et ce qui compte pour toi, puis t'aider à avancer au quotidien. Plus on parle, mieux je te connais.

Je peux :
${abilities.map((a) => `• ${a}`).join('\n')}

Pour commencer : sur quoi tu travailles en ce moment ?`;
}

function helpText(features: Features): string {
  const examples = [
    '« Je bosse sur le lancement de mon appli, deadline fin novembre »',
    '« Rappelle-moi d\'appeler Rado demain à 10h »',
    '« Ajoute lait, œufs et pain à ma liste de courses »',
    '« J\'ai un entretien jeudi à 14h » (je prendrai de tes nouvelles après)',
    features.integrations ? '« Qu\'est-ce que j\'ai demain ? » ou « Réponds à Rado que je valide le devis »' : null,
    features.browser ? '« Trouve-moi le vol le moins cher Tana → Paris début décembre »' : null,
    features.missions ? '« Surveille le vol Tana → Paris du 4 décembre et préviens-moi s\'il passe sous 600 € » (une mission, en arrière-plan)' : null,
    features.voice ? `Un message vocal : je l'écoute et je réponds${features.speech ? ' en vocal' : ''}` : null,
    features.speech ? '« Envoie-moi le brief du matin en vocal » ou « Fais-moi un rappel vocal à 9h »' : null,
    features.news ? "« Ajoute l'actu crypto à mon brief »" : null,
    features.weather ? '« Il va pleuvoir demain ? », ou partage ta position (📎 → Position) pour la météo du brief' : null,
    'Une photo d\'une facture ou un PDF : « Explique-moi ça »',
    '« Tu te souviens de ce que Rado avait dit pour le devis ? » (je retrouve nos échanges et tes documents, même anciens)',
    'Ajoute-moi à un groupe Telegram (une sortie, un projet à plusieurs) : j\'y réponds quand on me mentionne',
  ].filter(Boolean);
  const commands = [
    '/memoire — ce que je sais de toi',
    '/rappels — tes rappels et relances',
    '/listes — tes listes, à cocher',
    features.missions ? '/missions — tes missions en arrière-plan' : null,
    '/brief — ton brief maintenant',
    features.integrations ? '/connecter — relier Gmail et Google Agenda' : null,
    features.browser ? '/taches — tes tâches web en cours' : null,
    "/inviter — inviter quelqu'un",
    features.calls ? '/appel — m’appeler pour parler de vive voix' : null,
    '/usage — ta consommation du jour',
    '/exporter — télécharger toutes tes données',
    '/oublier_tout — effacer tes données',
  ].filter(Boolean);
  return `Parle-moi normalement, comme à quelqu'un de confiance. Par exemple :\n${examples.map((e) => `• ${e}`).join('\n')}\n\nCommandes :\n${commands.join('\n')}`;
}

function usd(amount: number): string {
  return `${amount.toFixed(2).replace('.', ',')} $`;
}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    return 'Je suis un peu débordé là. Réessaie dans une minute 🙏';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Je n'arrive pas à joindre mon cerveau (problème réseau). Réessaie dans un instant.";
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "Il y a un souci de configuration de mon côté. L'admin est prévenu.";
  }
  return "Oups, quelque chose s'est mal passé de mon côté. Tu peux réessayer ?";
}

/** Affiche « en train d'écrire… » pendant que l'agent travaille (Telegram l'efface après ~5 s). */
function keepTyping(api: Api, chatId: number): () => void {
  const ping = () => void api.sendChatAction(chatId, 'typing').catch(() => {});
  ping();
  const timer = setInterval(ping, 4_500);
  return () => clearInterval(timer);
}

/**
 * Téléchargement par l'API fichiers de Telegram : sert aux fichiers qui arrivent et à open_document, qui rouvre un
 * fichier reçu il y a longtemps. Un identifiant refusé (expiré, invalide, d'un autre bot) devient FileGone.
 */
export function telegramDownloader(token: string, apiRoot: string): FileDownloader {
  return async (api, fileId, maxBytes) => {
    let file: Awaited<ReturnType<Api['getFile']>>;
    try {
      file = await api.getFile(fileId);
    } catch (err) {
      // « Bad Request: wrong file_id or the file is temporarily unavailable », ou « file is too big » (plus de 20 Mo).
      if (err instanceof GrammyError && err.error_code === 400) throw /too big/i.test(err.description) ? new FileTooLarge() : new FileGone();
      throw err;
    }
    if (file.file_size && file.file_size > maxBytes) throw new FileTooLarge();
    if (!file.file_path) throw new FileGone('Telegram ne fournit pas de chemin pour ce fichier');
    // L'URL contient le token du bot : elle n'est jamais journalisée.
    const response = await fetch(`${apiRoot}/file/bot${token}/${file.file_path}`);
    if (response.status === 404) throw new FileGone();
    if (!response.ok) throw new Error(`téléchargement Telegram : HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new FileTooLarge();
    return data;
  };
}
