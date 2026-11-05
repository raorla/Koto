// Lancement des missions. À chaque tour du scheduler, les passages dus partent en arrière-plan (un passage ne
// retarde jamais un rappel), quelques-uns à la fois. Chaque passage compte dans le budget du jour de qui paie, et la
// mission s'arrête d'elle-même : objectif atteint, date limite, plafond de coût, erreurs répétées. La personne ne reçoit
// que les résultats ; ses messages entrent dans l'historique, pour que Koto sache de quoi on parle.
import { budgetStatus, payerFor, recordUsage } from '../accounts.js';
import type { CreateMessage } from '../agent/agent.js';
import { LIMITS } from '../agent/tools.js';
import type { BrowseResult } from '../browser/agent.js';
import type { Config } from '../config.js';
import type { Integrations } from '../integrations/types.js';
import type { NewsService } from '../news.js';
import { voiceForMission } from '../speech.js';
import type { Mission, PendingAction, Store, User } from '../store.js';
import { silentLogger, type KeyedLock, type Logger } from '../util.js';
import type { WeatherService } from '../weather.js';
import { MISSION_LIMITS, endText, progressText, type MissionSettings } from './missions.js';
import { buildPassTools, passSystemPrompt, runMissionPass, type PassResult } from './pass.js';

/** Ce que les missions envoient sur Telegram (ou dans le terminal). */
export interface MissionNotifier {
  /** Message d'une mission à la personne, ou au groupe (Markdown léger). */
  send(account: User, text: string): Promise<void>;
  /** Action préparée pendant un passage (mail, rendez-vous), avec Confirmer / Annuler. */
  confirm(chatId: number, action: PendingAction): Promise<void>;
  /** Propose de garder la conclusion d'une mission terminée dans la mémoire principale. */
  proposeConclusion(account: User, mission: Mission): Promise<void>;
  /** Lit le message à voix haute ; absent = pas de synthèse vocale. */
  speak?(account: User, text: string): Promise<void>;
}

/** Tâches web lancées par une mission (implémenté par BrowserTasks.runForMission). */
export interface MissionBrowser {
  runForMission(user: User, goal: string, startUrl: string | null, maxCostUsd: number): Promise<BrowseResult> | null;
}

export interface MissionRunnerDeps {
  store: Store;
  config: Config;
  create: CreateMessage;
  notifier: MissionNotifier;
  locks: KeyedLock;
  log?: Logger;
  news?: NewsService | null;
  weather?: WeatherService | null;
  integrations?: Integrations | null;
  browser?: MissionBrowser | null;
  now?: () => number;
  /** Passages en même temps, tous comptes confondus. */
  maxConcurrent?: number;
  /** Requêtes au modèle par passage. */
  maxSteps?: number;
}

export type KeepResult = 'kept' | 'missing' | 'full';

const HOUR = 3_600_000;
const MAX_FAILURES = 3;
/** En dessous, un passage ne vaut pas la peine d'être lancé. */
const MIN_RUN_USD = 0.002;
/** Un passage qui part un peu avant la date limite (gigue du scheduler) est le dernier. */
const FINAL_MARGIN_MS = 60_000;
const MAX_STORED_CHARS = 8_000;

const clip = (text: string) => (text.length <= MAX_STORED_CHARS ? text : `${text.slice(0, MAX_STORED_CHARS)}… [tronqué]`);

