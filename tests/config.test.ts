import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { canonicalModel, openRouterModel } from '../src/models.js';

describe('configuration', () => {
  it("passe par OpenRouter dès qu'une clé OpenRouter est présente, en convertissant le modèle", () => {
    const config = readConfig({ OPENROUTER_API_KEY: 'sk-or-test', KOTO_MODEL: 'claude-opus-5-5' });
    expect(config).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-opus-5.5', openrouterApiKey: 'sk-or-test' });
  });

  it("reste sur l'API Anthropic par défaut", () => {
    expect(readConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('respecte LLM_PROVIDER et accepte un modèle écrit au format OpenRouter', () => {
    const config = readConfig({ LLM_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'sk-or-test', KOTO_MODEL: 'anthropic/claude-sonnet-5.5' });
    expect(config).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('parle avec la voix gratuite, une voix quasi gratuite en secours (désactivable)', () => {
    expect(readConfig({})).toMatchObject({
      speech: true,
      speechModel: 'fish-audio/s2.1-pro-free:free',
      speechVoice: '',
      speechFallbackModel: 'hexgrad/kokoro-82m',
      speechFallbackVoice: 'ff_siwis',
    });
    expect(readConfig({ KOTO_TTS_FALLBACK_MODEL: 'off' }).speechFallbackModel).toBeNull();
  });

  it('garde 14 sauvegardes quotidiennes par défaut, désactivables avec 0', () => {
    expect(readConfig({}).backupKeep).toBe(14);
    expect(readConfig({ KOTO_BACKUP_KEEP: '0' }).backupKeep).toBe(0);
    expect(() => readConfig({ KOTO_BACKUP_KEEP: '-1' })).toThrow(/KOTO_BACKUP_KEEP/);
  });

  it('refuse une valeur invalide avec un message clair', () => {
    expect(() => readConfig({ LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
    expect(() => readConfig({ DEFAULT_TIMEZONE: 'Mars/Olympus' })).toThrow(/fuseau inconnu/);
    expect(() => readConfig({ KOTO_MODEL: 'anthropic/claude-haiku-5.5:batch' })).toThrow(/anthropic\/claude-haiku-5\.5$/);
  });
});

describe('noms de modèles', () => {
  it('convertit entre les formats Anthropic et OpenRouter', () => {
    expect(openRouterModel('claude-opus-5-5')).toBe('anthropic/claude-opus-5.5');
    expect(openRouterModel('claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(openRouterModel('anthropic/claude-haiku-5.5')).toBe('anthropic/claude-haiku-5.5');
    expect(canonicalModel('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(canonicalModel('anthropic/claude-sonnet-5.5:batch')).toBe('claude-sonnet-5-5');
    expect(canonicalModel('claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});
