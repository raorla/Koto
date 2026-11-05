import type Anthropic from '@anthropic-ai/sdk';
import { recordUsage } from '../accounts.js';
import type { Effort, Provider } from '../config.js';
import type { Toolkit } from '../integrations/catalog.js';
import type { Integrations } from '../integrations/types.js';
import { FICHE_HINT, extractFiche, withFiche, type FileFetcher } from '../memory/documents.js';
import type { MissionSettings } from '../missions/missions.js';
import { emptyUsage, type DocumentKind, type PendingAction, type Store, type UsageTotals } from '../store.js';
import { silentLogger, type Logger } from '../util.js';
import { addTotals, usageToTotals } from './pricing.js';
import {
  MAX_LIST_ITEMS_IN_CONTEXT,
  renderGroupContext,
  renderHistory,
  renderUserContext,
  selectHistoryWindow,
  stampUserText,
  systemPrompt,
} from './prompt.js';
import type { WeatherService } from '../weather.js';
import { buildTools, runTool, type BrowserLauncher } from './tools.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** Champs propres à OpenRouter : absents des types du SDK, envoyés tels quels dans le corps de la requête. */
interface OpenRouterParams {
  /** Regroupe les requêtes d'une conversation (suivi dans OpenRouter, routage stable). */
  session_id?: string;
  /** Ordre des hébergeurs du modèle : Anthropic d'abord (recherche web native, cache stable). */
  provider?: { order: string[]; allow_fallbacks: boolean };
}
export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming & OpenRouterParams;

/** L'appel API, injecté pour pouvoir tester l'agent sans réseau. */
export type CreateMessage = (params: CreateParams) => Promise<BetaMessage>;

export type TurnKind = 'chat' | 'brief' | 'checkin';

export interface TurnRequest {
  /** Compte du tour : la personne, ou le groupe (dont seules les données entrent alors dans le contexte). */
  userId: number;
  /** Texte envoyé au modèle pour ce tour. */
  text: string;
  /** Version gardée dans l'historique (par défaut : `text`). */
  historyText?: string;
  /** Photos / PDF joints à ce tour uniquement (pas gardés dans l'historique). */
  attachments?: BetaContentBlockParam[];
  /**
   * Photo ou PDF joint : le modèle en écrit la fiche (<fiche>…</fiche>) dans sa réponse, et Koto la garde (table
   * documents et message de l'historique) pour que search_history le retrouve.
   */
  document?: { kind: DocumentKind; name: string; fileId: string | null };
  kind: TurnKind;
}

export interface TurnResult {
  text: string;
  status: 'ok' | 'refused' | 'truncated' | 'too_many_steps';
  usage: UsageTotals;
  /** Actions préparées pendant le tour (mail, événement…), à présenter avec Confirmer / Annuler. */
  pendingActions: PendingAction[];
  /** Le modèle a demandé que cette réponse parte aussi en vocal (reply_by_voice). */
  voice?: boolean;
}

export type Agent = (request: TurnRequest) => Promise<TurnResult>;

export interface AgentOptions {
  create: CreateMessage;
  store: Store;
  /** Fournisseur derrière `create` ; `anthropic` par défaut. */
  provider?: Provider;
  model: string;
  effort: Effort;
  webTools: boolean;
  /** Gmail / Google Agenda ; absent = intégrations désactivées. */
  integrations?: Integrations | null;
  /** Tâches dans le navigateur ; absent = browse_web désactivé. */
  browser?: BrowserLauncher | null;
  /** Réponses vocales disponibles (synthèse vocale configurée). */
  speech?: boolean;
  /** Veille d'actualité dans le brief (flux RSS gratuits, recherche web en dernier recours). */
  news?: boolean;
  /** Météo et lieux gratuits ; absent = outils météo désactivés. */
  weather?: WeatherService | null;
  /** Appels en direct (mini-app Telegram) : consigne de réponse courte, faite pour l'oral. */
  calls?: boolean;
  /** Missions de fond (mission_start, mission_update) ; absent = désactivées. */
  missions?: MissionSettings | null;
  /** Retélécharge un fichier reçu (Telegram) pour open_document ; absent (CLI) = l'outil répond qu'il n'est pas disponible. */
  fetchFile?: FileFetcher | null;
  now?: () => number;
  log?: Logger;
  maxSteps?: number;
}

