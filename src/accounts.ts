import type { Config } from './config.js';
import type { Store, UsageTotals, User, UserSettingsPatch } from './store.js';
import { localDay, nextDailyAt } from './time.js';

export interface TelegramProfile {
  telegramId: number;
  chatId: number;
  firstName: string | null;
  username: string | null;
  language: string | null;
}

export type Registration =
  | { ok: true; user: User; created: boolean }
  | { ok: false; reason: 'invite_required' | 'invalid_invite' | 'closed' };

class InviteAlreadyUsed extends Error {}

/**
 * Retrouve l'utilisateur, ou l'inscrit si les règles d'accès le permettent :
 * admins toujours, sinon selon REGISTRATION_MODE (invitation à usage unique par défaut).
 */
export function ensureUser(
  store: Store,
  config: Config,
  profile: TelegramProfile,
  startPayload: string | null,
  now: number,
): Registration {
  const isAdmin = config.adminTelegramIds.includes(profile.telegramId);

  const existing = store.getUserByTelegramId(profile.telegramId);
  if (existing) {
    store.touchUser(existing.id, profile);
    if (isAdmin !== existing.isAdmin) store.setAdmin(existing.id, isAdmin);
    return { ok: true, user: store.getUserById(existing.id)!, created: false };
  }

  const code = startPayload?.trim().toUpperCase() || null;
  const needsInvite = !isAdmin && config.registrationMode === 'invite';
  if (!isAdmin && config.registrationMode === 'closed') return { ok: false, reason: 'closed' };
  if (needsInvite && !code) return { ok: false, reason: 'invite_required' };
  if (needsInvite && !store.inviteIsAvailable(code!)) return { ok: false, reason: 'invalid_invite' };

  try {
    const user = store.transaction(() => {
      const created = store.createUser(
        {
          ...profile,
          timezone: config.defaultTimezone,
          briefTime: config.defaultBriefTime,
          isAdmin,
          invitesLeft: isAdmin ? 0 : config.invitesPerUser,
          invitedBy: needsInvite ? store.invitedBy(code!) : null,
        },
        now,
      );
      // Deux personnes qui utilisent le même lien en même temps : une seule passe.
      if (needsInvite && !store.redeemInvite(code!, created.id, now)) throw new InviteAlreadyUsed();
      scheduleBrief(store, created, now);
      return created;
    });
    return { ok: true, user, created: true };
  } catch (err) {
    if (err instanceof InviteAlreadyUsed) return { ok: false, reason: 'invalid_invite' };
    throw err;
  }
}

/** (Re)programme le brief quotidien selon les réglages actuels de l'utilisateur. */
export function scheduleBrief(store: Store, user: User, now: number): void {
  store.cancelBriefJobs(user.id);
  if (!user.briefEnabled) return;
  store.addJob(
    user.id,
    { kind: 'brief', text: 'brief du matin', dueAt: nextDailyAt(user.briefTime, user.timezone, now), repeat: 'daily' },
    now,
  );
}

/** Applique des réglages déjà validés et reprogramme le brief si besoin. */
export function applySettings(store: Store, userId: number, patch: UserSettingsPatch, now: number): User {
  const user = store.updateUserSettings(userId, patch);
  if (patch.timezone !== undefined || patch.briefTime !== undefined || patch.briefEnabled !== undefined) {
    scheduleBrief(store, user, now);
  }
  return user;
}

export function displayName(user: User): string {
  return user.displayName ?? user.firstName ?? (user.username ? `@${user.username}` : 'toi');
}

export interface BudgetStatus {
  spentUsd: number;
  /** null = illimité (admins ou budget à 0). */
  limitUsd: number | null;
  over: boolean;
}

export function budgetStatus(store: Store, config: Config, user: User, now: number): BudgetStatus {
  const spentUsd = store.getUsage(user.id, localDay(now, user.timezone)).costUsd;
  const limitUsd = user.isAdmin || config.dailyBudgetUsd === 0 ? null : config.dailyBudgetUsd;
  return { spentUsd, limitUsd, over: limitUsd !== null && spentUsd >= limitUsd };
}

/**
 * Qui paie les tours d'un compte : la personne elle-même, ou, pour un groupe, la personne inscrite
 * à qui il est rattaché (null tant que personne ne l'est : rien de payant ne part alors).
 */
export function payerFor(store: Store, account: User): User | null {
  if (account.kind === 'person') return account;
  const owner = account.ownerId === null ? null : store.getUserById(account.ownerId);
  return owner?.kind === 'person' ? owner : null;
}

/** Ajoute un coût au budget du jour de qui paie (pour un groupe : la personne rattachée). */
export function recordUsage(store: Store, account: User, now: number, usage: UsageTotals): void {
  const payer = payerFor(store, account) ?? account;
  store.addUsage(payer.id, localDay(now, payer.timezone), usage);
}

/** Crée un code d'invitation si l'utilisateur en a encore (illimité pour les admins). */
export function createInviteFor(store: Store, user: User, now: number): string | null {
  return store.transaction(() => {
    if (!user.isAdmin && !store.takeInvite(user.id)) return null;
    return store.createInvite(user.id, now);
  });
}
