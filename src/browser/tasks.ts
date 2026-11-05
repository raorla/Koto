import { emptyUsage, type BrowserTask, type Store, type User } from '../store.js';
import { localDay } from '../time.js';
import { silentLogger, type Logger } from '../util.js';
import type { Answer, BrowseOptions, BrowseResult, TaskQuestion } from './agent.js';
import type { CredentialBroker } from './credentials.js';
import type { BrowserEngine } from './engine.js';

// Les tâches web tournent en arrière-plan : la conversation continue pendant ce temps, et les
// questions (confirmation, prise en main, connexion) arrivent sur Telegram avec des boutons.

export interface TaskNotifier {
  question(user: User, task: BrowserTask, questionId: number, question: TaskQuestion): Promise<void>;
  finished(user: User, task: BrowserTask, result: BrowseResult): Promise<void>;
}

/** Réglages communs à toutes les tâches (modèle, limites…). */
export type BrowseSettings = Pick<BrowseOptions, 'create' | 'provider' | 'model' | 'effort' | 'maxSteps' | 'maxCostUsd' | 'log'>;

export interface BrowserTasksDeps {
  store: Store;
  engine: BrowserEngine;
  settings: BrowseSettings;
  /** Boucle du sous-agent (remplaçable dans les tests). */
  browse: (options: BrowseOptions) => Promise<BrowseResult>;
  notifier: TaskNotifier;
  /** Gestionnaire de mots de passe de cette personne, s'il en a un (propriétaire du bot seulement). */
  credentialsFor: (user: User) => CredentialBroker | null;
  /** La personne voit-elle la fenêtre du navigateur (et peut donc prendre la main) ? */
  canHandOver: (user: User) => boolean;
  log?: Logger;
  now?: () => number;
  maxConcurrent?: number;
  questionTimeoutMs?: number;
}

export type StartResult = { ok: true; task: BrowserTask } | { ok: false; reason: 'busy'; task: BrowserTask };

const STATUS_LABELS = { done: 'terminée', failed: 'en échec', stopped: 'arrêtée' } as const;

