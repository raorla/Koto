import { describe, expect, it } from 'vitest';
import { budgetStatus, createInviteFor, ensureUser, type TelegramProfile } from '../src/accounts.js';
import { emptyUsage } from '../src/store.js';
import { parseLocalDateTime } from '../src/time.js';
import { NOW, makeConfig, makeStore, makeUser } from './helpers.js';

const profile = (telegramId: number): TelegramProfile => ({
  telegramId,
  chatId: telegramId,
  firstName: 'Ana',
  username: 'ana',
  language: 'fr',
});

function registerAdmin(store = makeStore(), config = makeConfig()) {
  const result = ensureUser(store, config, profile(1000), null, NOW);
  if (!result.ok) throw new Error('admin non inscrit');
  return { store, config, admin: result.user };
}

describe('inscription', () => {
  it("laisse entrer un admin sans invitation et programme son brief", () => {
    const { store, admin } = registerAdmin();
    expect(admin.isAdmin).toBe(true);
    expect(store.getBriefJob(admin.id)).toMatchObject({
      repeat: 'daily',
      dueAt: parseLocalDateTime('2026-10-15T07:30', 'Indian/Antananarivo'),
    });
  });

  it('exige une invitation valide, à usage unique', () => {
    const { store, config, admin } = registerAdmin();
    expect(ensureUser(store, config, profile(2), null, NOW)).toEqual({ ok: false, reason: 'invite_required' });
    expect(ensureUser(store, config, profile(2), 'NOPE', NOW)).toEqual({ ok: false, reason: 'invalid_invite' });

    const code = createInviteFor(store, admin, NOW)!;
    const guest = ensureUser(store, config, profile(2), code.toLowerCase(), NOW);
    expect(guest).toMatchObject({ ok: true, created: true, user: { invitedBy: admin.id, isAdmin: false } });

    expect(ensureUser(store, config, profile(3), code, NOW)).toEqual({ ok: false, reason: 'invalid_invite' });
    expect(ensureUser(store, config, profile(2), null, NOW)).toMatchObject({ ok: true, created: false });
  });

  it('limite le nombre d’invitations par personne (pas pour les admins)', () => {
    const { store, config, admin } = registerAdmin(makeStore(), makeConfig({ invitesPerUser: 1 }));
    const guest = ensureUser(store, config, profile(2), createInviteFor(store, admin, NOW), NOW);
    if (!guest.ok) throw new Error('invité non inscrit');
    expect(createInviteFor(store, guest.user, NOW)).toBeTypeOf('string');
    expect(createInviteFor(store, store.getUserById(guest.user.id)!, NOW)).toBeNull();
    expect(createInviteFor(store, admin, NOW)).toBeTypeOf('string');
  });

  it('respecte les modes ouvert et fermé', () => {
    const store = makeStore();
    expect(ensureUser(store, makeConfig({ registrationMode: 'closed' }), profile(2), null, NOW)).toEqual({ ok: false, reason: 'closed' });
    expect(ensureUser(store, makeConfig({ registrationMode: 'open' }), profile(2), null, NOW)).toMatchObject({ ok: true, created: true });
  });
});

describe('budget quotidien', () => {
  it('bloque au-delà du budget du jour local, jamais un admin', () => {
    const store = makeStore();
    const config = makeConfig({ dailyBudgetUsd: 0.1 });
    const user = makeUser(store);
    store.addUsage(user.id, '2026-10-14', { ...emptyUsage(), costUsd: 0.12 });
    expect(budgetStatus(store, config, user, NOW)).toMatchObject({ over: true, limitUsd: 0.1 });
    expect(budgetStatus(store, config, user, NOW + 86_400_000).over).toBe(false);

    const admin = makeUser(store, { isAdmin: true });
    store.addUsage(admin.id, '2026-10-14', { ...emptyUsage(), costUsd: 5 });
    expect(budgetStatus(store, config, admin, NOW)).toMatchObject({ over: false, limitUsd: null });
  });
});
