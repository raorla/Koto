// La vraie boucle de l'agent et le vrai scheduler sur un compte de groupe : ce que voit le modèle,
// qui paie, ce que les outils ont le droit de faire, et où partent rappels et relances.
import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent/agent.js';
import { createScheduler } from '../src/scheduler.js';
import { emptyUsage, type Store } from '../src/store.js';
import { KeyedLock, silentLogger } from '../src/util.js';
import { NOW, fakeIntegrations, makeConfig, makeGroup, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';

/** Ana (qui paie le groupe) et Bob ont leurs données personnelles ; le groupe a les siennes. */
function world() {
  const store = makeStore();
  const ana = makeUser(store, { firstName: 'Ana' });
  const bob = makeUser(store, { firstName: 'Bob' });
  const group = makeGroup(store, ana);
  store.updateUserSettings(ana.id, { displayName: 'Nana', newsTopics: 'crypto' });
  store.addMemory(ana.id, { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, NOW);
  store.addListItems(ana.id, 'courses', ['lait'], NOW);
  store.addJob(ana.id, { kind: 'reminder', text: 'Payer la JIRAMA', dueAt: NOW + 3_600_000, repeat: 'none' }, NOW);
  store.addMessage(ana.id, 'user', 'Je stresse pour mon oral de jeudi', 'chat', NOW - 7_200_000);
  store.addMessage(ana.id, 'assistant', 'Tu vas assurer.', 'chat', NOW - 7_200_000);
  store.addMemory(bob.id, { kind: 'about', content: 'Bob cherche un nouveau travail', importance: 2 }, NOW);
  store.addMemory(group.id, { kind: 'project', content: 'Sortie à Andasibe le samedi 17 octobre', importance: 3 }, NOW);
  store.addListItems(group.id, 'sortie', ['charbon'], NOW);
  store.addMessage(group.id, 'user', 'Ana : on part à 6 h', 'chat', NOW - 3_600_000);
  store.addMessage(group.id, 'assistant', 'Noté !', 'chat', NOW - 3_600_000);
  return { store, ana, bob, group };
}

/** Rien de ce qui est propre à un membre ne doit atteindre le modèle en mode groupe. */
const PERSONAL = ['ENAM', 'lait', 'JIRAMA', 'oral de jeudi', 'nouveau travail', 'Nana', 'crypto', '<personne>'];

describe('agent en groupe', () => {
  it('ne voit que les données du groupe, avec le même prompt figé et les mêmes outils que tout le monde', async () => {
    const { store, ana, group } = world();
    const { create, calls } = scriptedCreate([message([text('Salut Nana')], 'end_turn'), message([text('Départ à 6 h, pensez au charbon.')], 'end_turn')]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: true, speech: true, news: true, now: () => NOW });

    await agent({ userId: ana.id, kind: 'chat', text: 'salut' });
    const result = await agent({ userId: group.id, kind: 'chat', text: 'Bob : on part à quelle heure ?' });

    const [personal, inGroup] = calls;
    // Préfixe partagé : le cache du prompt figé et des outils sert aussi aux groupes.
    expect((inGroup!.system as unknown[])[0]).toEqual((personal!.system as unknown[])[0]);
    expect(inGroup!.tools).toEqual(personal!.tools);
    const context = (inGroup!.system as { text: string }[])[1]!.text;
    expect(context).toMatch(/^<groupe>/);
    expect(context).toContain('Sortie à Andasibe le samedi 17 octobre');
    expect(context).toContain('charbon');
    const seen = JSON.stringify({ context, messages: inGroup!.messages });
    for (const leak of PERSONAL) expect(seen).not.toContain(leak);
    expect(seen).toContain('Ana : on part à 6 h');
    expect(seen).toContain('[mer. 14 oct. 2026, 19:00] Bob : on part à quelle heure ?');

    // Le tour s'écrit dans l'historique du groupe ; son coût va au budget d'Ana.
    expect(result.status).toBe('ok');
    expect(store.listMessagesAfter(group.id, 0).map((m) => m.content).slice(-2)).toEqual(['Bob : on part à quelle heure ?', 'Départ à 6 h, pensez au charbon.']);
    expect(store.listMessagesAfter(ana.id, 0).map((m) => m.content)).not.toContain('Bob : on part à quelle heure ?');
    expect(store.getUsage(ana.id, '2026-10-14').requests).toBe(2);
    expect(store.getUsage(group.id, '2026-10-14').requests).toBe(0);
  });

  it('avec OpenRouter, une session par groupe', async () => {
    const { store, group } = world();
    const { create, calls } = scriptedCreate([message([text('ok')], 'end_turn')]);
    const agent = createAgent({ create, store, provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', effort: 'low', webTools: false, now: () => NOW });

    await agent({ userId: group.id, kind: 'chat', text: 'Bob : salut' });

    expect(calls[0]).toMatchObject({ session_id: `koto-group-${group.id}` });
  });

  it('agit sur le groupe, et les outils personnels refusent', async () => {
    const { store, ana, group } = world();
    const fake = fakeIntegrations({ gmail: true });
    store.setConnection(ana.id, 'gmail', true, NOW);
    const browser = { start: vi.fn() };
    const { create, calls } = scriptedCreate([
      message(
        [
          toolUse('t1', 'list_add', { list: 'sortie', items: ['eau', 'K-way'] }),
          toolUse('t2', 'schedule', { kind: 'reminder', when: '2026-10-17T05:30', text: 'Départ pour Andasibe' }),
          toolUse('t3', 'GMAIL_SEND_EMAIL', { recipient_email: 'guide@andasibe.mg', subject: 'Réservation' }),
          toolUse('t4', 'browse_web', { task: 'Réserver un guide à Andasibe' }),
          toolUse('t5', 'update_settings', { brief_time: '06:00' }),
        ],
        'tool_use',
      ),
      message([text('C’est noté pour le groupe.')], 'end_turn'),
    ]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, integrations: fake.integrations, browser, now: () => NOW });

    const result = await agent({ userId: group.id, kind: 'chat', text: 'Ana : organise la sortie' });

    expect(store.listOpenItems(group.id).map((i) => i.text)).toEqual(['charbon', 'eau', 'K-way']);
    expect(store.listOpenItems(ana.id).map((i) => i.text)).toEqual(['lait']);
    expect(store.listPendingJobs(group.id).map((j) => j.text)).toEqual(['Départ pour Andasibe']);
    expect(result.pendingActions).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(browser.start).not.toHaveBeenCalled();
    expect(store.getBriefJob(group.id)).toBeNull();
    const results = calls[1]!.messages.at(-1)!.content as { is_error?: boolean }[];
    expect(results.map((r) => r.is_error === true)).toEqual([false, false, true, true, true]);
  });
});

describe('scheduler en groupe', () => {
  function schedulerFor(store: Store, responses: Parameters<typeof scriptedCreate>[0]) {
    const { create, calls } = scriptedCreate(responses);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, now: () => NOW });
    const sent: { chatId: number; text: string }[] = [];
    const scheduler = createScheduler({
      store,
      config: makeConfig(),
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      now: () => NOW,
      notifier: { send: async (chatId, t) => void sent.push({ chatId, text: t }) },
    });
    return { scheduler, sent, calls };
  }

  it('un rappel du groupe part dans le groupe ; la relance est rédigée pour le groupe et payée par la personne rattachée', async () => {
    const { store, ana, group } = world();
    const { scheduler, sent, calls } = schedulerFor(store, [message([text('Alors, cette sortie à Andasibe ?')], 'end_turn')]);
    store.addJob(group.id, { kind: 'reminder', text: 'Départ pour Andasibe', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);
    store.addJob(group.id, { kind: 'checkin', text: 'Comment s’est passée la sortie', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);

    await scheduler.tick();

    expect(sent).toEqual([
      { chatId: group.chatId, text: '⏰ Départ pour Andasibe' },
      { chatId: group.chatId, text: 'Alors, cette sortie à Andasibe ?' },
    ]);
    expect(JSON.stringify(calls[0]!.messages.at(-1))).toContain('le groupe « Sortie Andasibe »');
    expect((calls[0]!.system as { text: string }[])[1]!.text).toMatch(/^<groupe>/);
    expect(store.getUsage(ana.id, '2026-10-14').requests).toBe(1);
    expect(store.listMessagesAfter(group.id, 0).map((m) => m.content)).toContain('⏰ Rappel envoyé : Départ pour Andasibe');
    expect(store.listMessagesAfter(ana.id, 0).map((m) => m.content).join('\n')).not.toContain('Andasibe');
  });

  it('au-delà du budget de la personne rattachée, ou sans elle, la relance est sautée ; le rappel, gratuit, part quand même', async () => {
    const { store, ana, group } = world();
    const { scheduler, sent, calls } = schedulerFor(store, []);
    store.addUsage(ana.id, '2026-10-14', { ...emptyUsage(), costUsd: 1 });
    store.addJob(group.id, { kind: 'checkin', text: 'Bilan de la sortie', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);
    await scheduler.tick();
    expect(calls).toHaveLength(0);

    store.releaseGroup(group.id);
    store.addJob(group.id, { kind: 'checkin', text: 'Bilan de la sortie', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);
    store.addJob(group.id, { kind: 'reminder', text: 'Rendre les clés du bungalow', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);
    await scheduler.tick();

    expect(calls).toHaveLength(0);
    expect(sent).toEqual([{ chatId: group.chatId, text: '⏰ Rendre les clés du bungalow' }]);
  });
});
