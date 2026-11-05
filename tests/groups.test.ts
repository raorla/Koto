import type { Message, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { payerFor, recordUsage } from '../src/accounts.js';
import { renderGroupContext, systemPrompt } from '../src/agent/prompt.js';
import { executeTool, runTool, type TurnToolContext } from '../src/agent/tools.js';
import { GROUP_COMMANDS } from '../src/bot/bot.js';
import { frameText, isAddressedToBot, replyQuote, speakerName, stripBotMention, summaryRequest } from '../src/bot/group.js';
import { buildExport } from '../src/export.js';
import { emptyUsage } from '../src/store.js';
import { NOW, fakeIntegrations, makeGroup, makeStore, makeUser } from './helpers.js';

function setup() {
  const store = makeStore();
  const ana = makeUser(store, { firstName: 'Ana' });
  const group = makeGroup(store, ana);
  const as = (userId: number) => ({ store, userId, now: NOW });
  return { store, ana, group, as };
}

describe('groupes — un compte à part', () => {
  it('un groupe a son propre compte, sans brief, jamais confondu avec une personne', () => {
    const { store, ana, group } = setup();

    expect(group).toMatchObject({ kind: 'group', ownerId: ana.id, briefEnabled: false, firstName: 'Sortie Andasibe', timezone: ana.timezone });
    expect(ana).toMatchObject({ kind: 'person', ownerId: null });
    expect(store.getBriefJob(group.id)).toBeNull();
    // Un id de groupe ne retrouve jamais une personne, et inversement.
    expect(store.getUserByTelegramId(group.telegramId)).toBeNull();
    expect(store.getGroupByChatId(ana.telegramId)).toBeNull();
    expect(store.getGroupByChatId(group.telegramId)?.id).toBe(group.id);
    expect(store.countUsers()).toBe(1);
    expect(store.countGroups()).toBe(1);
    // Créer deux fois le même groupe rend le même compte.
    const again = store.createGroup({ chatId: group.telegramId, title: 'x', username: null, ownerId: null, timezone: 'UTC', briefTime: '07:30' }, NOW);
    expect(again).toMatchObject({ id: group.id, ownerId: ana.id });
  });

  it('mémoire, listes et rappels du groupe restent séparés de ceux de ses membres, dans les deux sens', () => {
    const { store, ana, group, as } = setup();
    executeTool('remember', { kind: 'project', content: 'Sortie à Andasibe le samedi 17 octobre', importance: 3 }, as(group.id));
    executeTool('remember', { kind: 'project', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, as(ana.id));
    executeTool('list_add', { list: 'courses', items: ['charbon'] }, as(group.id));
    executeTool('list_add', { list: 'courses', items: ['lait'] }, as(ana.id));
    executeTool('schedule', { kind: 'reminder', when: '2026-10-17T05:30', text: 'Départ pour Andasibe' }, as(group.id));
    executeTool('schedule', { kind: 'reminder', when: '2026-10-15T09:00', text: 'Payer la JIRAMA' }, as(ana.id));

    expect(store.listMemories(group.id).map((m) => m.content)).toEqual(['Sortie à Andasibe le samedi 17 octobre']);
    expect(store.listMemories(ana.id).map((m) => m.content)).toEqual(['Ana prépare le concours de l’ENAM']);
    expect(store.listOpenItems(group.id).map((i) => i.text)).toEqual(['charbon']);
    expect(store.listOpenItems(ana.id).map((i) => i.text)).toEqual(['lait']);
    expect(store.listPendingJobs(group.id).map((j) => j.text)).toEqual(['Départ pour Andasibe']);
    expect(store.listPendingJobs(ana.id).map((j) => j.text)).toEqual(['Payer la JIRAMA']);

    // Un id venant du modèle ne traverse pas la frontière, dans un sens comme dans l'autre.
    const [anaMemory] = store.listMemories(ana.id);
    const [groupItem] = store.listOpenItems(group.id);
    const [anaJob] = store.listPendingJobs(ana.id);
    expect(executeTool('forget', { id: anaMemory!.id }, as(group.id)).isError).toBe(true);
    expect(executeTool('cancel_scheduled', { id: anaJob!.id }, as(group.id)).isError).toBe(true);
    expect(executeTool('list_update', { action: 'done', ids: [groupItem!.id] }, as(ana.id)).isError).toBe(true);
    expect(store.listMemories(ana.id)).toHaveLength(1);
    expect(store.listPendingJobs(ana.id)).toHaveLength(1);
    expect(store.listOpenItems(group.id)).toHaveLength(1);
  });

  it('le contexte du groupe ne contient que les données du groupe, de façon déterministe', () => {
    const { store, ana, group, as } = setup();
    executeTool('remember', { kind: 'project', content: 'Sortie à Andasibe le samedi 17 octobre', importance: 3 }, as(group.id));
    executeTool('list_add', { list: 'sortie', items: ['charbon', 'brochettes'] }, as(group.id));
    executeTool('schedule', { kind: 'reminder', when: '2026-10-17T05:30', text: 'Départ pour Andasibe' }, as(group.id));
    executeTool('remember', { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, as(ana.id));
    executeTool('list_add', { list: 'courses', items: ['lait'] }, as(ana.id));
    store.updateUserSettings(ana.id, { displayName: 'Nana', newsTopics: 'crypto' });
    const features = { speech: true, news: true, weather: true };
    const render = () =>
      renderGroupContext(store.getUserById(group.id)!, store.listMemories(group.id), store.listPendingJobs(group.id), features, store.listOpenItems(group.id));

    const context = render();

    expect(context).toMatch(/^<groupe>\nGroupe Telegram : Sortie Andasibe\n/);
    expect(context).toContain('Fuseau horaire du groupe : Indian/Antananarivo');
    expect(context).toContain('Sortie à Andasibe le samedi 17 octobre');
    expect(context).toMatch(/<listes>\n## sortie\n- \[\d+\] charbon\n- \[\d+\] brochettes\n<\/listes>/);
    expect(context).toContain('« Départ pour Andasibe »');
    for (const personal of ['<personne>', 'ENAM', 'lait', 'Nana', 'crypto', 'Brief du matin', 'Veille']) expect(context).not.toContain(personal);
    expect(render()).toBe(context);
  });

  it('suppression du compte de la personne rattachée : le groupe garde sa mémoire, sans payeur', () => {
    const { store, ana, group, as } = setup();
    executeTool('remember', { kind: 'project', content: 'Sortie à Andasibe', importance: 2 }, as(group.id));

    store.deleteUser(ana.id);

    expect(store.getUserById(group.id)!.ownerId).toBeNull();
    expect(store.listMemories(group.id)).toHaveLength(1);
    expect(payerFor(store, store.getUserById(group.id)!)).toBeNull();
  });

  it('se rattache une seule fois, se détache, change d’id au passage en supergroupe, et annule ses rappels quand Koto part', () => {
    const { store, ana, as } = setup();
    const bob = makeUser(store, { firstName: 'Bob' });
    const orphan = makeGroup(store, null, 'Projet');

    expect(store.claimGroup(orphan.id, bob.id)).toBe(true);
    expect(store.claimGroup(orphan.id, ana.id)).toBe(false);
    expect(store.getUserById(orphan.id)!.ownerId).toBe(bob.id);
    expect(store.claimGroup(ana.id, bob.id)).toBe(false); // une personne ne se « rattache » pas
    store.releaseGroup(orphan.id);
    expect(store.getUserById(orphan.id)!.ownerId).toBeNull();

    executeTool('remember', { kind: 'note', content: 'Réunion le lundi', importance: 2 }, as(orphan.id));
    expect(store.moveGroupChat(orphan.telegramId, -100999)).toBe(true);
    const moved = store.getGroupByChatId(-100999)!;
    expect(moved).toMatchObject({ id: orphan.id, chatId: -100999 });
    expect(store.listMemories(moved.id)).toHaveLength(1);

    executeTool('schedule', { kind: 'reminder', when: '2026-10-19T08:00', text: 'Réunion', repeat: 'weekly' }, as(moved.id));
    expect(store.cancelPendingJobs(moved.id)).toBe(1);
    expect(store.listPendingJobs(moved.id)).toHaveLength(0);
  });
});

describe('groupes — budget', () => {
  it('le coût d’un groupe va au budget du jour de la personne rattachée', () => {
    const { store, ana, group } = setup();
    expect(payerFor(store, group)?.id).toBe(ana.id);
    expect(payerFor(store, ana)?.id).toBe(ana.id);

    recordUsage(store, group, NOW, { ...emptyUsage(), requests: 1, costUsd: 0.01 });

    expect(store.getUsage(ana.id, '2026-10-14')).toMatchObject({ requests: 1, costUsd: 0.01 });
    expect(store.getUsage(group.id, '2026-10-14').costUsd).toBe(0);
  });
});

describe('groupes — outils', () => {
  it('refuse en groupe Gmail, l’agenda, les tâches web, le brief et la veille, mais pas le reste', async () => {
    const { store, ana, group } = setup();
    const fake = fakeIntegrations({ gmail: true });
    store.setConnection(ana.id, 'gmail', true, NOW);
    const browser = { start: vi.fn() };
    const ctx = (userId: number): TurnToolContext => ({ store, userId, now: NOW, integrations: fake.integrations, browser, pending: [], checked: new Set() });

    const mail = await runTool('GMAIL_FETCH_EMAILS', { query: 'is:unread' }, ctx(group.id));
    const send = await runTool('GMAIL_SEND_EMAIL', { recipient_email: 'x@y.z' }, ctx(group.id));
    const browse = await runTool('browse_web', { task: 'Comparer les vols Tana → Paris' }, ctx(group.id));
    expect([mail, send, browse].every((r) => r.isError && r.content.includes('en privé'))).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(store.listBrowserTasks(group.id)).toHaveLength(0);
    expect(browser.start).not.toHaveBeenCalled();

    expect(executeTool('update_settings', { brief_time: '08:00' }, { store, userId: group.id, now: NOW }).isError).toBe(true);
    expect(executeTool('update_settings', { news_topics: 'crypto' }, { store, userId: group.id, now: NOW }).isError).toBe(true);
    const tz = executeTool('update_settings', { timezone: 'Europe/Paris', display_name: 'La team rando' }, { store, userId: group.id, now: NOW });
    expect(tz.isError).toBe(false);
    expect(tz.content).not.toContain('brief');
    expect(store.getUserById(group.id)).toMatchObject({ timezone: 'Europe/Paris', displayName: 'La team rando', briefEnabled: false });
    expect(store.getBriefJob(group.id)).toBeNull();

    // Pour la personne, rien ne change.
    expect((await runTool('GMAIL_FETCH_EMAILS', { query: 'is:unread' }, ctx(ana.id))).isError).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('groupes — à qui s’adresse un message', () => {
  const me = { id: 42, is_bot: true, first_name: 'Koto', username: 'koto_test_bot' } as UserFromGetMe;
  const known = new Set(['listes', 'resume']);
  const chat = { id: -100777, type: 'supergroup', title: 'Sortie Andasibe' };
  const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message_id: 5, date: 0, chat, text, ...extra }) as unknown as Message;
  const command = (text: string) => msg(text, { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] });
  const replyTo = (from: object, text: string) => ({ reply_to_message: { message_id: 4, date: 0, chat, from, text } });

  it('mention (sans tenir compte de la casse), réponse à l’un de ses messages ou commande pour lui', () => {
    expect(isAddressedToBot(msg('@Koto_Test_Bot rappelez-nous samedi'), me, known)).toBe(true);
    expect(isAddressedToBot(msg('salut @koto_test_bot !'), me, known)).toBe(true);
    expect(isAddressedToBot(msg('Koto ?', { entities: [{ type: 'text_mention', offset: 0, length: 4, user: me }] }), me, known)).toBe(true);
    expect(isAddressedToBot(msg('et la météo ?', replyTo(me, 'Programmé #3')), me, known)).toBe(true);
    expect(isAddressedToBot(command('/listes'), me, known)).toBe(true);
    expect(isAddressedToBot(command('/listes@koto_test_bot'), me, known)).toBe(true);
    expect(isAddressedToBot(msg('', { caption: '@koto_test_bot c’est quoi ?', caption_entities: [] }), me, known)).toBe(true);
  });

  it('ignore le reste de la discussion', () => {
    expect(isAddressedToBot(msg('On part à quelle heure ?'), me, known)).toBe(false);
    expect(isAddressedToBot(msg('salut @koto_test_bot2'), me, known)).toBe(false);
    expect(isAddressedToBot(msg('écris à ana@koto_test_bot.mg'), me, known)).toBe(false);
    expect(isAddressedToBot(msg('d’accord', replyTo({ id: 7, is_bot: false, first_name: 'Bob' }, 'On part à 7 h ?')), me, known)).toBe(false);
    expect(isAddressedToBot(command('/listes@autre_bot'), me, known)).toBe(false);
    expect(isAddressedToBot(command('/sondage'), me, known)).toBe(false);
  });

  it('retire la mention, nomme qui parle et cite ce à quoi il répond', () => {
    expect(stripBotMention('@koto_test_bot, rappelez-nous samedi', 'koto_test_bot')).toBe('rappelez-nous samedi');
    expect(stripBotMention('Dis @Koto_Test_Bot tu en penses quoi ?', 'koto_test_bot')).toBe('Dis Koto tu en penses quoi ?');
    expect(stripBotMention('@koto_test_bot', 'koto_test_bot')).toBe('');

    expect(speakerName({ first_name: ' Ana\n: [admin] ' })).toBe('Ana admin');
    expect(speakerName({ first_name: '', username: 'rado_r' })).toBe('rado_r');
    expect(speakerName(undefined)).toBe('Quelqu’un');

    const quote = replyQuote(msg('qu’en penses-tu ?', replyTo({ id: 7, is_bot: false, first_name: 'Bob' }, 'On part\nà 7 h ?')), me);
    expect(quote).toBe('en réponse à Bob : « On part à 7 h ? »');
    expect(frameText({ name: 'Ana', quote }, 'qu’en penses-tu ?')).toBe('Ana (en réponse à Bob : « On part à 7 h ? ») : qu’en penses-tu ?');
    expect(replyQuote(msg('ok', replyTo(me, 'x'.repeat(400))), me)).toBe(`en réponse à ton message : « ${'x'.repeat(150)}… »`);
    expect(replyQuote(msg('ok'), me)).toBeNull();
  });
});

describe('groupes — prompt, résumé, export', () => {
  it('la section des groupes fait partie du prompt figé, le même pour tous', () => {
    const prompt = systemPrompt({ integrations: true, browser: true });
    expect(prompt).toContain('# Conversations de groupe');
    expect(prompt).toContain('<groupe>');
    expect(prompt).toContain('ses mails, son agenda, une tâche web');
    expect(systemPrompt({ integrations: false })).not.toContain('ses mails');
  });

  it('prépare la demande de résumé avec la période et qui la demande', () => {
    const { group } = setup();
    const request = summaryRequest(group, 'Bob', Date.parse('2026-10-13T16:00:00Z'), 6);
    expect(request).toMatchObject({ userId: group.id, kind: 'chat', historyText: '[RÉSUMÉ demandé par Bob]' });
    expect(request.text).toMatch(/^\[RÉSUMÉ\] Bob demande un résumé de ce qu'on t'a dit dans ce groupe depuis le mardi 13 octobre 2026 à 19:00 \(6 messages\)/);
    expect(GROUP_COMMANDS.map((c) => c.command)).toEqual(['memoire', 'rappels', 'listes', 'missions', 'resume', 'aide', 'oublier_tout']);
  });

  it("l'export d'une personne nomme ses groupes, sans rien de leur contenu", () => {
    const { store, ana, group, as } = setup();
    executeTool('remember', { kind: 'project', content: 'Sortie à Andasibe', importance: 2 }, as(group.id));
    executeTool('list_add', { list: 'sortie', items: ['charbon'] }, as(group.id));
    store.addMessage(group.id, 'user', 'Bob : on part à quelle heure ?', 'chat', NOW);

    const data = buildExport(store, ana, NOW);

    expect(data.groupes_rattaches).toEqual([{ nom: 'Sortie Andasibe', depuis: new Date(group.createdAt).toISOString() }]);
    const json = JSON.stringify(data);
    for (const fromGroup of ['Sortie à Andasibe', 'charbon', 'Bob']) expect(json).not.toContain(fromGroup);
  });
});
