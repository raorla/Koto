// Authentification de la page d'appel : Telegram signe les données de lancement de la mini-app
// (initData) avec le token du bot. Une requête sans signature valide et récente est refusée.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebAppUser {
  id: number;
  firstName: string | null;
  username: string | null;
  languageCode: string | null;
}

/** Au-delà, il faut rouvrir la page depuis Telegram (un appel ne dure pas une journée). */
export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function signature(params: URLSearchParams, botToken: string): Buffer {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString(params)).digest();
}

/** Vérifie l'initData de Telegram : la personne qui appelle, ou null si la signature est fausse ou trop vieille. */
export function verifyInitData(initData: string, botToken: string, now: number, maxAgeSec = INIT_DATA_MAX_AGE_SEC): WebAppUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!timingSafeEqual(signature(params, botToken), Buffer.from(hash, 'hex'))) return null;

  const age = now / 1000 - Number(params.get('auth_date'));
  if (!Number.isFinite(age) || age > maxAgeSec || age < -300) return null;
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: unknown; first_name?: string; username?: string; language_code?: string } | null;
    if (!user || typeof user.id !== 'number') return null;
    return { id: user.id, firstName: user.first_name ?? null, username: user.username ?? null, languageCode: user.language_code ?? null };
  } catch {
    return null;
  }
}

/** Signe des données comme le fait Telegram (sert aux tests). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  params.set('hash', signature(params, botToken).toString('hex'));
  return params.toString();
}
