// Les deux façons de nommer un modèle Claude : API Anthropic ("claude-opus-5-5")
// et OpenRouter ("anthropic/claude-opus-5.5").

/** "anthropic/claude-opus-5.5" (ou ":batch"…) → "claude-opus-5-5". Un id Anthropic reste tel quel. */
export function canonicalModel(id: string): string {
  const bare = id.replace(/^anthropic\//, '').replace(/:.*$/, '');
  return bare.replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, '$1-$2');
}

/** "claude-opus-5-5" → "anthropic/claude-opus-5.5". Un id déjà au format OpenRouter est gardé. */
export function openRouterModel(id: string): string {
  if (id.includes('/')) return id;
  return `anthropic/${id.replace(/^(claude-[a-z]+-\d+)-(\d+)$/, '$1.$2')}`;
}
