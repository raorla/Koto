import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';

/** OpenRouter expose l'API Messages d'Anthropic : le SDK y ajoute lui-même `/v1/messages`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/** Client du SDK Anthropic, branché sur l'API Anthropic ou sur OpenRouter selon la configuration. */
export function createLlmClient(config: Config): Anthropic {
  if (config.provider === 'openrouter') {
    return new Anthropic({
      baseURL: config.openrouterBaseUrl,
      // OpenRouter attend la clé en « Authorization: Bearer » : surtout pas d'en-tête x-api-key.
      apiKey: null,
      authToken: config.openrouterApiKey,
      defaultHeaders: { 'X-Title': 'Koto' },
    });
  }
  return new Anthropic();
}