// API Anthropic : repli côté serveur si un classifieur de sécurité refuse à tort (la requête est
// rejouée sur le modèle recommandé pour cette catégorie ; sans effet sur un modèle qui ne le gère pas).
// OpenRouter n'a pas ce mécanisme : on y fixe plutôt l'hébergeur et une session par utilisateur.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function routingParams(provider: Provider, userId: number, group = false): Partial<CreateParams> {
  if (provider === 'openrouter') {
    return { session_id: `koto-${group ? 'group' : 'user'}-${userId}`, provider: { order: ['anthropic'], allow_fallbacks: true } };
  }
  return { betas: [FALLBACK_BETA], fallbacks: 'default' };
}
const MAX_TOKENS = 16_000;
const MAX_STORED_CHARS = 8_000;

const REFUSAL_TEXT = "Je ne peux pas t'aider sur ce point, désolé. On parle d'autre chose ?";
const TRUNCATED_TEXT = "Ma réponse a été coupée, elle était trop longue. Tu veux que je la reprenne en plus court ?";
const TOO_MANY_STEPS_TEXT = "Je me suis un peu perdu dans les étapes. Tu peux reformuler ta demande ?";
const EMPTY_TEXT = '👍';

export function createAgent(options: AgentOptions): Agent {
  const { create, store, model, effort } = options;
  const integrations = options.integrations ?? null;
  // Fixés une fois pour toutes : mêmes outils et même prompt pour tous les utilisateurs.
  const browser = options.browser ?? null;
  const weather = options.weather ?? null;
  const missions = options.missions ?? null;
  const fetchFile = options.fetchFile ?? null;
  const features = { speech: options.speech ?? false, news: options.news ?? false, weather: weather !== null, missions: missions !== null };
  const tools = buildTools(options.webTools, integrations?.tools ?? [], browser !== null, { ...features, missions });
  const staticPrompt = systemPrompt({ integrations: integrations !== null, browser: browser !== null, calls: options.calls ?? false, ...features });
  const now = options.now ?? Date.now;
  const log = options.log ?? silentLogger;
  const maxSteps = options.maxSteps ?? 10;

  return async (request) => {
    const startedAt = now();
    const user = store.getUserById(request.userId);
    if (!user) throw new Error(`Utilisateur ${request.userId} introuvable`);
    const group = user.kind === 'group';

    const window = selectHistoryWindow(store.listMessagesAfter(user.id, user.historyStartId));
    if (window.newStartId !== null) store.setHistoryStart(user.id, window.newStartId);

    // Préfixe mis en cache en deux paliers : prompt figé (commun à tous, TTL 1 h), puis le
    // contexte de la personne ou du groupe. Le cache automatique de premier niveau couvre l'historique.
    // En groupe, tout vient du compte du groupe : rien d'un membre n'entre dans le contexte.
    const memories = store.listMemories(user.id);
    const upcoming = store.listPendingJobs(user.id, 15);
    const openItems = store.listOpenItems(user.id, MAX_LIST_ITEMS_IN_CONTEXT + 1);
    const activeMissions = missions ? store.listActiveMissions(user.id) : [];
    const system: BetaTextBlockParam[] = [
      { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
      {
        type: 'text',
        text: group
          ? renderGroupContext(user, memories, upcoming, features, openItems, activeMissions)
          : renderUserContext(user, memories, upcoming, integrations ? store.getConnections(user.id) : null, features, openItems, activeMissions),
        cache_control: { type: 'ephemeral' },
      },
    ];

    // Historique en ajout seul pendant tout le tour : le préfixe ne change jamais entre deux
    // appels de la boucle, ce qui garde valides les blocs de réflexion renvoyés tels quels.
    const messages: BetaMessageParam[] = [
      ...renderHistory(window.messages, user.timezone),
      {
        role: 'user',
        content: [
          ...(request.attachments ?? []),
          { type: 'text', text: stampUserText(request.document ? `${request.text}\n\n${FICHE_HINT}` : request.text, startedAt, user.timezone) },
        ],
      },
    ];

    const routing = routingParams(options.provider ?? 'anthropic', user.id, group);
    const pending: PendingAction[] = [];
    const checked = new Set<Toolkit>();
    const voice = features.speech ? { requested: false } : null;
    const files = fetchFile ? { fetch: fetchFile, opened: false } : null;
    let usage = emptyUsage();
    const texts: string[] = [];
    const sources = new Map<string, string>();
    let outcome: Pick<TurnResult, 'text' | 'status'> | null = null;
    let fiche: string | null = null;
    let steps = 0;

    while (!outcome && steps < maxSteps) {
      steps++;
      const response = await create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages,
        output_config: { effort },
        cache_control: { type: 'ephemeral' },
        ...routing,
      });
      usage = addTotals(usage, usageToTotals(response.usage, response.model));

      // Un refus peut couper une réponse en plein milieu : on n'exécute rien et on jette le partiel.
      if (response.stop_reason === 'refusal') {
        outcome = { text: REFUSAL_TEXT, status: 'refused' };
        break;
      }

      collectText(response, texts, sources);

      if (response.stop_reason === 'pause_turn') {
        // Boucle d'outils serveur (recherche web) en pause : on renvoie tel quel, le serveur reprend.
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      const calls = response.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (response.stop_reason === 'tool_use' && calls.length > 0) {
        messages.push({ role: 'assistant', content: response.content });
        const ctx = { store, userId: user.id, now: now(), integrations, browser, pending, checked, voice, weather, missions, files };
        const results: BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          const result = await runTool(call.name, call.input, ctx);
          if (result.isError) log.warn('tool error', { userId: user.id, tool: call.name });
          // Un document rouvert n'existe que dans ce tool_result : jamais dans l'historique.
          const content = result.block ? [{ type: 'text' as const, text: result.content }, result.block] : result.content;
          results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(result.isError ? { is_error: true } : {}) });
        }
        // Tous les résultats dans un seul message utilisateur.
        messages.push({ role: 'user', content: results });
        continue;
      }

      const final = finalText(texts, sources);
      const text = final.text;
      fiche = final.fiche;
      outcome =
        response.stop_reason === 'max_tokens'
          ? { text: text || TRUNCATED_TEXT, status: 'truncated' }
          : { text: text || EMPTY_TEXT, status: 'ok' };
    }

    // Un tour refusé ne présente pas les actions qu'il aurait préparées : on les annule.
    const refused = outcome?.status === 'refused';
    if (refused) for (const action of pending) store.cancelPendingAction(user.id, action.id, now());
    const result: TurnResult = {
      ...(outcome ?? { text: TOO_MANY_STEPS_TEXT, status: 'too_many_steps' }),
      usage,
      pendingActions: refused ? [] : pending,
      voice: !refused && (voice?.requested ?? false),
    };

    store.transaction(() => {
      // La fiche d'un document rejoint le message de l'historique : Koto la relira, et search_history la trouvera.
      const said = clip(request.historyText ?? request.text);
      const messageId = store.addMessage(user.id, 'user', request.document ? withFiche(said, fiche) : said, request.kind, startedAt);
      if (request.document) store.addDocument(user.id, { ...request.document, messageId, summary: fiche }, startedAt);
      store.addMessage(user.id, 'assistant', clip(result.text), request.kind, now());
      // En groupe, le coût va au budget du jour de la personne rattachée.
      recordUsage(store, user, startedAt, usage);
    });

    log.info('turn', {
      userId: user.id,
      ...(group ? { group: true } : {}),
      kind: request.kind,
      status: result.status,
      ...(request.document ? { document: request.document.kind, fiche: fiche !== null } : {}),
      ...(files?.opened ? { documentOpened: true } : {}),
      steps,
      costUsd: Number(usage.costUsd.toFixed(5)),
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      webSearches: usage.webSearches,
    });
    return result;
  };
}

