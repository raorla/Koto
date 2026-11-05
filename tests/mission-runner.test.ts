// Les vrais passages de mission (boucle du sous-agent, SQLite, budget) avec un modèle scripté : ce que voit le
// modèle, ce que la personne reçoit (ou pas), ce qui est compté, et quand la mission s'arrête d'elle-même.
import { describe, expect, it, vi } from 'vitest';
import type { CreateMessage } from '../src/agent/agent.js';
import { createAgent } from '../src/agent/agent.js';
import type { BrowseResult } from '../src/browser/agent.js';
import type { Config } from '../src/config.js';
import type { Integrations } from '../src/integrations/types.js';
import { MissionRunner, type MissionBrowser, type MissionNotifier } from '../src/missions/runner.js';
import type { NewsService } from '../src/news.js';
import { createScheduler } from '../src/scheduler.js';
import { emptyUsage, type Mission, type NewMission, type User } from '../src/store.js';
import { KeyedLock, silentLogger } from '../src/util.js';
import { NOW, fakeIntegrations, makeConfig, makeGroup, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';

const HOUR = 3_600_000;

const news: NewsService = {
  digest: async () => ({ text: '## Crypto\nCours (CoinGecko) : Bitcoin 81 811 $\n- [il y a 2 h] Le Bitcoin repasse les 80 000 $ (Cryptoast) https://cryptoast.fr/a', uncovered: [] }),
  quotes: async (ids) => ids.map((id) => ({ id, usd: 81_811, change24h: -1.7 })),
};

const finish = (input: Record<string, unknown>) => message([toolUse(`f${Math.random()}`, 'finish', input)], 'tool_use');

interface WorldOptions {
  responses?: Parameters<typeof scriptedCreate>[0];
  create?: CreateMessage;
  config?: Partial<Config>;
  integrations?: Integrations;
  browser?: MissionBrowser;
}

function world(options: WorldOptions = {}) {
  const store = makeStore();
  const ana = makeUser(store, { firstName: 'Ana' });
  const scripted = scriptedCreate(options.responses ?? []);
  let now = NOW;
  const sent: { chatId: number; text: string }[] = [];
  const confirms: number[] = [];
  const proposals: { missionId: number; conclusion: string | null }[] = [];
  const notifier: MissionNotifier = {
    send: async (account, t) => void sent.push({ chatId: account.chatId, text: t }),
    confirm: async (_chatId, action) => void confirms.push(action.id),
    proposeConclusion: async (_account, mission) => void proposals.push({ missionId: mission.id, conclusion: mission.conclusion }),
  };
  const locks = new KeyedLock();
  const runner = new MissionRunner({
    store,
    config: makeConfig(options.config),
    create: options.create ?? scripted.create,
    notifier,
    locks,
    log: silentLogger,
    news,
    integrations: options.integrations ?? null,
    browser: options.browser ?? null,
    now: () => now,
  });
  const mission = (account: User, overrides: Partial<NewMission> = {}): Mission =>
    store.addMission(
      account.id,
      {
        title: 'Vol Tana → Paris',
        goal: 'Surveiller le prix du vol Tana → Paris du 4 décembre 2026, en éco.',
        doneWhen: 'prix sous 600 €',
        intervalMinutes: 360,
        deadlineAt: NOW + 20 * 24 * HOUR,
        maxCostUsd: 0.25,
        nextRunAt: NOW,
        ...overrides,
      },
      NOW,
    );
  /** Un tour de dispatch à l'heure dite, puis attend la fin des passages et des messages. */
  const pass = async (at: number) => {
    now = at;
    const started = runner.dispatch(at);
    await runner.idle();
    return started;
  };
  return { store, ana, calls: scripted.calls, sent, confirms, proposals, runner, locks, mission, pass, setNow: (t: number) => (now = t) };
}

const lastUserContent = (params: { messages: { role: string; content: unknown }[] }) => JSON.stringify(params.messages.at(-1)!.content);

describe('passages de mission', () => {
  it('premier passage silencieux, notes gardées ; le suivant prévient, avec un contexte propre à la mission', async () => {
    const { store, ana, calls, sent, mission, pass } = world({
      responses: [
        message([toolUse('t1', 'news', { topics: 'crypto' })], 'tool_use'),
        finish({ outcome: 'continue', notes: 'Prix vu le 14 oct. : 640 € (Air Madagascar).' }),
        finish({ outcome: 'notify', notes: 'Prix vu le 15 oct. : 580 €. Signalé le 15 oct.', message: 'Le vol est passé à 580 € chez Air Madagascar.' }),
      ],
    });
    store.addMemory(ana.id, { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, NOW);
    store.addListItems(ana.id, 'courses', ['lait'], NOW);
    store.addMessage(ana.id, 'user', 'Je stresse pour mon oral de jeudi', 'chat', NOW - HOUR);
    const m = mission(ana);

    expect(await pass(NOW)).toBe(1);

    expect(sent).toEqual([]);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ runs: 1, notes: 'Prix vu le 14 oct. : 640 € (Air Madagascar).', nextRunAt: NOW + 6 * HOUR, lastRunAt: NOW });
    const [first, second] = calls;
    expect((first!.system as { text: string }[])[0]!.text).toMatch(/^Tu es le module de missions de Koto/);
    expect((first!.tools as { name: string }[]).map((t) => t.name)).toEqual(['news', 'crypto_price', 'finish', 'web_search', 'web_fetch']);
    expect(lastUserContent(first!)).toContain('(vides : premier passage)');
    // Ni sa mémoire, ni ses listes, ni l'historique de la conversation.
    const seen = JSON.stringify({ system: first!.system, messages: first!.messages });
    for (const leak of ['ENAM', 'lait', 'oral de jeudi', '<personne>']) expect(seen).not.toContain(leak);
    // En ajout seul : chaque requête est un préfixe de la suivante.
    expect(second!.system).toEqual(first!.system);
    expect(second!.tools).toEqual(first!.tools);
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    expect(lastUserContent(second!)).toContain('Le Bitcoin repasse les 80 000 $');
    // Compté dans le budget du jour, comme le coût de la mission.
    const usage = store.getUsage(ana.id, '2026-10-14');
    expect(usage.requests).toBe(2);
    expect(store.getMission(ana.id, m.id)!.costUsd).toBeCloseTo(usage.costUsd);

    expect(await pass(NOW + 6 * HOUR)).toBe(1);

    expect(lastUserContent(calls[2]!)).toContain('Prix vu le 14 oct. : 640 €');
    expect(sent).toEqual([{ chatId: ana.chatId, text: `🎯 **Mission #${m.id}** · Vol Tana → Paris\n\nLe vol est passé à 580 € chez Air Madagascar.` }]);
    // Dans l'historique : à son prochain message, Koto sait ce que la mission a trouvé.
    expect(store.listMessagesAfter(ana.id, 0).at(-1)).toMatchObject({ role: 'assistant', kind: 'mission', content: sent[0]!.text });
    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'active', runs: 2 });
  });

  it('objectif atteint : résultat, conclusion proposée à la mémoire et gardée une seule fois, jamais les notes', async () => {
    const conclusion = 'Le 14 oct. 2026, le vol Tana → Paris du 4 déc. était à 585 € chez Air Madagascar.';
    const { store, ana, sent, proposals, runner, mission, pass } = world({
      responses: [finish({ outcome: 'done', notes: 'NOTES DE TRAVAIL : 3 sites comparés', message: 'Trouvé : 585 € chez Air Madagascar.', conclusion })],
    });
    const m = mission(ana);

    await pass(NOW);

    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'done', endReason: 'goal', conclusion, conclusionState: 'proposed' });
    expect(sent.map((s) => s.text)).toEqual([`🎯 **Mission #${m.id} terminée** · Vol Tana → Paris\n\nTrouvé : 585 € chez Air Madagascar.`]);
    expect(proposals).toEqual([{ missionId: m.id, conclusion }]);
    expect(store.listMemories(ana.id)).toEqual([]);

    expect(runner.keepConclusion(ana, m.id, NOW)).toBe('kept');
    expect(runner.keepConclusion(ana, m.id, NOW)).toBe('missing');
    expect(runner.dropConclusion(ana, m.id, NOW)).toBe(false);
    expect(store.listMemories(ana.id).map((mem) => [mem.kind, mem.content])).toEqual([['note', conclusion]]);
    expect(await pass(NOW + 6 * HOUR)).toBe(0);
  });

  it('plafond de la mission atteint : arrêt automatique, avec un message', async () => {
    const { store, ana, sent, mission, pass } = world({
      responses: [message([toolUse('f', 'finish', { outcome: 'notify', notes: 'x', message: 'Toujours 640 €.' })], 'tool_use', { cost: 0.03 } as never)],
    });
    const m = mission(ana, { maxCostUsd: 0.03 });

    await pass(NOW);

    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'stopped', endReason: 'budget', costUsd: 0.03, conclusion: null });
    expect(sent[0]!.text).toBe(
      `🎯 **Mission #${m.id} arrêtée** · Vol Tana → Paris\n\nSon plafond de coût (0,03 $) est atteint après 1 passage.\n\nToujours 640 €.\n\nRedemande-la-moi avec un plafond plus haut si besoin.`,
    );
    expect(store.getUsage(ana.id, '2026-10-14').costUsd).toBeCloseTo(0.03);
  });

  it('plafond d’un passage : une dernière requête pour conclure, puis le passage est coupé sans rien perdre', async () => {
    const costly = (id: string) => message([toolUse(id, 'news', { topics: 'crypto' })], 'tool_use', { cost: 0.03 } as never);
    const { store, ana, calls, sent, mission, pass } = world({ responses: [costly('a'), costly('b'), costly('c')] });
    const m = mission(ana, { maxCostUsd: 1 });
    store.recordMissionRun(ana.id, m.id, { costUsd: 0, notes: 'Prix vu le 13 oct. : 640 €', failed: false }, NOW);

    await pass(NOW);

    expect(calls).toHaveLength(3);
    expect(lastUserContent(calls[1]!)).not.toContain('budget de ce passage');
    expect(lastUserContent(calls[2]!)).toContain('Le budget de ce passage');
    expect(sent).toEqual([]);
    const after = store.getMission(ana.id, m.id)!;
    expect(after).toMatchObject({ status: 'active', runs: 2 });
    expect(after.notes).toContain('Prix vu le 13 oct. : 640 €');
    expect(after.notes).toContain('[Passage n° 2 interrompu');
    expect(after.costUsd).toBeCloseTo(0.09);
  });

  it('le plafond d’un passage tient compte du budget du jour ; budget épuisé, le passage attend sans appeler le modèle', async () => {
    const { store, ana, calls, mission, pass } = world({ responses: [finish({ outcome: 'continue', notes: 'x' })] });
    const m = mission(ana);
    store.addUsage(ana.id, '2026-10-14', { ...emptyUsage(), costUsd: 0.48 });

    await pass(NOW);
    expect(lastUserContent(calls[0]!)).toContain('0,02 $ au plus pour ce passage');

    // Budget du jour épuisé (le passage suivant est avancé dans la même journée) : il attend, gratuitement.
    store.addUsage(ana.id, '2026-10-14', { ...emptyUsage(), costUsd: 0.1 });
    store.postponeMission(ana.id, m.id, NOW + HOUR, NOW);
    expect(await pass(NOW + HOUR)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ runs: 1, nextRunAt: NOW + 2 * HOUR, status: 'active' });
  });

  it('dernier passage à la date limite : annoncé au modèle, et la mission se termine même sans « done »', async () => {
    const { store, ana, calls, sent, mission, pass } = world({
      responses: [finish({ outcome: 'continue', notes: 'Prix vu : 640 €' }), finish({ outcome: 'continue', notes: 'Prix vu : 630 €' })],
    });
    const m = mission(ana, { deadlineAt: NOW + 2 * HOUR });

    await pass(NOW);
    expect(store.getMission(ana.id, m.id)!.nextRunAt).toBe(NOW + 2 * HOUR);
    expect(lastUserContent(calls[0]!)).not.toContain('DERNIER PASSAGE');

    await pass(NOW + 2 * HOUR);

    expect(lastUserContent(calls[1]!)).toContain('DERNIER PASSAGE');
    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'done', endReason: 'deadline', runs: 2 });
    expect(sent.map((s) => s.text)).toEqual([`🎯 **Mission #${m.id} terminée** · Vol Tana → Paris\n\nLa date limite est arrivée : je m'arrête là.`]);
  });

  it('mission de groupe : rapport dans le groupe, payé par la personne rattachée, sans Gmail ni données d’un membre', async () => {
    const fake = fakeIntegrations({ gmail: true });
    const { store, ana, calls, sent, mission, pass } = world({
      integrations: fake.integrations,
      responses: [
        message([toolUse('g', 'GMAIL_FETCH_EMAILS', { query: 'from:rado' })], 'tool_use'),
        finish({ outcome: 'notify', notes: 'Pluie prévue samedi.', message: 'Il va pleuvoir samedi à Andasibe : prévoyez des K-way.' }),
      ],
    });
    store.setConnection(ana.id, 'gmail', true, NOW);
    store.addMemory(ana.id, { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, NOW);
    const group = makeGroup(store, ana);
    const m = mission(group, { title: 'Météo Andasibe' });

    await pass(NOW);

    expect(fake.calls).toHaveLength(0);
    expect(lastUserContent(calls[1]!)).toContain('Pas dans un groupe');
    const context = lastUserContent(calls[0]!);
    expect(context).toContain('Groupe Telegram : Sortie Andasibe');
    for (const leak of ['ENAM', 'Nom : Ana', 'Connexions']) expect(context).not.toContain(leak);
    expect(sent).toEqual([{ chatId: group.chatId, text: `🎯 **Mission #${m.id}** · Météo Andasibe\n\nIl va pleuvoir samedi à Andasibe : prévoyez des K-way.` }]);
    expect(store.getUsage(ana.id, '2026-10-14').requests).toBe(2);
    expect(store.getUsage(group.id, '2026-10-14').requests).toBe(0);
    expect(store.listMessagesAfter(group.id, 0).map((msg) => msg.content)).toEqual([sent[0]!.text]);
    expect(store.listMessagesAfter(ana.id, 0)).toEqual([]);
  });

  it('un mail préparé par une mission part en carte à confirmer, jamais envoyé', async () => {
    const fake = fakeIntegrations({ gmail: true });
    const { store, ana, sent, confirms, mission, pass } = world({
      integrations: fake.integrations,
      responses: [
        message(
          [
            toolUse('s', 'GMAIL_SEND_EMAIL', { recipient_email: 'rado@exemple.com', subject: 'Relance devis', body: 'Bonjour Rado, as-tu pu regarder le devis ?' }),
            toolUse('f', 'finish', { outcome: 'continue', notes: 'Relance préparée le 14 oct.' }),
          ],
          'tool_use',
        ),
      ],
    });
    store.setConnection(ana.id, 'gmail', true, NOW);
    mission(ana, { title: 'Devis de Rado' });

    await pass(NOW);

    expect(fake.calls).toHaveLength(0);
    expect(confirms).toHaveLength(1);
    expect(store.getPendingAction(ana.id, confirms[0]!)).toMatchObject({ tool: 'GMAIL_SEND_EMAIL', status: 'pending' });
    expect(sent[0]!.text).toContain("J'ai préparé ceci pour toi, à confirmer :");
  });

  it('un passage refusé ne présente rien de ce qu’il a préparé et compte comme un échec', async () => {
    const fake = fakeIntegrations({ gmail: true });
    const { store, ana, sent, confirms, mission, pass } = world({
      integrations: fake.integrations,
      responses: [
        message([toolUse('s', 'GMAIL_SEND_EMAIL', { recipient_email: 'rado@exemple.com', subject: 'Relance' })], 'tool_use'),
        message([text('…')], 'refusal'),
      ],
    });
    store.setConnection(ana.id, 'gmail', true, NOW);
    const m = mission(ana, { title: 'Devis de Rado' });

    await pass(NOW);

    expect(sent).toEqual([]);
    expect(confirms).toEqual([]);
    expect(store.getPendingAction(ana.id, 1)).toMatchObject({ status: 'cancelled' });
    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'active', failures: 1, runs: 1 });
    expect(fake.calls).toHaveLength(0);
  });

  it('tâche web d’une mission : son coût entre dans le passage et elle ne parle pas à la personne', async () => {
    const result: BrowseResult = { status: 'done', summary: '640 € chez Air Madagascar', usage: { ...emptyUsage(), requests: 5, costUsd: 0.02 }, steps: 5 };
    const runForMission = vi.fn<MissionBrowser['runForMission']>(() => Promise.resolve(result));
    const { store, ana, calls, sent, mission, pass } = world({
      browser: { runForMission },
      responses: [
        message([toolUse('b', 'browse_web', { task: 'Prix du vol Tana → Paris du 4 déc. sur airmadagascar.com' })], 'tool_use'),
        finish({ outcome: 'continue', notes: '640 € vu sur airmadagascar.com le 14 oct.' }),
      ],
    });
    const m = mission(ana);

    await pass(NOW);

    expect(runForMission).toHaveBeenCalledTimes(1);
    const [user, task, startUrl, budget] = runForMission.mock.calls[0]!;
    expect([user.id, task, startUrl]).toEqual([ana.id, 'Prix du vol Tana → Paris du 4 déc. sur airmadagascar.com', null]);
    expect(budget).toBeLessThan(0.05);
    expect(lastUserContent(calls[1]!)).toContain('Tâche web terminée (5 étapes');
    expect(sent).toEqual([]);
    expect(store.getUsage(ana.id, '2026-10-14').requests).toBe(7);
    expect(store.getMission(ana.id, m.id)!.costUsd).toBeCloseTo(store.getUsage(ana.id, '2026-10-14').costUsd);
  });

  it('arrêtée pendant un passage : il s’interrompt, rien ne part, mais le coût dépensé est compté', async () => {
    const responses: Parameters<typeof scriptedCreate>[0] = [];
    const { store, ana, calls, sent, mission, pass } = world({ responses });
    const m = mission(ana);
    responses.push(() => {
      store.endMission(ana.id, m.id, { status: 'stopped', reason: 'person' }, NOW);
      return message([toolUse('n', 'news', { topics: 'crypto' })], 'tool_use');
    });

    await pass(NOW);

    expect(calls).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'stopped', endReason: 'person', runs: 1 });
    expect(store.getUsage(ana.id, '2026-10-14').requests).toBe(1);
  });

  it('trois erreurs de suite : la mission s’arrête et le dit', async () => {
    const { store, ana, sent, mission, pass } = world({ responses: [] });
    const m = mission(ana);

    await pass(NOW);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'active', failures: 1, nextRunAt: NOW + 6 * HOUR });
    await pass(NOW + 6 * HOUR);
    await pass(NOW + 12 * HOUR);

    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'failed', endReason: 'errors', failures: 3 });
    expect(sent.map((s) => s.text)).toEqual([`⚠️ **Mission #${m.id} arrêtée** · Vol Tana → Paris\n\nJe n'arrive plus à la mener (3 erreurs de suite). Redemande-la-moi si besoin.`]);
  });

  it('deux passages à la fois au plus, jamais deux fois la même mission', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = vi.fn<CreateMessage>(async () => {
      await gate;
      return finish({ outcome: 'continue', notes: 'x' });
    });
    const { store, ana, runner, mission } = world({ create });
    const missions = [mission(ana), mission(ana), mission(ana)];

    expect(runner.dispatch(NOW)).toBe(2);
    expect(runner.dispatch(NOW)).toBe(0);
    release();
    await runner.idle();
    expect(runner.dispatch(NOW)).toBe(1);
    await runner.idle();

    expect(create).toHaveBeenCalledTimes(3);
    expect(missions.map((m) => store.getMission(ana.id, m.id)!.runs)).toEqual([1, 1, 1]);
  });

  it('le scheduler lance les passages sans les attendre : un rappel part pendant qu’un passage tourne', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = vi.fn<CreateMessage>(async () => {
      await gate;
      return finish({ outcome: 'continue', notes: 'x' });
    });
    const { store, ana, runner, locks, mission } = world({ create });
    const sent: string[] = [];
    const scheduler = createScheduler({
      store,
      config: makeConfig(),
      agent: createAgent({ create: scriptedCreate([]).create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, now: () => NOW }),
      locks,
      log: silentLogger,
      now: () => NOW,
      missions: runner,
      notifier: { send: async (_chatId, t) => void sent.push(t) },
    });
    store.addJob(ana.id, { kind: 'reminder', text: "Boire de l'eau", dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);
    const m = mission(ana);

    expect(await scheduler.tick()).toBe(1);

    expect(sent).toEqual(["⏰ Boire de l'eau"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.getMission(ana.id, m.id)!.runs).toBe(0);
    release();
    await runner.idle();
    expect(store.getMission(ana.id, m.id)!.runs).toBe(1);
  });
});

