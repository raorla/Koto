import { describe, expect, it } from 'vitest';
import { formatRelative, localDay, nextDailyAt, nextOccurrence, parseLocalDateTime } from '../src/time.js';
import { NOW } from './helpers.js';

const TANA = 'Indian/Antananarivo';

describe('time', () => {
  it('lit une heure murale dans le fuseau de la personne', () => {
    expect(parseLocalDateTime('2026-10-16T09:00', TANA)).toBe(Date.parse('2026-10-16T06:00:00Z'));
    expect(parseLocalDateTime('2026-10-16T09:00', 'Europe/Paris')).toBe(Date.parse('2026-10-16T07:00:00Z'));
    expect(parseLocalDateTime('16/10/2026 9h', TANA)).toBeNull();
    expect(parseLocalDateTime('2026-02-30T09:00', TANA)).toBeNull();
  });

  it("garde l'heure murale au passage à l'heure d'hiver", () => {
    const saturday9 = parseLocalDateTime('2026-10-24T09:00', 'Europe/Paris')!;
    const next = nextOccurrence(saturday9, 'daily', 'Europe/Paris', saturday9)!;
    expect(next).toBe(parseLocalDateTime('2026-10-25T09:00', 'Europe/Paris'));
    expect(next - saturday9).toBe(25 * 3_600_000);
  });

  it('saute le week-end pour les répétitions en semaine', () => {
    const friday = parseLocalDateTime('2026-10-16T08:00', TANA)!;
    expect(nextOccurrence(friday, 'weekdays', TANA, friday)).toBe(parseLocalDateTime('2026-10-19T08:00', TANA));
  });

  it("rattrape la prochaine occurrence future après une coupure", () => {
    const old = parseLocalDateTime('2026-10-01T07:30', TANA)!;
    expect(nextOccurrence(old, 'daily', TANA, NOW)).toBe(parseLocalDateTime('2026-10-15T07:30', TANA));
    expect(nextOccurrence(old, 'none', TANA, NOW)).toBeNull();
  });

  it("calcule l'heure du prochain brief", () => {
    expect(nextDailyAt('07:30', TANA, NOW)).toBe(parseLocalDateTime('2026-10-15T07:30', TANA));
    expect(nextDailyAt('21:00', TANA, NOW)).toBe(parseLocalDateTime('2026-10-14T21:00', TANA));
  });

  it('formate en français et calcule le jour local', () => {
    expect(formatRelative(parseLocalDateTime('2026-10-15T09:00', TANA)!, TANA, NOW)).toBe('demain à 09:00');
    expect(localDay(NOW, TANA)).toBe('2026-10-14');
    expect(localDay(NOW, 'Pacific/Kiritimati')).toBe('2026-10-15');
  });
});
