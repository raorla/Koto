/** Exécute les tâches d'une même clé (un utilisateur) l'une après l'autre. */
export class KeyedLock {
  private readonly tails = new Map<number, Promise<void>>();

  run<T>(key: number, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** Fenêtre glissante simple : au plus `max` actions par `windowMs` et par clé. */
export class RateLimiter {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: number, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

// On ne journalise jamais le contenu des messages : seulement des ids, des statuts et des coûts.
// Une ligne par événement (méta en JSON) pour pouvoir filtrer les logs avec grep.
const line = (level: string, message: string, meta?: Record<string, unknown>) =>
  `${new Date().toISOString()} ${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;

export const consoleLogger: Logger = {
  info: (message, meta) => console.log(line('INFO', message, meta)),
  warn: (message, meta) => console.warn(line('WARN', message, meta)),
  error: (message, error, meta) => console.error(line('ERROR', message, meta), error ?? ''),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
