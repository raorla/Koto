import { createHash } from 'node:crypto';
import { Composio, SessionPreset } from '@composio/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Store, User } from '../store.js';
import type { Logger } from '../util.js';
import { INTEGRATION_TOOLS, TOOLKITS, type Toolkit } from './catalog.js';
import type { ConnectionAttempt, IntegrationToolDefinition, Integrations, ToolCallResult } from './types.js';

// Une session Composio par personne, limitée aux outils du catalogue (preset « direct tools » :
// pas de méta-outils de recherche), exposée en MCP. Koto parle à ce serveur MCP comme à n'importe
// quel autre : changer de fournisseur ne touche que ce fichier.

const CATALOG_USER = 'koto-catalog';
const CLIENT_IDLE_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 15_000;

const SESSION_CONFIG = {
  toolkits: [...TOOLKITS],
  tools: Object.fromEntries(TOOLKITS.map((toolkit) => [toolkit, { enable: [...INTEGRATION_TOOLS[toolkit]] }])),
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  manageConnections: false,
  mcp: true as const,
};

// Une session garde la configuration de sa création : si la liste d'outils change, on en recrée une.
const CONFIG_VERSION = createHash('sha1').update(JSON.stringify(INTEGRATION_TOOLS)).digest('hex').slice(0, 8);

type McpEndpoint = { url: string; headers?: Record<string, string> };

interface UserSession {
  mcp: McpEndpoint;
  authorize: (toolkit: string) => Promise<{ redirectUrl?: string | null; waitForConnection: (timeout?: number) => Promise<unknown> }>;
  toolkits: (options?: { toolkits?: string[] }) => Promise<{
    items: { slug: string; connection?: { isActive?: boolean; connectedAccount?: { id: string; status: string } } }[];
  }>;
}

async function connectMcp(endpoint: McpEndpoint): Promise<Client> {
  const client = new Client({ name: 'koto', version: '0.2.0' });
  // Les en-têtes portent la clé du projet Composio : ils ne partent que vers l'URL de la session.
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers ?? {} } }));
  return client;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Résultat MCP → texte pour le modèle. Accepte le format actuel (`content`) et l'ancien (`toolResult`).
 * Composio renvoie du JSON avec `successful` / `error`.
 */
