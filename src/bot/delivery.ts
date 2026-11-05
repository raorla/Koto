import { GrammyError, InlineKeyboard, InputFile, type Api } from 'grammy';
import { recordUsage } from '../accounts.js';
import type { TurnResult } from '../agent/agent.js';
import type { TaskQuestion } from '../browser/agent.js';
import type { TaskNotifier } from '../browser/tasks.js';
import { renderActionPreview } from '../integrations/catalog.js';
import { END_REASON_LABELS, MISSION_ICONS, formatUsd, rhythmLabel } from '../missions/missions.js';
import type { MissionNotifier } from '../missions/runner.js';
import { toSpeechText, type Synthesizer } from '../speech.js';
import { emptyUsage, type BrowserTask, type ListItem, type Mission, type PendingAction, type Store, type User } from '../store.js';
import { formatRelative } from '../time.js';
import type { Logger } from '../util.js';
import { escapeHtml, markdownToTelegramHtml, sendText, type SendOptions } from './format.js';

/** Réponses aux questions des tâches web : « bt:<question>:yes|no|done ». */
export const TASK_CALLBACK = /^bt:(\d+):(yes|no|done)$/;
export const TASK_CANCEL_CALLBACK = /^btcancel:(\d+)$/;

/** Texte et boutons d'une question posée pendant une tâche web (texte brut : il peut citer la page). */
export function renderTaskQuestion(task: BrowserTask, questionId: number, question: TaskQuestion): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  switch (question.kind) {
    case 'confirm':
      keyboard.text('✅ Oui, vas-y', `bt:${questionId}:yes`).text('❌ Non', `bt:${questionId}:no`);
      return { text: `🌐 Tâche web #${task.id} — avant d'aller plus loin :\n\n${question.text}\n\nJe continue ?`, keyboard };
    case 'handover':
      keyboard.text("✅ C'est fait", `bt:${questionId}:done`).text('❌ Abandonner', `bt:${questionId}:no`);
      return {
        text: `🌐 Tâche web #${task.id} — j'ai besoin de toi : ${question.text}\n\nFais-le dans la fenêtre du navigateur Koto sur ton ordinateur, puis appuie sur « C'est fait ».`,
        keyboard,
      };
    case 'login':
      keyboard.text('✅ Autoriser', `bt:${questionId}:yes`).text('❌ Refuser', `bt:${questionId}:no`);
      return { text: `🔐 Tâche web #${task.id} — ${question.text}\n\nLe mot de passe est rempli par 1Password, sans passer par l'IA.`, keyboard };
  }
}

const FINISH_LABELS = { done: ['✅', 'terminée'], failed: ['⚠️', 'en échec'], stopped: ['⏹️', 'arrêtée'] } as const;

export function telegramTaskNotifier(api: Api): TaskNotifier {
  return {
    async question(user, task, questionId, question) {
      const { text, keyboard } = renderTaskQuestion(task, questionId, question);
      if (question.screenshot) {
        // Légende Telegram limitée à 1 024 caractères.
        const caption = text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
        await api.sendPhoto(user.chatId, new InputFile(question.screenshot, 'page.jpg'), { caption, reply_markup: keyboard });
      } else {
        await api.sendMessage(user.chatId, text, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });
      }
    },
    async finished(user, task, result) {
      const [icon, label] = FINISH_LABELS[result.status];
      await sendText(api, user.chatId, `${icon} **Tâche web #${task.id} ${label}**\n\n${result.summary}`);
    },
  };
}

/** Données des boutons : « act:<id>:ok » / « act:<id>:no » (Telegram limite à 64 octets). */
export const ACTION_CALLBACK = /^act:(\d+):(ok|no)$/;

