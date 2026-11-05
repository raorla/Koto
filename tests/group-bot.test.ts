// Le bot grammY réel dans un groupe Telegram (API interceptée) : accès, rattachement, budget, isolation.
import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { emptyUsage } from '../src/store.js';
import { NOW, makeConfig } from './helpers.js';
import {
  BOT_INFO,
  botMembershipUpdate,
  buttons,
  callbackUpdate,
  groupCallbackUpdate,
  groupServiceUpdate,
  groupTextUpdate,
  setupBot,
  textUpdate,
  type RepliedMessage,
  type SetupOptions,
} from './support/bot.js';

const ANA = 6001; // inscrite sur Koto
const BOB = 6002; // membre du groupe, pas inscrit
const CARL = 6003; // membre du groupe, pas inscrit
const GROUP = -100777;

/** Ana s'inscrit en privé (inscription ouverte) ; tout le reste se passe dans le groupe. */
async function withAna(options: SetupOptions = {}, config = makeConfig({ registrationMode: 'open' })) {
  const harness = setupBot(config, options);
  await harness.bot.handleUpdate(textUpdate(ANA, '/start'));
  const ana = harness.store.getUserByTelegramId(ANA)!;
  const toGroup = () => harness.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === GROUP);
  const groupTexts = () => toGroup().map((c) => String(c.payload.text));
  const answers = () => harness.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.payload.text));
  return { ...harness, ana, toGroup, groupTexts, answers };
}

/** Vocal envoyé dans le groupe en réponse à un message. */
function groupVoiceUpdate(fromId: number, firstName: string, replyTo: RepliedMessage): Update {
  const update = groupTextUpdate(GROUP, fromId, '', { firstName, replyTo });
  const { text: _text, ...message } = update.message!;
  return { ...update, message: { ...message, voice: { file_id: 'v1', file_unique_id: 'u1', duration: 4, mime_type: 'audio/ogg', file_size: 1_000 } } } as Update;
}

describe('groupes — à qui Koto répond', () => {
  it('ignore ce qui ne lui est pas adressé, sans rien créer ni dépenser', async () => {
    const { bot, store, requests, toGroup } = await withAna();

    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, 'On part à quelle heure samedi ?'));
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/sondage samedi ou dimanche', { firstName: 'Bob' }));
    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '/listes@autre_bot'));
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, 'Je te réponds tout de suite', { firstName: 'Bob', replyTo: { fromId: ANA, firstName: 'Ana', text: 'Bob ?' } }));

    expect(requests).toHaveLength(0);
    expect(toGroup()).toHaveLength(0);
    expect(store.getGroupByChatId(GROUP)).toBeNull();
  });

  it('répond quand on le mentionne, au nom du groupe, en disant qui parle et en citant son message', async () => {
    const { bot, store, ana, requests, toGroup, groupTexts } = await withAna();
    const update = groupTextUpdate(GROUP, ANA, '@koto_test_bot on part à Andasibe samedi à 6 h');

    await bot.handleUpdate(update);

    const group = store.getGroupByChatId(GROUP)!;
    expect(group).toMatchObject({ kind: 'group', ownerId: ana.id, firstName: 'Sortie Andasibe' });
    expect(requests).toEqual([{ userId: group.id, kind: 'chat', text: 'Ana : on part à Andasibe samedi à 6 h' }]);
    expect(groupTexts()).toEqual([expect.stringContaining('rattaché à Ana'), 'écho : Ana : on part à Andasibe samedi à 6 h']);
    expect(toGroup().at(-1)!.payload.reply_parameters).toEqual({ message_id: update.message!.message_id, allow_sending_without_reply: true });
    // Parler dans un groupe ne touche pas au compte personnel : ses rappels continuent d'arriver en privé.
    expect(store.getUserByTelegramId(ANA)!.chatId).toBe(ANA);
  });

  it('répond à qui répond à l’un de ses messages, et cite le message d’un autre membre', async () => {
    const { bot, store, requests } = await withAna();
    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '@koto_test_bot salut'));

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, 'et s’il pleut ?', { firstName: 'Bob', replyTo: { fromId: BOT_INFO.id, text: 'Départ samedi à 6 h' } }));
    await bot.handleUpdate(
      groupTextUpdate(GROUP, BOB, '@koto_test_bot tu en penses quoi ?', { firstName: 'Bob', replyTo: { fromId: CARL, firstName: 'Carl', text: 'Moi je préfère dimanche' } }),
    );

    expect(requests.slice(-2).map((r) => r.text)).toEqual([
      'Bob (en réponse à ton message : « Départ samedi à 6 h ») : et s’il pleut ?',
      'Bob (en réponse à Carl : « Moi je préfère dimanche ») : tu en penses quoi ?',
    ]);
    expect(new Set(requests.map((r) => r.userId))).toEqual(new Set([store.getGroupByChatId(GROUP)!.id]));
  });

  it('une mention seule ne coûte rien', async () => {
    const { bot, requests, groupTexts } = await withAna();
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '@koto_test_bot', { firstName: 'Bob' }));

    expect(requests).toHaveLength(0);
    expect(groupTexts().at(-1)).toContain('Oui ?');
  });

  it('écoute un vocal en réponse à l’un de ses messages, aux frais de la personne rattachée', async () => {
    const transcriber = { transcribe: vi.fn(async () => ({ text: 'Rappelez-nous de prendre les K-way', costUsd: 0.0004 })) };
    const { bot, store, ana, requests } = await withAna({ transcriber, downloadFile: async () => Buffer.from('OggS') });
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));
    const group = store.getGroupByChatId(GROUP)!;

    await bot.handleUpdate(groupVoiceUpdate(BOB, 'Bob', { fromId: BOT_INFO.id, text: 'Salut !' }));

    expect(requests).toEqual([
      {
        userId: group.id,
        kind: 'chat',
        text: 'Bob (en réponse à ton message : « Salut ! ») : [message vocal transcrit] Rappelez-nous de prendre les K-way',
        historyText: 'Bob (en réponse à ton message : « Salut ! ») : [vocal] Rappelez-nous de prendre les K-way',
      },
    ]);
    expect(store.getUsage(ana.id, '2026-10-14').costUsd).toBeCloseTo(0.0004);
    expect(store.getUsage(group.id, '2026-10-14').costUsd).toBe(0);
  });
});

