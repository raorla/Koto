import { GrammyError, type Api } from 'grammy';

/** Telegram refuse les messages de plus de 4096 caractères ; on garde de la marge pour le HTML. */
const CHUNK_CHARS = 3500;
const TELEGRAM_MAX = 4096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convertit le petit Markdown que Koto écrit (gras, italique, code, liens, listes) vers le
 * sous-ensemble HTML de Telegram. Tout le reste est échappé.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = markdown.replace(/\r\n/g, '\n');
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code: string) => hold(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
    hold(`<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(label)}</a>`),
  );

  s = escapeHtml(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^(\s*)[-*•]\s+/gm, '$1• ');
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(?=\S)([^\n]*?\S)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>');

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
}

/** Découpe un texte trop long, de préférence entre paragraphes, puis entre lignes. */
export function splitForTelegram(text: string, max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface SendOptions {
  /** Message auquel répondre (en groupe : celui de la personne qui a parlé), sur le premier morceau. */
  replyTo?: number;
  /** Sujet d'un supergroupe à sujets (forum). */
  threadId?: number;
}

/** Envoie un texte en HTML Telegram, et retombe sur du texte brut si Telegram refuse le formatage. */
export async function sendText(api: Api, chatId: number, text: string, options: SendOptions = {}): Promise<void> {
  let first = true;
  for (const chunk of splitForTelegram(text)) {
    const extra = {
      link_preview_options: { is_disabled: true },
      ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
      ...(first && options.replyTo !== undefined ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } } : {}),
    };
    first = false;
    const html = markdownToTelegramHtml(chunk);
    if (html.length <= TELEGRAM_MAX) {
      try {
        await api.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra });
        continue;
      } catch (err) {
        // 400 « can't parse entities » : le HTML généré ne plaît pas à Telegram, on envoie brut.
        if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
      }
    }
    await api.sendMessage(chatId, chunk, extra);
  }
}
