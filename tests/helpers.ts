import type Anthropic from '@anthropic-ai/sdk';
import type { CreateMessage, CreateParams } from '../src/agent/agent.js';
import type { Config } from '../src/config.js';
import type { Toolkit } from '../src/integrations/catalog.js';
import type { Integrations, ToolCallResult } from '../src/integrations/types.js';
import { openDatabase } from '../src/db.js';
import { Store, type User } from '../src/store.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaUsage = Anthropic.Beta.Messages.BetaUsage;

export const NOW = Date.parse('2026-10-14T16:00:00Z'); // 19:00 à Antananarivo (UTC+3)

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramToken: 'test-token',
    provider: 'anthropic',
    openrouterApiKey: '',
    model: 'claude-opus-5-5',
    effort: 'low',
    webTools: true,
    composioApiKey: '',
    voice: true,
    transcribeModel: 'google/gemini-2.5-flash-lite',
    speech: true,
    speechModel: 'fish-audio/s2.1-pro-free:free',
    speechVoice: '',
    speechFallbackModel: 'hexgrad/kokoro-82m',
    speechFallbackVoice: 'ff_siwis',
    browser: false,
    browserHeaded: false,
    browserChannel: 'chrome',
    browserModel: 'claude-opus-5-5',
    browserMaxSteps: 40,
    browserMaxCostUsd: 0.3,
    onePasswordToken: '',
    onePasswordAccount: '',
    onePasswordOwnerId: null,
    missions: true,
    missionModel: 'claude-opus-5-5',
    missionMinHours: 1,
    missionMaxCostUsd: 0.25,
    missionRunMaxCostUsd: 0.05,
    memoryConsolidation: true,
    memoryModel: 'claude-haiku-5-5',
    adminTelegramIds: [1000],
    registrationMode: 'invite',
    invitesPerUser: 3,
    dailyBudgetUsd: 0.5,
    defaultTimezone: 'Indian/Antananarivo',
    defaultBriefTime: '07:30',
    databasePath: ':memory:',
    backupKeep: 0,
    telegramApiRoot: 'https://api.telegram.org',
    openrouterBaseUrl: 'https://openrouter.ai/api',
    schedulerIntervalMs: 20_000,
    publicUrl: null,
    callPort: 8787,
    callHost: '127.0.0.1',
    ...overrides,
  };
}

export function makeStore(): Store {
  return new Store(openDatabase(':memory:'));
}

let nextTelegramId = 5000;

export function makeUser(store: Store, overrides: Partial<Parameters<Store['createUser']>[0]> = {}): User {
  const telegramId = overrides.telegramId ?? nextTelegramId++;
  return store.createUser(
    {
      telegramId,
      chatId: telegramId,
      firstName: 'Test',
      username: null,
      language: 'fr',
      timezone: 'Indian/Antananarivo',
      briefTime: '07:30',
      isAdmin: false,
      invitesLeft: 3,
      invitedBy: null,
      ...overrides,
    },
    NOW - 86_400_000,
  );
}

let nextGroupChatId = -1001000000001;

/** Compte d'un groupe Telegram, rattaché à `owner` (ou à personne). */
export function makeGroup(store: Store, owner: User | null, title = 'Sortie Andasibe'): User {
  return store.createGroup(
    { chatId: nextGroupChatId--, title, username: null, ownerId: owner?.id ?? null, timezone: owner?.timezone ?? 'Indian/Antananarivo', briefTime: '07:30' },
    NOW - 3_600_000,
  );
}

export function message(
  content: unknown[],
  stopReason: BetaMessage['stop_reason'],
  usage: Partial<BetaUsage> = {},
): BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      iterations: null,
      service_tier: 'standard',
      ...usage,
    },
  } as unknown as BetaMessage;
}

export const text = (t: string) => ({ type: 'text', text: t, citations: null });
export const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

/** Faux appel API : rejoue des réponses scriptées et garde une copie de chaque requête. */
export function scriptedCreate(responses: Array<BetaMessage | ((params: CreateParams) => BetaMessage)>) {
  const calls: CreateParams[] = [];
  const create: CreateMessage = async (params) => {
    calls.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error('plus de réponse scriptée');
    return typeof next === 'function' ? next(params) : next;
  };
  return { create, calls };
}

/** Faux Composio : enregistre les appels, état de connexion réglable, aucun réseau. */
export function fakeIntegrations(connected: Partial<Record<Toolkit, boolean>> = { gmail: true, googlecalendar: true }) {
  const calls: { userId: number; tool: string; args: Record<string, unknown> }[] = [];
  const state: Record<Toolkit, boolean> = { gmail: false, googlecalendar: false, ...connected };
  let nextResult: ToolCallResult = { text: '{"successful":true,"data":{"messages":[]}}', isError: false };
  const integrations: Integrations = {
    tools: [
      { name: 'GOOGLECALENDAR_EVENTS_LIST', description: 'List events', inputSchema: { type: 'object', properties: {} } },
      { name: 'GMAIL_FETCH_EMAILS', description: 'Fetch emails', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      {
        name: 'GMAIL_SEND_EMAIL',
        description: 'Send an email',
        inputSchema: { type: 'object', properties: { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } },
      },
    ],
    async execute(user, tool, args) {
      calls.push({ userId: user.id, tool, args });
      return nextResult;
    },
    async connectionStatus() {
      return { ...state };
    },
    async connect(_user, toolkit) {
      return { url: `https://connect.example/${toolkit}`, completion: Promise.resolve(true) };
    },
    async disconnect(_user, toolkit) {
      const was = state[toolkit];
      state[toolkit] = false;
      return was;
    },
    async close() {},
  };
  return {
    integrations,
    calls,
    state,
    setResult: (result: ToolCallResult) => {
      nextResult = result;
    },
  };
}