/** Accumule le texte destiné à la personne et les sources web citées, sur tous les appels du tour. */
function collectText(message: BetaMessage, texts: string[], sources: Map<string, string>): void {
  let text = '';
  for (const block of message.content) {
    if (block.type !== 'text') continue;
    text += block.text;
    for (const citation of block.citations ?? []) {
      if (citation.type === 'web_search_result_location' && citation.url) {
        sources.set(citation.url, citation.title || citation.url);
      }
    }
  }
  if (text.trim()) texts.push(text.trim());
}

/** Texte final pour la personne, sans fiche de document (mise à part) et avec les sources web citées. */
function finalText(texts: string[], sources: Map<string, string>): { text: string; fiche: string | null } {
  const { fiche, text: said } = extractFiche(texts.join('\n\n'));
  let text = said;
  const links = [...sources]
    .filter(([url]) => !text.includes(url))
    .slice(0, 3)
    .map(([url, title]) => `[${title.replace(/[[\]]/g, '')}](${url})`);
  if (text && links.length > 0) text += `\n\nSources : ${links.join(' · ')}`;
  return { text, fiche };
}

function clip(text: string): string {
  return text.length <= MAX_STORED_CHARS ? text : `${text.slice(0, MAX_STORED_CHARS)}… [tronqué]`;
}