/** Carte « à confirmer » : aperçu de l'action + boutons Confirmer / Annuler. */
export async function sendConfirmation(api: Api, chatId: number, action: PendingAction): Promise<void> {
  const keyboard = new InlineKeyboard().text('✅ Confirmer', `act:${action.id}:ok`).text('❌ Annuler', `act:${action.id}:no`);
  const preview = renderActionPreview(action.tool, action.args);
  try {
    await api.sendMessage(chatId, markdownToTelegramHtml(preview), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
    await api.sendMessage(chatId, preview, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  }
}

/** Envoie la réponse de l'agent, puis une carte par action à confirmer. */
export async function deliverTurn(
  api: Api,
  chatId: number,
  result: Pick<TurnResult, 'text' | 'pendingActions'>,
  options: SendOptions = {},
): Promise<void> {
  await sendText(api, chatId, result.text, options);
  for (const action of result.pendingActions) await sendConfirmation(api, chatId, action);
}

/** Case d'une liste : « li:<élément> » (cocher ou décocher). */
export const LIST_CALLBACK = /^li:(\d+)$/;
const LIST_BUTTONS = 30;

/** Une liste à cocher : les éléments à faire puis les derniers cochés, un bouton chacun. */
export function renderList(list: string, items: ListItem[]): { text: string; keyboard: InlineKeyboard } {
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const shown = [...open, ...done].slice(0, LIST_BUTTONS);
  const keyboard = new InlineKeyboard();
  for (const item of shown) keyboard.text(`${item.done ? '✅' : '⬜'} ${item.text.slice(0, 60)}`, `li:${item.id}`).row();
  const hidden = open.length + done.length - shown.length;
  const status = open.length === 0 ? 'tout est fait 🎉' : `${open.length} à faire`;
  return {
    text: `📝 <b>${escapeHtml(list)}</b> · ${status}${hidden > 0 ? `\n<i>(${hidden} autres non affichés)</i>` : ''}\nTouche un élément pour le cocher.`,
    keyboard,
  };
}

/** Boutons des missions : « ms:<id>:stop » (/missions), « ms:<id>:keep|drop » (conclusion proposée à la mémoire). */
export const MISSION_CALLBACK = /^ms:(\d+):(stop|keep|drop)$/;

const MISSION_STATUS_LABELS = { done: 'terminée', stopped: 'arrêtée', failed: 'en échec' } as const;

/** /missions : les missions en cours (un bouton Arrêter chacune), puis les dernières terminées. */
export function renderMissions(missions: Mission[], timezone: string, now: number, group: boolean): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  const blocks = missions.map((m) => {
    const runs = `${m.runs} passage${m.runs > 1 ? 's' : ''}`;
    if (m.status === 'active') {
      keyboard.text(`⏹️ Arrêter #${m.id}`, `ms:${m.id}:stop`).row();
      const until = m.deadlineAt === null ? 'sans date limite' : `jusqu'à ${formatRelative(m.deadlineAt, timezone, now)}`;
      return `${MISSION_ICONS.active} **#${m.id} · ${m.title}**\n${rhythmLabel(m.intervalMinutes)}, ${until} · ${runs} · ${formatUsd(m.costUsd)} sur ${formatUsd(m.maxCostUsd)}`;
    }
    const why = m.endReason ? ` (${END_REASON_LABELS[m.endReason]})` : '';
    const when = m.endedAt === null ? '' : `, ${formatRelative(m.endedAt, timezone, now)}`;
    return `${MISSION_ICONS[m.status]} **#${m.id} · ${m.title}**\n${MISSION_STATUS_LABELS[m.status]}${why}${when} · ${runs} · ${formatUsd(m.costUsd)}`;
  });
  const title = group ? '🎯 **Les missions du groupe**' : '🎯 **Tes missions**';
  const hint = missions.some((m) => m.status === 'active')
    ? group
      ? '_Elles ne préviennent le groupe que s’il y a du nouveau._'
      : '_Elles ne te préviennent que s’il y a du nouveau. Pour changer une consigne, dis-le-moi simplement._'
    : '';
  return { text: [title, ...blocks, hint].filter(Boolean).join('\n\n'), keyboard };
}

/** Messages des missions sur Telegram : résultats, cartes à confirmer, conclusion proposée à la mémoire. */
export function telegramMissionNotifier(api: Api, speak?: VoiceSender | null): MissionNotifier {
  return {
    send: (account, text) => sendText(api, account.chatId, text),
    confirm: (chatId, action) => sendConfirmation(api, chatId, action),
    async proposeConclusion(account, mission) {
      const keyboard = new InlineKeyboard().text('🧠 Garder en mémoire', `ms:${mission.id}:keep`).text('Non merci', `ms:${mission.id}:drop`);
      const where = account.kind === 'group' ? 'la mémoire du groupe' : 'ma mémoire';
      await api.sendMessage(account.chatId, `🧠 Je garde ceci dans ${where} ?\n\n« ${mission.conclusion ?? ''} »`, {
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    },
    ...(speak ? { speak: async (account: User, text: string) => void (await speak(account, text)) } : {}),
  };
}

export const VOICE_FAILED_TEXT ="🔇 Je n'ai pas réussi à enregistrer le vocal : la réponse écrite est juste au-dessus.";

/** Lit un texte déjà envoyé et l'envoie en message vocal. Ne lève jamais : renvoie false si le vocal n'est pas parti. */
export type VoiceSender = (user: User, text: string) => Promise<boolean>;

export function telegramVoiceSender(deps: { api: Api; synthesizer: Synthesizer; store: Store; log: Logger; now?: () => number }): VoiceSender {
  const now = deps.now ?? Date.now;
  return async (user, text) => {
    const speech = toSpeechText(text);
    if (!speech) return false; // un « 👍 » ne se lit pas
    try {
      await deps.api.sendChatAction(user.chatId, 'record_voice').catch(() => {});
      const voice = await deps.synthesizer.synthesize(speech);
      // Dans un groupe, la voix est payée par la personne à qui il est rattaché.
      recordUsage(deps.store, user, now(), { ...emptyUsage(), requests: 1, costUsd: voice.costUsd });
      await deps.api.sendVoice(user.chatId, new InputFile(voice.audio, 'koto.mp3'), { duration: voice.seconds });
      deps.log.info('voice reply', { userId: user.id, chars: speech.length, seconds: voice.seconds, costUsd: Number(voice.costUsd.toFixed(5)) });
      return true;
    } catch (err) {
      deps.log.error('voice reply failed', err, { userId: user.id });
      await deps.api.sendMessage(user.chatId, VOICE_FAILED_TEXT).catch(() => {});
      return false;
    }
  };
}