describe('missions et conversation', () => {
  it('lance une mission par la conversation, puis <missions> apparaît dans le contexte suivant', async () => {
    const store = makeStore();
    const ana = makeUser(store, { firstName: 'Ana' });
    const { create, calls } = scriptedCreate([
      message(
        [
          toolUse('t1', 'mission_start', {
            title: 'Vol Tana → Paris du 4 déc.',
            goal: 'Surveiller le prix du vol Antananarivo → Paris du 4 décembre 2026, en éco, bagage en soute.',
            done_when: 'prix sous 600 €',
            every_hours: 6,
            deadline: '2026-12-03T09:00',
          }),
        ],
        'tool_use',
      ),
      message([text('Je surveille ce vol toutes les 6 h jusqu’au 3 décembre et je te préviens s’il passe sous 600 €.')], 'end_turn'),
      message([text('Oui, la mission #1 tourne.')], 'end_turn'),
    ]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: true, missions: { minHours: 1, defaultMaxCostUsd: 0.25 }, now: () => NOW });

    const result = await agent({ userId: ana.id, kind: 'chat', text: 'Surveille le vol Tana → Paris du 4 décembre et préviens-moi s’il passe sous 600 €' });
    await agent({ userId: ana.id, kind: 'chat', text: 'Tu surveilles bien mon vol ?' });

    expect(result.text).toBe('Je surveille ce vol toutes les 6 h jusqu’au 3 décembre et je te préviens s’il passe sous 600 €.');
    expect(lastUserContent(calls[1]!)).toContain('Mission #1 lancée');
    expect(store.listActiveMissions(ana.id)).toHaveLength(1);
    const [first, , later] = calls;
    expect((first!.tools as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(['mission_start', 'mission_update']));
    expect((first!.system as { text: string }[])[0]!.text).toContain('# Missions');
    expect((first!.system as { text: string }[])[1]!.text).toContain('<missions>\n(aucune)\n</missions>');
    // Le prompt figé ne bouge pas ; seul le contexte de la personne montre la nouvelle mission.
    expect((later!.system as unknown[])[0]).toEqual((first!.system as unknown[])[0]);
    expect((later!.system as { text: string }[])[1]!.text).toContain(
      "<missions>\n- #1 · « Vol Tana → Paris du 4 déc. » · toutes les 6 h · jusqu'au jeudi 3 décembre 2026 à 09:00\n</missions>",
    );
  });

  it('la réponse à la question d’une mission lui est transmise par l’agent principal, et le passage suivant la voit', async () => {
    const { store, ana, calls, sent, mission, pass } = world({
      responses: [
        finish({ outcome: 'question', notes: 'Deux vols à 590 € : Air France (escale Nairobi) et Air Madagascar.', message: 'Deux vols à 590 € : Air France avec escale ou Air Madagascar direct. Lequel je suis ?' }),
        finish({ outcome: 'continue', notes: 'Suivi : Air Madagascar direct.' }),
      ],
    });
    // La mission a été lancée dans la conversation.
    store.addMessage(ana.id, 'user', 'Surveille le vol Tana → Paris du 4 décembre', 'chat', NOW - 60_000);
    store.addMessage(ana.id, 'assistant', 'Je le surveille toutes les 6 h.', 'chat', NOW - 60_000);
    const m = mission(ana);
    await pass(NOW);
    expect(sent[0]!.text).toBe(
      `🎯 **Mission #${m.id}** · Vol Tana → Paris — une question\n\nDeux vols à 590 € : Air France avec escale ou Air Madagascar direct. Lequel je suis ?\n\n_Réponds-moi ici : je lui transmets._`,
    );

    const { create, calls: chat } = scriptedCreate([
      message([toolUse('u1', 'mission_update', { id: m.id, note: 'Suivre le vol Air Madagascar direct.' })], 'tool_use'),
      message([text('C’est transmis : je suis le vol Air Madagascar direct.')], 'end_turn'),
    ]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, missions: { minHours: 1, defaultMaxCostUsd: 0.25 }, now: () => NOW + 10 * 60_000 });
    await agent({ userId: ana.id, kind: 'chat', text: 'Air Madagascar, le direct' });
    // La question de la mission est dans l'historique que voit l'agent principal.
    expect(JSON.stringify(chat[0]!.messages)).toContain('Lequel je suis ?');

    const after = store.getMission(ana.id, m.id)!;
    expect(after.nextRunAt).toBe(NOW + HOUR);
    await pass(NOW + HOUR);
    expect(String(calls[1]!.messages[0]!.content)).toContain('<consignes>\n- [mer. 14 oct. 2026, 19:10] Suivre le vol Air Madagascar direct.\n</consignes>');
  });
});