export class BrowserTasks {
  private readonly queue: number[] = [];
  private readonly running = new Map<number, AbortController>();
  private readonly waiting = new Map<number, { taskId: number; userId: number; resolve: (answer: Answer) => void; timer: NodeJS.Timeout }>();
  /** Tâches lancées par une mission : leur résultat revient à la mission, pas à la personne. */
  private readonly forMission = new Map<number, { maxCostUsd: number; resolve: (result: BrowseResult) => void }>();
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly deps: BrowserTasksDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
  }

  /** Au démarrage : marque en échec les tâches coupées par un arrêt et renvoie la liste. */
  recoverInterrupted(): BrowserTask[] {
    return this.deps.store.failInterruptedBrowserTasks(this.now());
  }

  /** Lance une tâche ; une seule à la fois par personne. */
  start(user: User, goal: string, startUrl: string | null): StartResult {
    const active = this.deps.store.activeBrowserTask(user.id);
    if (active) return { ok: false, reason: 'busy', task: active };
    const task = this.deps.store.addBrowserTask(user.id, goal, startUrl, this.now());
    this.queue.push(task.id);
    this.log.info('browser task queued', { userId: user.id, taskId: task.id });
    this.pump();
    return { ok: true, task };
  }

  /**
   * Tâche web d'une mission : même file et mêmes garde-fous, mais personne à qui poser de question (tout clic qui
   * engage est donc refusé), ni 1Password ni prise en main. Le résultat revient à la mission, qui compte son coût et
   * décide quoi dire. null si une tâche de la personne tourne déjà (une seule à la fois).
   */
  runForMission(user: User, goal: string, startUrl: string | null, maxCostUsd: number): Promise<BrowseResult> | null {
    const active = this.deps.store.activeBrowserTask(user.id);
    if (active) return null;
    const task = this.deps.store.addBrowserTask(user.id, goal, startUrl, this.now());
    const result = new Promise<BrowseResult>((resolve) => this.forMission.set(task.id, { maxCostUsd, resolve }));
    this.queue.push(task.id);
    this.log.info('browser task queued', { userId: user.id, taskId: task.id, mission: true });
    this.pump();
    return result;
  }

  /** Réponse de la personne à une question (bouton Telegram). Faux si la question n'attend plus. */
  answer(user: User, questionId: number, answer: 'yes' | 'no' | 'done'): boolean {
    const entry = this.waiting.get(questionId);
    if (!entry || entry.userId !== user.id) return false;
    return this.settle(questionId, answer);
  }

  cancel(user: User, taskId: number): boolean {
    const task = this.deps.store.getBrowserTask(taskId);
    if (!task || task.userId !== user.id) return false;
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.deps.store.finishBrowserTask(taskId, 'stopped', 'Tâche annulée à ta demande.', 0, 0, this.now());
      this.forMission.get(taskId)?.resolve({ status: 'stopped', summary: 'Tâche annulée par la personne.', usage: emptyUsage(), steps: 0 });
      this.forMission.delete(taskId);
      return true;
    }
    const controller = this.running.get(taskId);
    if (!controller) return false;
    controller.abort();
    for (const [questionId, entry] of this.waiting) if (entry.taskId === taskId) this.settle(questionId, 'cancelled');
    return true;
  }

  /** Arrêt du processus : annule tout ce qui tourne. */
  shutdown(): void {
    for (const controller of this.running.values()) controller.abort();
    for (const questionId of [...this.waiting.keys()]) this.settle(questionId, 'cancelled');
  }

  private pump(): void {
    const max = this.deps.maxConcurrent ?? 2;
    while (this.running.size < max && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      const controller = new AbortController();
      this.running.set(taskId, controller);
      void this.run(taskId, controller).finally(() => {
        this.running.delete(taskId);
        this.pump();
      });
    }
  }

  private async run(taskId: number, controller: AbortController): Promise<void> {
    const { store, engine, notifier } = this.deps;
    const task = store.getBrowserTask(taskId);
    const user = task ? store.getUserById(task.userId) : null;
    const mission = this.forMission.get(taskId);
    if (!task || !user) {
      // Compte effacé entre-temps : la mission n'attend pas pour rien.
      this.forMission.delete(taskId);
      mission?.resolve({ status: 'failed', summary: 'Tâche introuvable.', usage: emptyUsage(), steps: 0 });
      return;
    }
    store.setBrowserTaskStatus(taskId, 'running', this.now());

    let result: BrowseResult;
    let session: Awaited<ReturnType<BrowserEngine['open']>> | null = null;
    try {
      session = await engine.open(store.ensureExternalId(user.id));
      result = await this.deps.browse({
        ...this.deps.settings,
        ...(mission ? { maxCostUsd: Math.min(this.deps.settings.maxCostUsd, mission.maxCostUsd) } : {}),
        session,
        user,
        goal: task.goal,
        startUrl: task.startUrl,
        // Une mission tourne sans la personne : aucune confirmation possible, donc aucun clic qui engage.
        ask: mission ? async () => 'no' : (question) => this.ask(user, task, question),
        credentials: mission ? null : this.deps.credentialsFor(user),
        canHandOver: mission ? false : this.deps.canHandOver(user),
        signal: controller.signal,
        now: this.now,
      });
    } catch (err) {
      this.log.error('browser task crashed', err, { userId: user.id, taskId });
      result = { status: 'failed', summary: "Le navigateur a rencontré une erreur et j'ai dû m'arrêter.", usage: emptyUsage(), steps: 0 };
    } finally {
      await session?.close();
    }
    if (controller.signal.aborted && result.status !== 'done') {
      result = { ...result, status: 'stopped', summary: 'Tâche annulée à ta demande.' };
    }

    const at = this.now();
    store.finishBrowserTask(taskId, result.status, result.summary, result.steps, result.usage.costUsd, at);
    if (mission) {
      // La mission compte le coût (budget du jour et plafond de la mission) et décide quoi dire à la personne.
      this.forMission.delete(taskId);
      this.log.info('browser task finished', { userId: user.id, taskId, mission: true, status: result.status, steps: result.steps, costUsd: Number(result.usage.costUsd.toFixed(4)) });
      mission.resolve(result);
      return;
    }
    store.addUsage(user.id, localDay(at, user.timezone), result.usage);
    // Dans l'historique : au message suivant, Koto sait ce que la tâche a donné.
    store.addMessage(user.id, 'assistant', `🌐 Tâche web #${taskId} ${STATUS_LABELS[result.status]} : ${result.summary}`, 'chat', at);
    this.log.info('browser task finished', { userId: user.id, taskId, status: result.status, steps: result.steps, costUsd: Number(result.usage.costUsd.toFixed(4)) });
    await notifier.finished(user, store.getBrowserTask(taskId)!, result).catch((err) => this.log.error('task notification failed', err, { taskId }));
  }

  private ask(user: User, task: BrowserTask, question: TaskQuestion): Promise<Answer> {
    const { store, notifier } = this.deps;
    const questionId = store.addTaskQuestion(task.id, user.id, question.kind, question.text, this.now());
    store.setBrowserTaskStatus(task.id, 'waiting', this.now());
    const answered = new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => this.settle(questionId, 'timeout'), this.deps.questionTimeoutMs ?? 30 * 60_000);
      this.waiting.set(questionId, { taskId: task.id, userId: user.id, resolve, timer });
    });
    notifier.question(user, task, questionId, question).catch((err) => {
      this.log.error('task question failed', err, { taskId: task.id });
      this.settle(questionId, 'no');
    });
    return answered.finally(() => store.setBrowserTaskStatus(task.id, 'running', this.now()));
  }

  private settle(questionId: number, answer: Answer): boolean {
    const entry = this.waiting.get(questionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.waiting.delete(questionId);
    this.deps.store.answerTaskQuestion(questionId, answer, this.now());
    entry.resolve(answer);
    return true;
  }
}