describe('groupes — rattachement et budget', () => {
  it('rattache le groupe à la personne inscrite qui y ajoute Koto, et se présente', async () => {
    const { bot, store, ana, groupTexts } = await withAna();

    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));

    expect(store.getGroupByChatId(GROUP)).toMatchObject({ ownerId: ana.id, timezone: ana.timezone, briefEnabled: false });
    expect(groupTexts()).toHaveLength(1);
    expect(groupTexts()[0]).toContain('<b>Koto</b>');
    expect(groupTexts()[0]).toContain('Ce groupe a sa propre mémoire');
    expect(groupTexts()[0]).toContain('rattaché à Ana');
  });

  it('sans personne inscrite, ne dépense rien et l’explique une fois ; la première personne inscrite qui parle le rattache', async () => {
    const { bot, store, ana, requests, groupTexts } = await withAna();

    await bot.handleUpdate(botMembershipUpdate(GROUP, BOB, 'added'));
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '@koto_test_bot salut', { firstName: 'Bob' }));
    await bot.handleUpdate(groupTextUpdate(GROUP, CARL, '@koto_test_bot tu es là ?', { firstName: 'Carl' }));

    expect(requests).toHaveLength(0);
    expect(store.getGroupByChatId(GROUP)).toBeNull();
    expect(groupTexts()).toHaveLength(1); // la présentation, avec l'explication ; ensuite, silence pendant 10 min
    expect(groupTexts()[0]).toContain('une personne inscrite sur Koto');

    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '@koto_test_bot organise-nous la sortie'));

    expect(store.getGroupByChatId(GROUP)!.ownerId).toBe(ana.id);
    expect(requests.map((r) => r.text)).toEqual(['Ana : organise-nous la sortie']);
  });

  it('le budget du jour de la personne rattachée paie le groupe : au-delà, le groupe attend demain', async () => {
    const { bot, store, ana, requests, groupTexts } = await withAna({}, makeConfig({ registrationMode: 'open', dailyBudgetUsd: 0.1 }));
    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '@koto_test_bot salut'));
    expect(requests).toHaveLength(1);

    store.addUsage(ana.id, '2026-10-14', { ...emptyUsage(), costUsd: 0.2 });
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '@koto_test_bot et maintenant ?', { firstName: 'Bob' }));

    expect(requests).toHaveLength(1);
    expect(groupTexts().at(-1)).toContain('Ana a atteint son budget du jour');
  });

  it('renvoie en privé pour ce qui est personnel, et dit qui paie', async () => {
    const { bot, store, groupTexts } = await withAna();
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));

    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '/inviter'));
    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '/brief@koto_test_bot'));
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/usage', { firstName: 'Bob' }));

    const [invite, brief, usage] = groupTexts().slice(-3);
    expect(invite).toContain('écris-moi en privé');
    expect(brief).toContain('écris-moi en privé');
    expect(usage).toContain('rattaché à Ana');
    expect(store.getUserByTelegramId(ANA)!.invitesLeft).toBe(3);
  });

  it('Koto retiré : groupe détaché et rappels annulés ; ré-ajouté par une autre personne inscrite, il lui est rattaché', async () => {
    const { bot, store, ana } = await withAna();
    await bot.handleUpdate(textUpdate(BOB, '/start')); // Bob s'inscrit à son tour, en privé
    const bob = store.getUserByTelegramId(BOB)!;
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));
    const group = store.getGroupByChatId(GROUP)!;
    expect(group.ownerId).toBe(ana.id);
    store.addJob(group.id, { kind: 'reminder', text: 'Réunion de la sortie', dueAt: NOW + 3_600_000, repeat: 'weekly' }, NOW);

    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'removed'));

    expect(store.getUserById(group.id)!.ownerId).toBeNull();
    expect(store.listPendingJobs(group.id)).toHaveLength(0);

    await bot.handleUpdate(botMembershipUpdate(GROUP, BOB, 'added'));

    expect(store.getUserById(group.id)!.ownerId).toBe(bob.id);
  });

  it('la personne rattachée quitte le groupe : il est détaché, et le groupe le sait', async () => {
    const { bot, store, ana, requests, groupTexts } = await withAna();
    await bot.handleUpdate(groupTextUpdate(GROUP, ANA, '@koto_test_bot salut'));
    const group = store.getGroupByChatId(GROUP)!;

    await bot.handleUpdate(groupServiceUpdate(GROUP, BOB, { left_chat_member: { id: BOB, is_bot: false, first_name: 'Bob' } }));
    expect(store.getUserById(group.id)!.ownerId).toBe(ana.id);

    await bot.handleUpdate(groupServiceUpdate(GROUP, ANA, { left_chat_member: { id: ANA, is_bot: false, first_name: 'Ana' } }));
    expect(store.getUserById(group.id)!.ownerId).toBeNull();
    expect(groupTexts().at(-1)).toContain('Ana a quitté le groupe');

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '@koto_test_bot tu es là ?', { firstName: 'Bob' }));
    expect(requests).toHaveLength(1);
    expect(groupTexts().at(-1)).toContain('une personne inscrite sur Koto');
  });

  it('passage en supergroupe : même compte, même mémoire, nouvel id', async () => {
    const { bot, store, requests } = await withAna();
    const BASIC = -4242;
    await bot.handleUpdate(groupTextUpdate(BASIC, ANA, '@koto_test_bot salut'));
    const group = store.getGroupByChatId(BASIC)!;
    store.addMemory(group.id, { kind: 'project', content: 'Sortie à Andasibe', importance: 3 }, NOW);

    await bot.handleUpdate(groupServiceUpdate(BASIC, ANA, { migrate_to_chat_id: GROUP }));
    await bot.handleUpdate(groupServiceUpdate(GROUP, ANA, { migrate_from_chat_id: BASIC }));
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '@koto_test_bot on en est où ?', { firstName: 'Bob' }));

    expect(store.getGroupByChatId(BASIC)).toBeNull();
    expect(store.getGroupByChatId(GROUP)).toMatchObject({ id: group.id, chatId: GROUP });
    expect(store.listMemories(group.id)).toHaveLength(1);
    expect(requests.at(-1)!.userId).toBe(group.id);
    expect(store.countGroups()).toBe(1);
  });
});

