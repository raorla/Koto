import type Anthropic from '@anthropic-ai/sdk';
import { canonicalModel } from '../models.js';
import { emptyUsage, type UsageTotals } from '../store.js';

type BetaUsage = Anthropic.Beta.Messages.BetaUsage;

interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

// USD par million de tokens, tarifs publics de l'API Anthropic (octobre 2026).
// Écriture cache : 1,25× l'entrée (TTL 5 min) ou 2× (TTL 1 h).
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
};

const DEFAULT_PRICE = PRICES['claude-opus-5-5']!;

/** Recherche web : 10 $ les 1 000 requêtes, en plus des tokens des résultats. */
export const WEB_SEARCH_USD = 10 / 1000;

/** Tarif d'un modèle de synthèse vocale, tel que l'affiche le catalogue OpenRouter. */
export interface SpeechPricing {
  /** USD par caractère lu : la plupart des modèles facturent au caractère. */
  usdPerChar: number;
  /** USD par seconde d'audio produite : quelques modèles facturent à la durée. */
  usdPerSecond: number;
}

// Repli si le catalogue est injoignable au démarrage : le tarif le plus élevé des voix courantes
// (ElevenLabs v3/v4, 40 $ le million de caractères), pour ne jamais sous-estimer le budget du jour.
export const FALLBACK_SPEECH_PRICING: SpeechPricing = { usdPerChar: 40 / 1_000_000, usdPerSecond: 0 };

/** Coût estimé d'un message vocal : OpenRouter ne renvoie pas le coût réel de la synthèse. */
export function speechCostUsd(chars: number, seconds: number, pricing: SpeechPricing): number {
  return chars * pricing.usdPerChar + seconds * pricing.usdPerSecond;
}

// Les ids OpenRouter ("anthropic/claude-opus-5.5") ont les mêmes tarifs que leur équivalent Anthropic.
export function hasKnownPrice(model: string): boolean {
  return canonicalModel(model) in PRICES;
}

function priceFor(model: string): Price {
  return PRICES[canonicalModel(model)] ?? DEFAULT_PRICE;
}

/** Le modèle connu le moins cher (entrée + sortie) : par défaut pour les tâches de fond, comme le ménage de la mémoire. */
export function cheapestModel(): string {
  const [id] = Object.entries(PRICES).sort(([, a], [, b]) => a.input + a.output - (b.input + b.output))[0]!;
  return id;
}

/** Coût estimé d'une requête sans cache : pour vérifier le budget du jour avant une tâche de fond. */
export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Convertit le `usage` d'une réponse en totaux et en coût.
 * Si `usage.iterations` est présent (repli sur un autre modèle après un refus, compaction…),
 * c'est la source de vérité par tentative : le `usage` de premier niveau ne couvre que la dernière.
 */
export function usageToTotals(usage: BetaUsage, model: string): UsageTotals {
  const totals = emptyUsage();
  totals.requests = 1;

  const entries = usage.iterations && usage.iterations.length > 0 ? usage.iterations : [usage];
  for (const entry of entries) {
    const entryModel = 'model' in entry && entry.model ? entry.model : model;
    const price = priceFor(entryModel);
    const input = entry.input_tokens ?? 0;
    const output = entry.output_tokens ?? 0;
    const cacheRead = entry.cache_read_input_tokens ?? 0;
    const cacheWrite = entry.cache_creation_input_tokens ?? 0;
    const write1h = entry.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m = entry.cache_creation ? entry.cache_creation.ephemeral_5m_input_tokens : cacheWrite;

    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cacheReadTokens += cacheRead;
    totals.cacheWriteTokens += cacheWrite;
    totals.costUsd +=
      (input * price.input +
        output * price.output +
        cacheRead * price.cacheRead +
        write5m * price.cacheWrite5m +
        write1h * price.cacheWrite1h) /
      1_000_000;
  }

  totals.webSearches = usage.server_tool_use?.web_search_requests ?? 0;
  totals.webFetches = usage.server_tool_use?.web_fetch_requests ?? 0;
  totals.costUsd += totals.webSearches * WEB_SEARCH_USD;

  // OpenRouter renvoie le coût réellement facturé (`usage.cost`, en USD) : il prime sur l'estimation.
  const reported = (usage as { cost?: unknown }).cost;
  if (typeof reported === 'number' && Number.isFinite(reported)) totals.costUsd = reported;
  return totals;
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    webSearches: a.webSearches + b.webSearches,
    webFetches: a.webFetches + b.webFetches,
    costUsd: a.costUsd + b.costUsd,
  };
}
