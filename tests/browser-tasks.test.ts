import { describe, expect, it } from 'vitest';
import type { BrowseOptions, BrowseResult, TaskQuestion } from '../src/browser/agent.js';
import type { CredentialBroker } from '../src/browser/credentials.js';
import type { BrowserEngine, BrowserSession } from '../src/browser/engine.js';
import { BrowserTasks, type BrowserTasksDeps } from '../src/browser/tasks.js';
import { emptyUsage } from '../src/store.js';
import { NOW, makeStore, makeUser } from './helpers.js';

const noSession = { close: async () => {} } as unknown as BrowserSession;

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  if (!condition()) throw new Error('condition jamais remplie');
}

function setup(browse: (options: BrowseOptions) => Promise<BrowseResult>, questionTimeoutMs = 60_000, overrides: Partial<BrowserTasksDeps> = {}) {
  const store = makeStore();
  const user = makeUser(store);
  const other = makeUser(store);
  const questions: { id: number; question: TaskQuestion }[] = [];
  const finished: BrowseResult[] = [];
  const engine: BrowserEngine = { headed: false, open: async () => noSession };
  const tasks = new BrowserTasks({
    store,
    engine,
    settings: { create: async () => { throw new Error('non utilisé'); }, provider: 'anthropic', model: 'm', effort: 'low', maxSteps: 10, maxCostUsd: 1 },
    browse,
    notifier: {
      question: async (_user, _task, id, question) => void questions.push({ id, question }),
      finished: async (_user, _task, result) => void finished.push(result),
    },
    credentialsFor: () => null,
    canHandOver: () => false,
    now: () => NOW,
    questionTimeoutMs,
    ...overrides,
  });
  return { store, user, other, tasks, questions, finished };
}

const done = (summary: string): BrowseResult => ({ status: 'done', summary, usage: { ...emptyUsage(), requests: 3, costUsd: 0.02 }, steps: 3 });

describe('tâches web en arrière-plan', () => {
  it("lance une tâche, en garde la trace et refuse d'en lancer une seconde en même temps", async () => {
    let release!: () => void;
    const { store, user, tasks, finished } = setup(
      (options) => new Promise((resolve) => (release = () => resolve(done(`3 vols trouvés pour « ${options.goal} »`)))),
    );

    const started = tasks.start(user, 'Vols Tana → Paris', 'https://www.airmadagascar.com');
    expect(started.ok).toBe(true);
    expect(tasks.start(user, 'Autre chose', null)).toMatchObject({ ok: false, reason: 'busy' });

    await waitFor(() => typeof release === 'function');
    release();
    await waitFor(() => finished.length === 1);

    const taskId = started.ok ? started.task.id : 0;
    expect(store.getBrowserTask(taskId)).toMatchObject({ status: 'done', steps: 3, costUsd: 0.02 });
    expect(store.listMessagesAfter(user.id, 0).at(-1)?.content).toBe(`🌐 Tâche web #${taskId} terminée : 3 vols trouvés pour « Vols Tana → Paris »`);
    expect(store.getUsage(user.id, '2026-10-14').costUsd).toBeCloseTo(0.02);
    expect(tasks.start(user, 'Nouvelle tâche', null).ok).toBe(true);
  });

  it("transmet la réponse de la personne, et seulement la sienne", async () => {
    const { user, other, tasks, questions, finished } = setup(async (options) => done(`réponse : ${await options.ask({ kind: 'confirm', text: 'Payer 650 € ?' })}`));

    tasks.start(user, 'Payer le vol', null);
    await waitFor(() => questions.length === 1);
    expect(tasks.answer(other, questions[0]!.id, 'yes')).toBe(false);
    expect(tasks.answer(user, questions[0]!.id, 'yes')).toBe(true);
    await waitFor(() => finished.length === 1);

    expect(finished[0]!.summary).toBe('réponse : yes');
    expect(tasks.answer(user, questions[0]!.id, 'no')).toBe(false);
  });

  it("annule une tâche qui attend une réponse", async () => {
    const { store, user, tasks, questions, finished } = setup(async (options) => {
      const answer = await options.ask({ kind: 'handover', text: 'Connecte-toi' });
      return { ...done(`fin : ${answer}`), status: options.signal?.aborted ? 'stopped' : 'done' };
    });

    const started = tasks.start(user, 'Commande Jumia', null);
    await waitFor(() => questions.length === 1);
    expect(tasks.cancel(user, started.ok ? started.task.id : 0)).toBe(true);
    await waitFor(() => finished.length === 1);

    expect(finished[0]).toMatchObject({ status: 'stopped', summary: 'Tâche annulée à ta demande.' });
    expect(store.activeBrowserTask(user.id)).toBeNull();
  });

  it("considère l'absence de réponse comme un refus", async () => {
    const { user, tasks, finished } = setup(async (options) => done(`réponse : ${await options.ask({ kind: 'confirm', text: 'OK ?' })}`), 5);
    tasks.start(user, 'Tâche', null);
    await waitFor(() => finished.length === 1);
    expect(finished[0]!.summary).toBe('réponse : timeout');
  });

  it("tâche d'une mission : aucune question à la personne, ni 1Password ni prise en main, et le résultat revient à la mission", async () => {
    const seen: Pick<BrowseOptions, 'credentials' | 'canHandOver' | 'maxCostUsd'>[] = [];
    const broker = { find: async () => null, reveal: async () => ({ username: 'x', password: 'y' }) } as unknown as CredentialBroker;
    const { store, user, tasks, questions, finished } = setup(
      async (options) => {
        seen.push({ credentials: options.credentials, canHandOver: options.canHandOver, maxCostUsd: options.maxCostUsd });
        return done(`réponse : ${await options.ask({ kind: 'confirm', text: 'Payer 650 € ?' })}`);
      },
      60_000,
      { credentialsFor: () => broker, canHandOver: () => true },
    );

    const result = await tasks.runForMission(user, 'Prix du vol Tana → Paris du 4 déc.', null, 0.04)!;

    // Personne pour confirmer : tout clic qui engage est refusé d'office.
    expect(result.summary).toBe('réponse : no');
    expect(seen).toEqual([{ credentials: null, canHandOver: false, maxCostUsd: 0.04 }]);
    expect(questions).toEqual([]);
    expect(finished).toEqual([]);
    // La mission compte le coût et décide quoi dire : rien au budget ni à l'historique ici.
    expect(store.getUsage(user.id, '2026-10-14').costUsd).toBe(0);
    expect(store.listMessagesAfter(user.id, 0)).toEqual([]);
    expect(store.listBrowserTasks(user.id)).toEqual([expect.objectContaining({ status: 'done', result: 'réponse : no', costUsd: 0.02 })]);

    // Une tâche à la fois par personne, mission comprise.
    const running = store.addBrowserTask(user.id, 'Autre tâche', null, NOW);
    store.setBrowserTaskStatus(running.id, 'running', NOW);
    expect(tasks.runForMission(user, 'Encore', null, 0.04)).toBeNull();
  });

  it('marque en échec les tâches coupées par un redémarrage', () => {
    const { store, user, tasks } = setup(async () => done('x'));
    const task = store.addBrowserTask(user.id, 'Tâche coupée', null, NOW);
    store.setBrowserTaskStatus(task.id, 'running', NOW);

    expect(tasks.recoverInterrupted().map((t) => t.id)).toEqual([task.id]);
    expect(store.getBrowserTask(task.id)).toMatchObject({ status: 'failed', result: 'Interrompue par un redémarrage de Koto.' });
  });
});