export function mcpResultToText(result: Record<string, unknown>): ToolCallResult {
  const parts = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  let text = parts
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  if (!text && result.toolResult !== undefined) {
    text = typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
  }
  let isError = result.isError === true;
  try {
    const parsed = JSON.parse(text) as { successful?: unknown; error?: unknown };
    if (parsed.successful === false || (parsed.error !== undefined && parsed.error !== null && parsed.error !== '')) isError = true;
  } catch {
    // Texte libre : on garde l'indicateur MCP.
  }
  const clipped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [résultat tronqué : affine la recherche]` : text;
  return { text: clipped || '(résultat vide)', isError };
}

export class ComposioIntegrations implements Integrations {
  private readonly sessions = new Map<number, UserSession>();
  private readonly clients = new Map<number, { client: Client; lastUsed: number }>();
  private readonly sweeper: NodeJS.Timeout;

  private constructor(
    private readonly composio: Composio,
    private readonly store: Store,
    private readonly log: Logger,
    readonly tools: IntegrationToolDefinition[],
  ) {
    this.sweeper = setInterval(() => void this.closeIdleClients(), 60_000);
    this.sweeper.unref();
  }

  /** Crée le client et charge le catalogue d'outils (via une session « catalogue » sans compte connecté). */
  static async create(options: { apiKey: string; store: Store; log: Logger }): Promise<ComposioIntegrations> {
    const composio = new Composio({ apiKey: options.apiKey });
    const catalog = await composio.create(CATALOG_USER, SESSION_CONFIG);
    const client = await connectMcp(catalog.mcp);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const wanted = TOOLKITS.flatMap((toolkit) => INTEGRATION_TOOLS[toolkit]);
      const missing = wanted.filter((name) => !byName.has(name));
      if (missing.length > 0) options.log.warn('outils Composio introuvables, ignorés', { missing });
      const definitions = wanted.flatMap((name) => {
        const tool = byName.get(name);
        return tool ? [{ name, description: tool.description ?? name, inputSchema: tool.inputSchema as Record<string, unknown> }] : [];
      });
      return new ComposioIntegrations(composio, options.store, options.log, definitions);
    } finally {
      await client.close();
    }
  }

  private async session(user: User): Promise<UserSession> {
    const cached = this.sessions.get(user.id);
    if (cached) return cached;

    let session: UserSession | null = null;
    const [version, storedId] = (user.composioSessionId ?? '').split(':');
    if (storedId && version === CONFIG_VERSION) {
      try {
        session = await this.composio.use(storedId, { mcp: true });
      } catch (err) {
        this.log.warn('session Composio inutilisable, nouvelle session', { userId: user.id, error: errorMessage(err) });
      }
    }
    if (!session) {
      const created = await this.composio.create(this.store.ensureComposioUserId(user.id), SESSION_CONFIG);
      this.store.setComposioSessionId(user.id, `${CONFIG_VERSION}:${created.sessionId}`);
      session = created;
    }
    this.sessions.set(user.id, session);
    return session;
  }

  private async client(user: User): Promise<Client> {
    const entry = this.clients.get(user.id);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.client;
    }
    const client = await connectMcp((await this.session(user)).mcp);
    this.clients.set(user.id, { client, lastUsed: Date.now() });
    return client;
  }

  private async forget(userId: number, { session }: { session: boolean }): Promise<void> {
    const entry = this.clients.get(userId);
    this.clients.delete(userId);
    if (entry) await entry.client.close().catch(() => {});
    if (session) {
      this.sessions.delete(userId);
      this.store.setComposioSessionId(userId, null);
    }
  }

  async execute(user: User, tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const call = async () => mcpResultToText(await (await this.client(user)).callTool({ name: tool, arguments: args }));
    try {
      return await call();
    } catch (err) {
      // Connexion MCP ou session périmée : un seul nouvel essai, sur une session neuve.
      this.log.warn('appel MCP en échec, nouvel essai', { userId: user.id, tool, error: errorMessage(err) });
      await this.forget(user.id, { session: true });
      try {
        return await call();
      } catch (retryErr) {
        this.log.error('appel MCP en échec', retryErr, { userId: user.id, tool });
        return { text: `Le service n'a pas répondu (${errorMessage(retryErr)}). Réessaie plus tard.`, isError: true };
      }
    }
  }

  async connectionStatus(user: User): Promise<Record<Toolkit, boolean>> {
    const details = await (await this.session(user)).toolkits({ toolkits: [...TOOLKITS] });
    const status = Object.fromEntries(TOOLKITS.map((toolkit) => [toolkit, false])) as Record<Toolkit, boolean>;
    for (const item of details.items) {
      const account = item.connection?.connectedAccount;
      if ((TOOLKITS as readonly string[]).includes(item.slug) && account && account.status.toUpperCase() === 'ACTIVE') {
        status[item.slug as Toolkit] = true;
      }
    }
    return status;
  }

  async connect(user: User, toolkit: Toolkit): Promise<ConnectionAttempt> {
    const request = await (await this.session(user)).authorize(toolkit);
    if (!request.redirectUrl) throw new Error("Composio n'a pas renvoyé de lien de connexion");
    const completion = request.waitForConnection(CONNECT_TIMEOUT_MS).then(
      async () => {
        await this.forget(user.id, { session: false });
        return true;
      },
      () => false,
    );
    return { url: request.redirectUrl, completion };
  }

  async disconnect(user: User, toolkit: Toolkit): Promise<boolean> {
    const details = await (await this.session(user)).toolkits({ toolkits: [toolkit] });
    const accountId = details.items.find((item) => item.slug === toolkit)?.connection?.connectedAccount?.id;
    if (!accountId) return false;
    await this.composio.connectedAccounts.delete(accountId);
    await this.forget(user.id, { session: false });
    return true;
  }

  private async closeIdleClients(): Promise<void> {
    const now = Date.now();
    for (const [userId, entry] of this.clients) {
      if (now - entry.lastUsed > CLIENT_IDLE_MS) await this.forget(userId, { session: false });
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const userId of [...this.clients.keys()]) await this.forget(userId, { session: false });
  }
}