export class MissionRunner {
  /** Limites passées à l'agent principal (mission_start) : les mêmes pour tout le monde. */
  readonly settings: MissionSettings;
  private readonly system: string;
  private readonly tools: ReturnType<typeof buildPassTools>;
  private readonly inFlight = new Set<number>();
  private readonly running = new Set<Promise<void>>();
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly deps: MissionRunnerDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.settings = { minHours: deps.config.missionMinHours, defaultMaxCostUsd: deps.config.missionMaxCostUsd };
    // Prompt et outils figés au démarrage : identiques pour toutes les missions, donc partagés en cache.
    const features = {
      webTools: deps.config.webTools,
      news: Boolean(deps.news),
      weather: Boolean(deps.weather),
      browser: Boolean(deps.browser),
      integrations: deps.integrations?.tools ?? [],
    };
    this.system = passSystemPrompt(features);
    this.tools = buildPassTools(features);
  }

  /** Lance les passages dus sans les attendre (appelé à chaque tour du scheduler) ; renvoie le nombre de passages partis. */
  dispatch(at: number): number {
    const { store, config } = this.deps;
    const max = this.deps.maxConcurrent ?? 2;
    let started = 0;
    for (const mission of store.dueMissions(at)) {
      if (this.inFlight.size >= max) break;
      if (this.inFlight.has(mission.id)) continue;
      const account = store.getUserById(mission.userId);
      if (!account) continue;
      const final = mission.deadlineAt !== null && at >= mission.deadlineAt - FINAL_MARGIN_MS;
      const missionLeft = mission.maxCostUsd - mission.costUsd;
      if (missionLeft < MIN_RUN_USD) {
        // Plafond atteint au passage précédent : on s'arrête là, sans rien dépenser.
        this.end(account, mission, 'budget', null, [], at);
        continue;
      }
      const payer = payerFor(store, account);
      if (!payer && final) {
        // Groupe que plus personne ne paie, et date limite passée : fin sans passage (gratuit).
        this.end(account, mission, 'deadline', "Plus personne n'est rattaché à ce groupe pour payer ses passages : je m'arrête là.", [], at);
        continue;
      }
      const budget = payer ? budgetStatus(store, config, payer, at) : null;
      const dailyLeft = budget === null ? 0 : budget.limitUsd === null ? Infinity : budget.limitUsd - budget.spentUsd;
      if (dailyLeft < MIN_RUN_USD) {
        // Personne pour payer, ou budget du jour épuisé : le passage attend, gratuitement.
        store.postponeMission(account.id, mission.id, at + HOUR, at);
        this.log.info('mission skipped', { userId: account.id, missionId: mission.id, reason: payer ? 'budget' : 'no_payer' });
        continue;
      }
      // Un dernier passage raté est retenté une heure plus tard ; les autres suivent le rythme, sans dépasser la date limite.
      const next = final ? at + HOUR : Math.min(at + mission.intervalMinutes * 60_000, mission.deadlineAt ?? Infinity);
      if (!store.claimMissionRun(account.id, mission.id, at, next)) continue;
      const maxCostUsd = Math.min(config.missionRunMaxCostUsd, missionLeft, dailyLeft);
      this.inFlight.add(mission.id);
      this.track(
        this.run(mission, account, at, final, maxCostUsd)
          .catch((err) => this.log.error('mission run crashed', err, { userId: account.id, missionId: mission.id }))
          .finally(() => this.inFlight.delete(mission.id)),
      );
      started++;
    }
    return started;
  }

  /** Attend la fin des passages et des messages en cours. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  /** Arrêt par la personne (bouton de /missions) ; faux si la mission n'était plus en cours. */
  stop(account: User, missionId: number, now: number): boolean {
    const { store } = this.deps;
    const mission = store.getMission(account.id, missionId);
    if (!mission || !store.endMission(account.id, missionId, { status: 'stopped', reason: 'person' }, now)) return false;
    // Dans l'historique : Koto ne présentera plus cette mission comme en cours.
    store.addMessage(account.id, 'assistant', `⏹️ Mission #${missionId} « ${mission.title} » arrêtée depuis /missions.`, 'mission', now);
    this.log.info('mission ended', { userId: account.id, missionId, status: 'stopped', reason: 'person' });
    return true;
  }

  /** Garde la conclusion d'une mission terminée dans la mémoire du compte ; jamais ses notes de travail. */
  keepConclusion(account: User, missionId: number, now: number): KeepResult {
    const { store } = this.deps;
    return store.transaction(() => {
      const mission = store.getMission(account.id, missionId);
      if (!mission?.conclusion || mission.conclusionState !== 'proposed') return 'missing';
      const conclusion = mission.conclusion;
      const memories = store.listMemories(account.id);
      const known = memories.some((m) => m.content.toLowerCase() === conclusion.toLowerCase());
      if (!known && memories.length >= LIMITS.memories) return 'full';
      if (!known) store.addMemory(account.id, { kind: 'note', content: conclusion.slice(0, LIMITS.memoryChars), importance: 2 }, now);
      store.decideMissionConclusion(account.id, missionId, 'kept', now);
      return 'kept';
    });
  }

  dropConclusion(account: User, missionId: number, now: number): boolean {
    return this.deps.store.decideMissionConclusion(account.id, missionId, 'declined', now);
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  private async run(mission: Mission, account: User, at: number, final: boolean, maxCostUsd: number): Promise<void> {
    const { store, config } = this.deps;
    const browser = this.deps.browser ?? null;
    let result: PassResult;
    try {
      result = await runMissionPass({
        create: this.deps.create,
        provider: config.provider,
        model: config.missionModel,
        effort: config.effort,
        system: this.system,
        tools: this.tools,
        store,
        services: {
          news: this.deps.news ?? null,
          weather: this.deps.weather ?? null,
          integrations: this.deps.integrations ?? null,
          browse: browser ? (user, goal, startUrl, cost) => browser.runForMission(user, goal, startUrl, cost) : null,
        },
        mission,
        account,
        final,
        maxCostUsd,
        maxSteps: this.deps.maxSteps ?? 8,
        stillActive: () => store.getMission(account.id, mission.id)?.status === 'active',
        now: this.now,
        log: this.log,
      });
    } catch (err) {
      // Erreur d'API ou de réseau : le passage suivant réessaie ; après plusieurs échecs de suite, la mission s'arrête.
      this.log.error('mission run failed', err, { userId: account.id, missionId: mission.id, run: mission.runs + 1 });
      this.recordFailure(account, mission);
      return;
    }

    const doneAt = this.now();
    // Compte effacé pendant le passage : plus rien à enregistrer ni à dire.
    if (!store.getUserById(account.id)) return;
    // Le coût est compté même si la mission a été arrêtée pendant le passage : il a été dépensé.
    recordUsage(store, account, at, result.usage);
    const notes =
      result.status === 'incomplete'
        ? `${mission.notes.trim()}\n[Passage n° ${mission.runs + 1} interrompu : plafond ou nombre d'étapes atteint avant la fin.]`.trim().slice(-MISSION_LIMITS.notesChars)
        : result.notes;
    store.recordMissionRun(account.id, mission.id, { costUsd: result.usage.costUsd, notes, failed: result.status === 'refused' }, doneAt);
    const fresh = store.getMission(account.id, mission.id);
    this.log.info('mission run', {
      userId: account.id,
      missionId: mission.id,
      run: mission.runs + 1,
      final,
      status: result.status,
      outcome: result.outcome,
      steps: result.steps,
      costUsd: Number(result.usage.costUsd.toFixed(5)),
      webSearches: result.usage.webSearches,
    });

    if (!fresh || fresh.status !== 'active' || result.status === 'refused') {
      // Arrêtée ou effacée pendant le passage, ou passage refusé : rien ne part, et ce qu'il avait préparé est annulé.
      for (const action of result.pendingActions) store.cancelPendingAction(account.id, action.id, doneAt);
      if (fresh?.status === 'active' && fresh.failures >= MAX_FAILURES) this.end(account, fresh, 'errors', null, [], doneAt);
      return;
    }

    let outcome = result.outcome;
    let message = result.message;
    if (result.pendingActions.length > 0 && outcome === 'continue') {
      // Un mail ou un rendez-vous préparé doit lui être présenté, même sans autre nouvelle.
      outcome = 'notify';
      message ??= "J'ai préparé ceci pour toi, à confirmer :";
    }
    if (outcome === 'done' || final || fresh.costUsd >= fresh.maxCostUsd - MIN_RUN_USD) {
      const reason = outcome === 'done' ? 'goal' : final ? 'deadline' : 'budget';
      this.end(account, fresh, reason, message, result.pendingActions, doneAt, reason === 'budget' ? null : result.conclusion);
      return;
    }
    if (outcome !== 'continue' && message) await this.deliver(account, fresh, progressText(fresh, outcome, message), result.pendingActions);
  }

  /** Termine la mission et prévient la personne (sa conclusion éventuelle lui est proposée pour la mémoire). */
  private end(
    account: User,
    mission: Mission,
    reason: 'goal' | 'deadline' | 'budget' | 'errors',
    message: string | null,
    actions: PendingAction[],
    at: number,
    conclusion: string | null = null,
  ): void {
    const { store } = this.deps;
    const status = reason === 'goal' || reason === 'deadline' ? 'done' : reason === 'budget' ? 'stopped' : 'failed';
    if (!store.endMission(account.id, mission.id, { status, reason, conclusion }, at)) return;
    this.log.info('mission ended', { userId: account.id, missionId: mission.id, status, reason });
    const ended = store.getMission(account.id, mission.id)!;
    this.track(this.deliver(account, ended, endText(ended, reason, message, ended.failures), actions));
  }

  private recordFailure(account: User, mission: Mission): void {
    const { store } = this.deps;
    if (!store.getUserById(account.id)) return;
    store.recordMissionRun(account.id, mission.id, { costUsd: 0, notes: null, failed: true }, this.now());
    const fresh = store.getMission(account.id, mission.id);
    if (fresh?.status === 'active' && fresh.failures >= MAX_FAILURES) this.end(account, fresh, 'errors', null, [], this.now());
  }

  private async deliver(account: User, mission: Mission, text: string, actions: PendingAction[]): Promise<void> {
    const { store, notifier, locks } = this.deps;
    // Sous le verrou du compte : le message s'intercale entre deux tours de conversation, jamais au milieu.
    await locks.run(account.id, async () => {
      const fresh = store.getUserById(account.id);
      if (!fresh) return;
      // Dans l'historique : au message suivant, Koto sait ce que la mission a trouvé, et la personne peut lui répondre.
      store.addMessage(fresh.id, 'assistant', clip(text), 'mission', this.now());
      try {
        await notifier.send(fresh, text);
        for (const action of actions) await notifier.confirm(fresh.chatId, action);
        const ended = store.getMission(fresh.id, mission.id);
        if (ended?.conclusionState === 'proposed' && ended.conclusion) await notifier.proposeConclusion(fresh, ended);
      } catch (err) {
        this.log.error('mission notification failed', err, { userId: fresh.id, missionId: mission.id });
        return;
      }
      // Le texte est parti : un vocal raté ne rejoue rien.
      if (notifier.speak && voiceForMission(fresh)) {
        await notifier.speak(fresh, text).catch((err: unknown) => this.log.error('voice message failed', err, { userId: fresh.id }));
      }
    });
  }
}
