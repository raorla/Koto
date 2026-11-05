import { DateTime } from 'luxon';

export const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type Repeat = (typeof REPEATS)[number];

export const REPEAT_LABELS: Record<Repeat, string> = {
  none: 'une fois',
  daily: 'tous les jours',
  weekdays: 'du lundi au vendredi',
  weekly: 'chaque semaine',
  monthly: 'chaque mois',
};

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimezone(tz: string): boolean {
  return tz.length > 0 && DateTime.now().setZone(tz).isValid;
}

export function isValidHHMM(value: string): boolean {
  return HHMM.test(value);
}

/** "2026-10-16T09:00" lu comme heure murale dans `tz` → epoch ms (null si invalide). */
export function parseLocalDateTime(value: string, tz: string): number | null {
  if (!LOCAL_DATETIME.test(value)) return null;
  const dt = DateTime.fromISO(value, { zone: tz });
  return dt.isValid ? dt.toMillis() : null;
}

/** "2026-10-16" lu comme un jour local de `tz` → début de ce jour en epoch ms (null si invalide). */
export function parseLocalDate(value: string, tz: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const dt = DateTime.fromISO(value, { zone: tz });
  return dt.isValid ? dt.startOf('day').toMillis() : null;
}

/** Prochaine occurrence strictement après `nowMs`, en gardant l'heure murale du fuseau. */
export function nextOccurrence(fromMs: number, repeat: Repeat, tz: string, nowMs: number): number | null {
  if (repeat === 'none') return null;
  let dt = DateTime.fromMillis(fromMs, { zone: tz });
  do {
    switch (repeat) {
      case 'daily':
        dt = dt.plus({ days: 1 });
        break;
      case 'weekly':
        dt = dt.plus({ weeks: 1 });
        break;
      case 'monthly':
        dt = dt.plus({ months: 1 });
        break;
      case 'weekdays':
        do dt = dt.plus({ days: 1 });
        while (dt.weekday > 5);
        break;
    }
  } while (dt.toMillis() <= nowMs);
  return dt.toMillis();
}

/** Prochain passage à HH:MM (heure locale) strictement après `nowMs`. */
export function nextDailyAt(hhmm: string, tz: string, nowMs: number): number {
  const match = HHMM.exec(hhmm);
  if (!match) throw new Error(`Heure invalide : ${hhmm}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const today = DateTime.fromMillis(nowMs, { zone: tz });
  let dt = today.set({ hour, minute, second: 0, millisecond: 0 });
  if (dt.toMillis() <= nowMs) dt = today.plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
  return dt.toMillis();
}

/** Horodatage préfixé à chaque message utilisateur, ex: "mar. 14 oct. 2026, 19:52". */
export function formatStamp(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).setLocale('fr').toFormat('ccc d LLL yyyy, HH:mm');
}

/** Date lisible et absolue (stable dans le temps, donc bonne pour le cache de prompt). */
export function formatDateTime(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).setLocale('fr').toFormat("cccc d LLLL yyyy 'à' HH:mm");
}

/** Version courte et relative pour les messages Telegram ("aujourd'hui à 18:00", "demain à 09:00"). */
export function formatRelative(ms: number, tz: string, nowMs: number): string {
  const dt = DateTime.fromMillis(ms, { zone: tz }).setLocale('fr');
  const now = DateTime.fromMillis(nowMs, { zone: tz });
  const days = Math.round(dt.startOf('day').diff(now.startOf('day'), 'days').days);
  const time = dt.toFormat('HH:mm');
  if (days === 0) return `aujourd'hui à ${time}`;
  if (days === 1) return `demain à ${time}`;
  if (days > 1 && days < 7) return `${dt.toFormat('cccc')} à ${time}`;
  return `${dt.toFormat('ccc d LLL yyyy')} à ${time}`;
}

/** Jour local "YYYY-MM-DD" — sert de clé au budget quotidien. */
export function localDay(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toISODate() ?? new Date(ms).toISOString().slice(0, 10);
}

/** Bornes [début, fin[ du jour local contenant `ms`. */
export function localDayBounds(ms: number, tz: string): { start: number; end: number } {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  return { start: dt.startOf('day').toMillis(), end: dt.endOf('day').toMillis() + 1 };
}
