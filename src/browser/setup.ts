import { dirname, join } from 'node:path';
import type { CreateMessage } from '../agent/agent.js';
import type { Config } from '../config.js';
import type { Store, User } from '../store.js';
import type { Logger } from '../util.js';
import { runBrowserTask } from './agent.js';
import { createOnePasswordBroker, type CredentialBroker } from './credentials.js';
import { createPlaywrightEngine } from './engine.js';
import { BrowserTasks, type TaskNotifier } from './tasks.js';

/** Assemble le navigateur, 1Password (facultatif) et le gestionnaire de tâches ; null si KOTO_BROWSER=off. */
export async function setupBrowser(options: {
  config: Config;
  store: Store;
  create: CreateMessage;
  notifier: TaskNotifier;
  log: Logger;
}): Promise<BrowserTasks | null> {
  const { config, store, log } = options;
  if (!config.browser) return null;

  const engine = createPlaywrightEngine({
    // Un profil par personne (cookies et sessions), à côté de la base de données.
    dataDir: join(dirname(config.databasePath), 'browser'),
    headed: config.browserHeaded,
    channel: config.browserChannel,
    // Sur un serveur sans Chrome (Linux ARM, par exemple), le Chromium de Playwright prend le relais.
    onFallback: (channel) =>
      log.warn(`Navigateur « ${channel} » introuvable : Koto utilise le Chromium de Playwright (KOTO_BROWSER_CHANNEL=chromium pour ne plus le chercher)`),
  });

  let credentials: CredentialBroker | null = null;
  if (config.onePasswordToken || config.onePasswordAccount) {
    if (config.onePasswordOwnerId === null) {
      log.warn('1Password configuré sans OP_OWNER_TELEGRAM_ID : désactivé (personne ne saurait à qui il appartient)');
    } else {
      try {
        credentials = await createOnePasswordBroker({
          serviceAccountToken: config.onePasswordToken || undefined,
          desktopAccount: config.onePasswordAccount || undefined,
        });
        log.info('1Password relié', { owner: config.onePasswordOwnerId });
      } catch (err) {
        log.error('1Password indisponible : connexions automatiques désactivées', err);
      }
    }
  }

  // La personne devant l'écran du PC qui fait tourner Koto : le propriétaire (sinon le premier admin).
  const ownerId = config.onePasswordOwnerId ?? config.adminTelegramIds[0] ?? null;
  const isOwner = (user: User) => ownerId !== null && user.telegramId === ownerId;

  return new BrowserTasks({
    store,
    engine,
    settings: {
      create: options.create,
      provider: config.provider,
      model: config.browserModel,
      effort: config.effort,
      maxSteps: config.browserMaxSteps,
      maxCostUsd: config.browserMaxCostUsd,
      log,
    },
    browse: runBrowserTask,
    notifier: options.notifier,
    // 1Password : uniquement pour le propriétaire déclaré, jamais pour les autres utilisateurs.
    credentialsFor: (user) => (credentials && user.telegramId === config.onePasswordOwnerId ? credentials : null),
    // Prendre la main n'a de sens que si la fenêtre est visible, sur l'écran du propriétaire.
    canHandOver: (user) => config.browserHeaded && isOwner(user),
    log,
  });
}