describe('groupes — données séparées', () => {
  it('en groupe, /memoire et /rappels ne montrent que le groupe ; en privé, que la personne', async () => {
    const { bot, store, ana, calls, groupTexts } = await withAna();
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));
    const group = store.getGroupByChatId(GROUP)!;
    store.addMemory(group.id, { kind: 'project', content: 'Sortie à Andasibe', importance: 3 }, NOW);
    store.addMemory(ana.id, { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, NOW);
    store.addJob(group.id, { kind: 'reminder', text: 'Départ pour Andasibe', dueAt: NOW + 3_600_000, repeat: 'none' }, NOW);
    store.addJob(ana.id, { kind: 'reminder', text: 'Payer la JIRAMA', dueAt: NOW + 3_600_000, repeat: 'none' }, NOW);

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/memoire', { firstName: 'Bob' }));
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/rappels@koto_test_bot', { firstName: 'Bob' }));

    const [memory, reminders] = groupTexts().slice(-2);
    expect(memory).toContain('Ce que je sais du groupe');
    expect(memory).toContain('Sortie à Andasibe');
    expect(memory).not.toContain('ENAM');
    expect(reminders).toContain('Départ pour Andasibe');
    expect(reminders).toContain('Fuseau du groupe');
    expect(reminders).not.toContain('JIRAMA');
    expect(reminders).not.toContain('Brief du matin');

    await bot.handleUpdate(textUpdate(ANA, '/memoire'));
    const personal = String(calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === ANA).at(-1)!.payload.text);
    expect(personal).toContain('ENAM');
    expect(personal).not.toContain('Andasibe');
  });

  it('les boutons de liste du groupe ne cochent que les listes du groupe, pour tous ses membres', async () => {
    const { bot, store, ana, toGroup, answers } = await withAna();
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));
    const group = store.getGroupByChatId(GROUP)!;
    const [charbon] = store.addListItems(group.id, 'sortie', ['charbon', 'brochettes'], NOW);
    const [lait] = store.addListItems(ana.id, 'courses', ['lait'], NOW);

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/listes', { firstName: 'Bob' }));
    expect(buttons(toGroup().at(-1)!.payload).map((b) => b.text)).toEqual(['⬜ charbon', '⬜ brochettes']);

    await bot.handleUpdate(groupCallbackUpdate(GROUP, BOB, `li:${lait!.id}`));
    await bot.handleUpdate(groupCallbackUpdate(GROUP, BOB, `li:${charbon!.id}`));
    await bot.handleUpdate(callbackUpdate(ANA, `li:${charbon!.id}`));

    expect(answers()).toEqual(['Cet élément n’existe plus.', 'Coché : charbon', 'Cet élément n’existe plus.']);
    expect(store.getListItem(ana.id, lait!.id)!.done).toBe(false);
    expect(store.getListItem(group.id, charbon!.id)!.done).toBe(true);
  });

  it('/oublier_tout du groupe : la personne rattachée ou un admin, sans toucher aux mémoires personnelles', async () => {
    const { bot, store, ana, toGroup, groupTexts, answers } = await withAna({ chatAdmins: [CARL] });
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));
    const group = store.getGroupByChatId(GROUP)!;
    store.addMemory(group.id, { kind: 'project', content: 'Sortie à Andasibe', importance: 3 }, NOW);
    store.addMemory(ana.id, { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, NOW);

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/oublier_tout', { firstName: 'Bob' }));
    expect(groupTexts().at(-1)).toContain('Seule la personne à qui ce groupe est rattaché');

    await bot.handleUpdate(groupTextUpdate(GROUP, CARL, '/oublier_tout', { firstName: 'Carl' }));
    expect(buttons(toGroup().at(-1)!.payload).map((b) => b.callback_data)).toEqual(['wipe:group', 'wipe:cancel']);

    await bot.handleUpdate(groupCallbackUpdate(GROUP, BOB, 'wipe:group'));
    expect(answers().at(-1)).toContain('Réservé');
    expect(store.listMemories(group.id)).toHaveLength(1);

    await bot.handleUpdate(groupCallbackUpdate(GROUP, ANA, 'wipe:group'));
    expect(store.listMemories(group.id)).toHaveLength(0);
    expect(store.listMemories(ana.id)).toHaveLength(1);
    expect(groupTexts().at(-1)).toContain('effacé la mémoire du groupe');
  });

  it('/resume : gratuit quand personne ne lui a écrit, sinon un résumé par le modèle, avec qui le demande', async () => {
    const { bot, store, requests, groupTexts } = await withAna();
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/resume', { firstName: 'Bob' }));
    expect(requests).toHaveLength(0);
    expect(groupTexts().at(-1)).toContain('Rien à résumer');

    const group = store.getGroupByChatId(GROUP)!;
    store.addMessage(group.id, 'user', 'Ana : on part samedi à 6 h', 'chat', NOW - 3_600_000);
    store.addMessage(group.id, 'assistant', 'Noté !', 'chat', NOW - 3_600_000);
    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/resume@koto_test_bot', { firstName: 'Bob' }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ userId: group.id, kind: 'chat', historyText: '[RÉSUMÉ demandé par Bob]' });
    expect(requests[0]!.text).toMatch(/^\[RÉSUMÉ\] Bob demande un résumé .* \(1 message\)/);
  });
});
