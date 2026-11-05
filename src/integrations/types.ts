import type { User } from '../store.js';
import type { Toolkit } from './catalog.js';

export interface IntegrationToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface ConnectionAttempt {
  /** Lien hébergé où la personne autorise l'accès (OAuth). */
  url: string;
  /** Vrai si la personne termine la connexion avant l'expiration du lien. */
  completion: Promise<boolean>;
}

/**
 * Accès aux services d'une personne (Gmail, Google Agenda…). Aujourd'hui : Composio exposé en MCP.
 * Le reste de Koto ne dépend que de cette interface, pour pouvoir changer de fournisseur.
 */
export interface Integrations {
  /** Catalogue figé au démarrage, identique pour tous (le préfixe de prompt reste partagé). */
  readonly tools: IntegrationToolDefinition[];
  execute(user: User, tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** État réel des connexions chez le fournisseur. */
  connectionStatus(user: User): Promise<Record<Toolkit, boolean>>;
  connect(user: User, toolkit: Toolkit): Promise<ConnectionAttempt>;
  disconnect(user: User, toolkit: Toolkit): Promise<boolean>;
  close(): Promise<void>;
}
