// Ménage de la mémoire (niveau integration) : le vrai scheduler lance MemoryKeeper sur une vraie base, face à un
// modèle scripté. On vérifie le déclenchement, le modèle utilisé, le coût, le compte rendu et les garde-fous.
import { describe, expect, it } from 'vitest';
import type { CreateParams } from '../src/agent/agent.js';
import { CONSOLIDATION_PROMPT, MemoryKeeper } from '../src/memory/consolidate.js';
import { createScheduler } from '../src/scheduler.js';
import { emptyUsage, type Store, type User } from '../src/store.js';
import { KeyedLock, silentLogger } from '../src/util.js';
import { NOW, makeConfig, makeGroup, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';

const DAY = 86_400_000;

/** Un modèle qui fusionne les deux premiers souvenirs et archive le dernier, d'après les ids qu'il lit. */
function tidy(params: CreateParams) {
  const context = String(params.messages[0]!.content);
  const ids = [...context.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
  const reply = message(
    [
      toolUse('c1', 'consolidate', {
        merges: [{ ids: [ids[0], ids[1]], content: 'Projet Koto : agent IA sur Telegram, lancé en octobre 2026' }],
        updates: [],
        archives: [{ id: ids.at(-1), reason: 'passé' }],
      }),
    ],
    'tool_use',
    { input_tokens: 4_000, output_tokens: 300 },
  );
  // Le coût suit le modèle qui a vraiment répondu.
  return { ...reply, model: params.model };
}

function fill(store: Store, account: User, n: number) {
  for (let i = 0; i < n; i++) {
    store.addMemory(account.id, { kind: 'note', content: i === 0 ? 'Projet Koto' : i === 1 ? 'Koto est sur Telegram' : `Souvenir n° ${i}`, importance: 2 }, NOW - 10 * DAY);
  }
}

function setup(responses: Parameters<typeof scriptedCreate>[0], config = makeConfig()) {
  const store = makeStore();
  const { create, calls } = scriptedCreate(responses);
  const sent: { account: User; text: string }[] = [];
  const keeper = new MemoryKeeper({
    store,
    config,
    create,
    notifier: { send: async (account, text) => void sent.push({ account, text }) },
    locks: new KeyedLock(),
    log: silentLogger,
    now: () => NOW,
  });
  const scheduler = createScheduler({
    store,
    config,
    agent: async () => {
      throw new Error('aucun tour attendu');
    },
    notifier: { send: async () => {} },
    locks: new KeyedLock(),
    log: silentLogger,
    memory: keeper,
    now: () => NOW,
  });
  const tick = async () => {
    await scheduler.tick();
    await keeper.idle();
  };
  return { store, calls, sent, keeper, tick };
}

describe('ménage de la mémoire par le scheduler', () => {
  it('range une mémoire trop lourde avec le modèle le moins cher, compte le coût et prévient la personne', async () => {
    const { store, calls, sent, tick } = setup([tidy]);
    const ana = makeUser(store);
    fill(store, ana, 61);

    await tick();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model).toBe('claude-haiku-5-5');
    expect(call.system).toEqual([{ type: 'text', text: CONSOLIDATION_PROMPT }]);
    expect((call.tools as { name: string }[]).map((t) => t.name)).toEqual(['consolidate']);
    expect(call.output_config).toEqual({ effort: 'low' });
    expect(call.tool_choice).toBeUndefined();
    expect(String(call.messages[0]!.content)).toContain('Mémoire trop lourde');

    expect(store.countMemories(ana.id)).toBe(59);
    expect(store.listArchivedMemories(ana.id)).toHaveLength(3); // fusionné, ancienne version, passé
    expect(store.getUsage(ana.id, '2026-10-14')).toMatchObject({ requests: 1, inputTokens: 4_000, outputTokens: 300 });
    expect(store.getUsage(ana.id, '2026-10-14').costUsd).toBeCloseTo((4_000 * 0.1 + 300 * 0.5) / 1e6);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.account.id).toBe(ana.id);
    expect(sent[0]!.text).toMatch(/^🧹 J'ai rangé ma mémoire :/);
    const report = store.listMessagesAfter(ana.id, 0).at(-1)!;
    expect(report).toMatchObject({ role: 'assistant', kind: 'memory', content: sent[0]!.text });

    // Rien de neuf depuis : le tour suivant ne rappelle pas le modèle.
    await tick();
    expect(calls).toHaveLength(1);
  });

  it('un groupe : payé par la personne rattachée, compte rendu dans le groupe ; sans payeur, rien ne part', async () => {
    const { store, calls, sent, tick } = setup([tidy]);
    const ana = makeUser(store);
    const group = makeGroup(store, ana);
    const orphan = makeGroup(store, null, 'Groupe sans payeur');
    fill(store, group, 60);
    fill(store, orphan, 60);

    await tick();
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.session_id ?? calls[0]!.betas).toBeDefined();
    expect(String(calls[0]!.messages[0]!.content)).toContain('Groupe Telegram : Sortie Andasibe');
    expect(store.getUsage(ana.id, '2026-10-14').requests).toBe(1);
    expect(store.getUsage(group.id, '2026-10-14').requests).toBe(0);
    expect(sent.map((s) => s.account.id)).toEqual([group.id]);
    expect(sent[0]!.text).toMatch(/^🧹 J'ai rangé la mémoire du groupe/);
    expect(store.countMemories(orphan.id)).toBe(60);
  });

  it('attend sans rien dépenser quand le budget du jour ne couvre pas le ménage', async () => {
    const { store, calls, tick } = setup([tidy], makeConfig({ dailyBudgetUsd: 0.05 }));
    const ana = makeUser(store);
    fill(store, ana, 61);
    store.addUsage(ana.id, '2026-10-14', { ...emptyUsage(), costUsd: 0.0499 });

    await tick();

    expect(calls).toHaveLength(0);
    expect(store.countMemories(ana.id)).toBe(61);
  });

  it('un refus ou une réponse sans outil ne change rien, mais le coût est compté', async () => {
    const { store, calls, sent, tick } = setup([message([text('Je ne peux pas.')], 'refusal'), message([text('Tout est propre.')], 'end_turn')]);
    const ana = makeUser(store);
    const bob = makeUser(store);
    fill(store, ana, 61);
    fill(store, bob, 61);

    await tick();
    await tick();

    expect(calls).toHaveLength(2);
    expect(store.countMemories(ana.id)).toBe(61);
    expect(store.countMemories(bob.id)).toBe(61);
    expect(store.listArchivedMemories(ana.id)).toEqual([]);
    expect(sent).toEqual([]);
    expect(store.getUsage(ana.id, '2026-10-14').requests + store.getUsage(bob.id, '2026-10-14').requests).toBe(2);
  });

  it('même prompt et même outil pour tous les comptes, jamais la mémoire d’un autre', async () => {
    const { store, calls, tick } = setup([tidy, tidy]);
    const ana = makeUser(store);
    const bob = makeUser(store);
    fill(store, ana, 61);
    store.addMemory(ana.id, { kind: 'person', content: 'Hery, le frère d’Ana', importance: 2 }, NOW - DAY);
    fill(store, bob, 61);

    await tick();
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.system).toEqual(calls[0]!.system);
    expect(calls[1]!.tools).toEqual(calls[0]!.tools);
    const toBob = calls.find((c) => String(c.messages[0]!.content).includes(`Personne : ${bob.firstName}`) && !String(c.messages[0]!.content).includes('Hery'));
    expect(toBob).toBeDefined();
  });
});
