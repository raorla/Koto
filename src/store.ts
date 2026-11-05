import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Repeat } from './time.js';

// Toutes les lectures/écritures qui touchent aux données d'un utilisateur prennent
// son `userId` et le mettent dans le WHERE : un id de mémoire ou de rappel venant
// du modèle ne peut jamais atteindre les données de quelqu'un d'autre. Un groupe
// Telegram est un compte à part (kind = 'group') : ses données sont isolées de la
// même façon, par son propre id, jamais par celui d'un de ses membres.

export const MEMORY_KINDS = ['about', 'project', 'priority', 'goal', 'person', 'preference', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  about: 'À propos',
  project: 'Projets',
  priority: 'Priorités',
  goal: 'Objectifs',
  person: 'Personnes',
  preference: 'Préférences',
  note: 'Notes',
};

export type MessageRole = 'user' | 'assistant';
/** `memory` : compte rendu d'un ménage de la mémoire (fusions, archives), gardé pour que Koto sache ce qui a changé. */
export type MessageKind = 'chat' | 'brief' | 'checkin' | 'reminder' | 'mission' | 'memory';

/** Photo envoyée telle quelle, image envoyée en fichier, ou PDF. */
export type DocumentKind = 'photo' | 'image' | 'pdf';

/** Fiche d'une photo ou d'un PDF reçu : de quoi le retrouver plus tard, sans garder le fichier. */
export interface StoredDocument {
  id: number;
  userId: number;
  /** Message de l'historique qui l'accompagne (la fiche y est aussi écrite). */
  messageId: number | null;
  kind: DocumentKind;
  name: string;
  /** Court résumé écrit par le modèle en lisant le document ; null s'il ne l'a pas donné. */
  summary: string | null;
  /** Identifiant Telegram du fichier (Telegram le garde pour le bot) : de quoi le rouvrir plus tard. */
  fileId: string | null;
  createdAt: number;
}

function toDocument(r: Record<string, unknown>): StoredDocument {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    messageId: (r.message_id as number | null) ?? null,
    kind: r.kind as DocumentKind,
    name: r.name as string,
    summary: (r.summary as string | null) ?? null,
    fileId: (r.file_id as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

/** Message retrouvé par la recherche plein texte, avec l'extrait qui correspond. */
export interface HistoryHit {
  message: StoredMessage;
  excerpt: string;
  /** Fiche du document envoyé avec ce message, s'il y en a une. */
  documentId: number | null;
}

export interface HistorySearch {
  /** Requête FTS5 déjà construite (voir ftsQuery) : jamais le texte brut du modèle. */
  match: string;
  /** Bornes de date (ms), incluse puis exclue ; null = sans borne. */
  from: number | null;
  to: number | null;
  /** Seulement les messages qui accompagnent une photo ou un document. */
  documentsOnly: boolean;
  limit: number;
}

export const JOB_KINDS = ['reminder', 'checkin', 'brief'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = 'pending' | 'done' | 'cancelled' | 'failed';

/** Réponses vocales : jamais, quand la personne envoie un vocal, ou à chaque réponse. */
export const VOICE_MODES = ['off', 'mirror', 'always'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

/** Un compte est une personne, ou un groupe Telegram (qui a ses propres données). */
export type AccountKind = 'person' | 'group';

/**
 * Compte Koto : une personne, ou un groupe Telegram. Pour un groupe, `telegramId` et `chatId` valent
 * l'id du groupe et `firstName` son titre ; il n'a ni brief, ni invitations, ni intégrations.
 */
export interface User {
  id: number;
  kind: AccountKind;
  /** Groupe : la personne inscrite dont le budget paie ses tours (null tant que personne ne l'est). */
  ownerId: number | null;
  telegramId: number;
  chatId: number;
  firstName: string | null;
  username: string | null;
  displayName: string | null;
  language: string | null;
  timezone: string;
  briefEnabled: boolean;
  briefTime: string;
  isAdmin: boolean;
  invitesLeft: number;
  invitedBy: number | null;
  historyStartId: number;
  createdAt: number;
  /** Identifiant (UUID) chez Composio : jamais l'id SQLite, qui se réutilise d'une base à l'autre. */
  composioUserId: string | null;
  composioSessionId: string | null;
  voiceReplies: VoiceMode;
  /** Brief du matin aussi envoyé en vocal. */
  briefVoice: boolean;
  /** Sujets de veille du brief (ex : « crypto »), null = pas de veille. */
  newsTopics: string | null;
  /** Lieu de la personne (météo du brief) : nom lisible et coordonnées, ou null. */
  place: Place | null;
}

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

/** Élément d'une liste (courses, tâches, à lire…). */
export interface ListItem {
  id: number;
  userId: number;
  list: string;
  text: string;
  done: boolean;
  createdAt: number;
  doneAt: number | null;
}

function toListItem(r: Record<string, unknown>): ListItem {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    list: r.list as string,
    text: r.text as string,
    done: r.done === 1,
    createdAt: r.created_at as number,
    doneAt: (r.done_at as number | null) ?? null,
  };
}

/** Nom de liste normalisé : « Courses » et « courses » sont la même liste. */
export function normalizeListName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
}

export type PendingStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';

/** Action d'intégration (envoyer un mail, créer un événement…) en attente du « ✅ Confirmer » de la personne. */
export interface PendingAction {
  id: number;
  userId: number;
  tool: string;
  args: Record<string, unknown>;
  status: PendingStatus;
  result: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export type ClaimResult = 'claimed' | 'missing' | 'expired' | 'already_decided';

export type BrowserTaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface BrowserTask {
  id: number;
  userId: number;
  goal: string;
  startUrl: string | null;
  status: BrowserTaskStatus;
  result: string | null;
  steps: number;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

function toBrowserTask(r: Record<string, unknown>): BrowserTask {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    goal: r.goal as string,
    startUrl: (r.start_url as string | null) ?? null,
    status: r.status as BrowserTaskStatus,
    result: (r.result as string | null) ?? null,
    steps: r.steps as number,
    costUsd: r.cost_usd as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export type MissionStatus = 'active' | 'done' | 'stopped' | 'failed';
/** Pourquoi une mission s'est arrêtée. */
export type MissionEndReason = 'goal' | 'deadline' | 'budget' | 'person' | 'errors' | 'removed';
/** Conclusion d'une mission terminée : proposée à la mémoire, puis gardée ou écartée par la personne. */
export type ConclusionState = 'proposed' | 'kept' | 'declined';

/** Objectif suivi en arrière-plan, passage après passage, pendant plusieurs jours. */
export interface Mission {
  id: number;
  userId: number;
  title: string;
  goal: string;
  doneWhen: string;
  intervalMinutes: number;
  /** Date du dernier passage, qui conclut la mission ; null = sans date limite. */
  deadlineAt: number | null;
  maxCostUsd: number;
  status: MissionStatus;
  endReason: MissionEndReason | null;
  nextRunAt: number;
  lastRunAt: number | null;
  runs: number;
  /** Passages ratés de suite (erreur d'API, refus). */
  failures: number;
  costUsd: number;
  /** Consignes ajoutées en cours de route (réponses à ses questions, changements), une par ligne. */
  instructions: string;
  /** Carnet de travail, réécrit à chaque passage : jamais versé dans la mémoire principale. */
  notes: string;
  conclusion: string | null;
  conclusionState: ConclusionState | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export interface NewMission {
  title: string;
  goal: string;
  doneWhen: string;
  intervalMinutes: number;
  deadlineAt: number | null;
  maxCostUsd: number;
  nextRunAt: number;
}

function toMission(r: Record<string, unknown>): Mission {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    title: r.title as string,
    goal: r.goal as string,
    doneWhen: r.done_when as string,
    intervalMinutes: r.interval_minutes as number,
    deadlineAt: (r.deadline_at as number | null) ?? null,
    maxCostUsd: r.max_cost_usd as number,
    status: r.status as MissionStatus,
    endReason: (r.end_reason as MissionEndReason | null) ?? null,
    nextRunAt: r.next_run_at as number,
    lastRunAt: (r.last_run_at as number | null) ?? null,
    runs: r.runs as number,
    failures: r.failures as number,
    costUsd: r.cost_usd as number,
    instructions: r.instructions as string,
    notes: r.notes as string,
    conclusion: (r.conclusion as string | null) ?? null,
    conclusionState: (r.conclusion_state as ConclusionState | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

export interface NewUser {
  telegramId: number;
  chatId: number;
  firstName: string | null;
  username: string | null;
  language: string | null;
  timezone: string;
  briefTime: string;
  isAdmin: boolean;
  invitesLeft: number;
  invitedBy: number | null;
}

export interface UserSettingsPatch {
  displayName?: string | null;
  timezone?: string;
  briefEnabled?: boolean;
  briefTime?: string;
  voiceReplies?: VoiceMode;
  briefVoice?: boolean;
  newsTopics?: string | null;
  place?: Place | null;
}

export interface Memory {
  id: number;
  userId: number;
  kind: MemoryKind;
  content: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  /** Archivé par le ménage de la mémoire (hors du prompt, mais gardé et restaurable) ; null = actif. */
  archivedAt: number | null;
  archiveReason: string | null;
  /** Souvenir dans lequel celui-ci a été fusionné. */
  mergedInto: number | null;
}

/** Compte dont la mémoire mérite un ménage, avec de quoi juger sa taille. */
export interface MemoryCheckCandidate {
  userId: number;
  count: number;
  chars: number;
  /** Dernier ménage (null = jamais) : sert à le réserver (claimMemoryCheck). */
  checkedAt: number | null;
}

/** Quand ranger la mémoire d'un compte (voir Store.accountsDueForMemoryCheck). */
export interface MemoryCheckRules {
  /** En dessous, rien à ranger. */
  minMemories: number;
  /** Au-delà de l'un de ces seuils, ménage dès que le délai `retryMs` est passé. */
  countThreshold: number;
  charsThreshold: number;
  retryMs: number;
  /** Sinon, un ménage tous les `periodMs` au plus, si la mémoire a changé depuis le dernier. */
  periodMs: number;
}

export interface StoredMessage {
  id: number;
  userId: number;
  role: MessageRole;
  content: string;
  kind: MessageKind;
  createdAt: number;
}

export interface Job {
  id: number;
  userId: number;
  kind: JobKind;
  text: string;
  dueAt: number;
  repeat: Repeat;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  lastRunAt: number | null;
  /** Message aussi envoyé en vocal (« rappel vocal »). */
  voice: boolean;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  webFetches: number;
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    webFetches: 0,
    costUsd: 0,
  };
}

type Row = Record<string, unknown>;

function toUser(r: Row): User {
  return {
    id: r.id as number,
    kind: r.kind === 'group' ? 'group' : 'person',
    ownerId: (r.owner_id as number | null) ?? null,
    telegramId: r.telegram_id as number,
    chatId: r.chat_id as number,
    firstName: (r.first_name as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    timezone: r.timezone as string,
    briefEnabled: r.brief_enabled === 1,
    briefTime: r.brief_time as string,
    isAdmin: r.is_admin === 1,
    invitesLeft: r.invites_left as number,
    invitedBy: (r.invited_by as number | null) ?? null,
    historyStartId: r.history_start_id as number,
    createdAt: r.created_at as number,
    composioUserId: (r.composio_user_id as string | null) ?? null,
    composioSessionId: (r.composio_session_id as string | null) ?? null,
    voiceReplies: VOICE_MODES.includes(r.voice_replies as VoiceMode) ? (r.voice_replies as VoiceMode) : 'mirror',
    briefVoice: r.brief_voice === 1,
    newsTopics: (r.news_topics as string | null) ?? null,
    place:
      typeof r.latitude === 'number' && typeof r.longitude === 'number'
        ? { name: (r.place_name as string | null) ?? '', latitude: r.latitude, longitude: r.longitude }
        : null,
  };
}

function toPendingAction(r: Row): PendingAction {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    tool: r.tool as string,
    args: JSON.parse(r.args as string) as Record<string, unknown>,
    status: r.status as PendingStatus,
    result: (r.result as string | null) ?? null,
    createdAt: r.created_at as number,
    decidedAt: (r.decided_at as number | null) ?? null,
  };
}

function toMemory(r: Row): Memory {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    kind: r.kind as MemoryKind,
    content: r.content as string,
    importance: r.importance as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    archivedAt: (r.archived_at as number | null) ?? null,
    archiveReason: (r.archive_reason as string | null) ?? null,
    mergedInto: (r.merged_into as number | null) ?? null,
  };
}

function toMessage(r: Row): StoredMessage {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    role: r.role as MessageRole,
    content: r.content as string,
    kind: r.kind as MessageKind,
    createdAt: r.created_at as number,
  };
}

function toJob(r: Row): Job {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    kind: r.kind as JobKind,
    text: r.text as string,
    dueAt: r.due_at as number,
    repeat: r.repeat as Repeat,
    status: r.status as JobStatus,
    attempts: r.attempts as number,
    createdAt: r.created_at as number,
    lastRunAt: (r.last_run_at as number | null) ?? null,
    voice: r.voice === 1,
  };
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newInviteCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

export class Store {
  constructor(readonly db: DB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- utilisateurs

  getUserById(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  /** Une personne seulement : jamais le compte d'un groupe. */
  getUserByTelegramId(telegramId: number): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE telegram_id = ? AND kind = 'person'`).get(telegramId) as Row | undefined;
    return row ? toUser(row) : null;
  }

  createUser(input: NewUser, now: number): User {
    const info = this.db
      .prepare(
        `INSERT INTO users (telegram_id, chat_id, first_name, username, language, timezone, brief_time,
                            is_admin, invites_left, invited_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.telegramId,
        input.chatId,
        input.firstName,
        input.username,
        input.language,
        input.timezone,
        input.briefTime,
        input.isAdmin ? 1 : 0,
        input.invitesLeft,
        input.invitedBy,
        now,
      );
    return this.getUserById(Number(info.lastInsertRowid))!;
  }

  /** Met à jour ce que Telegram nous apprend à chaque message (chat, prénom, @, langue). */
  touchUser(id: number, profile: { chatId: number; firstName: string | null; username: string | null; language: string | null }): void {
    this.db
      .prepare('UPDATE users SET chat_id = ?, first_name = ?, username = ?, language = ? WHERE id = ?')
      .run(profile.chatId, profile.firstName, profile.username, profile.language, id);
  }

  setAdmin(id: number, isAdmin: boolean): void {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }

  updateUserSettings(id: number, patch: UserSettingsPatch): User {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      values.push(patch.displayName);
    }
    if (patch.timezone !== undefined) {
      sets.push('timezone = ?');
      values.push(patch.timezone);
    }
    if (patch.briefEnabled !== undefined) {
      sets.push('brief_enabled = ?');
      values.push(patch.briefEnabled ? 1 : 0);
    }
    if (patch.briefTime !== undefined) {
      sets.push('brief_time = ?');
      values.push(patch.briefTime);
    }
    if (patch.voiceReplies !== undefined) {
      sets.push('voice_replies = ?');
      values.push(patch.voiceReplies);
    }
    if (patch.briefVoice !== undefined) {
      sets.push('brief_voice = ?');
      values.push(patch.briefVoice ? 1 : 0);
    }
    if (patch.newsTopics !== undefined) {
      sets.push('news_topics = ?');
      values.push(patch.newsTopics);
    }
    if (patch.place !== undefined) {
      sets.push('place_name = ?', 'latitude = ?', 'longitude = ?');
      values.push(patch.place?.name ?? null, patch.place?.latitude ?? null, patch.place?.longitude ?? null);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.getUserById(id)!;
  }

  setHistoryStart(id: number, messageId: number): void {
    this.db.prepare('UPDATE users SET history_start_id = ? WHERE id = ?').run(messageId, id);
  }

  /** Consomme une invitation du quota de l'utilisateur ; false s'il n'en a plus. */
  takeInvite(id: number): boolean {
    const info = this.db
      .prepare('UPDATE users SET invites_left = invites_left - 1 WHERE id = ? AND invites_left > 0')
      .run(id);
    return info.changes === 1;
  }

  /** Efface mémoire, historique et rappels, mais garde le compte et ses réglages. */
  wipeUserData(id: number): void {
    this.transaction(() => {
      // Archives de la mémoire comprises ; l'index plein texte suit la suppression des messages (déclencheurs).
      this.db.prepare('DELETE FROM memories WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM documents WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM messages WHERE user_id = ?').run(id);
      this.db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE user_id = ? AND status = 'pending' AND kind != 'brief'`).run(id);
      this.db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'`).run(id);
      this.db.prepare('DELETE FROM list_items WHERE user_id = ?').run(id);
      // Les tâches web terminées décrivent ce que la personne a cherché ; une tâche en cours finit d'abord.
      this.db.prepare(`DELETE FROM browser_tasks WHERE user_id = ? AND status IN ('done', 'failed', 'stopped')`).run(id);
      // Les missions aussi, en cours comprises : leurs notes parlent de la personne. Un passage en vol ne
      // retrouve plus sa mission et ne prévient personne.
      this.db.prepare('DELETE FROM missions WHERE user_id = ?').run(id);
      this.db
        .prepare(
          'UPDATE users SET history_start_id = 0, display_name = NULL, news_topics = NULL, place_name = NULL, latitude = NULL, longitude = NULL, memory_checked_at = NULL WHERE id = ?',
        )
        .run(id);
    });
  }

  // ---------------------------------------------------------------- listes

  addListItems(userId: number, list: string, texts: string[], now: number): ListItem[] {
    const name = normalizeListName(list);
    const insert = this.db.prepare('INSERT INTO list_items (user_id, list, text, created_at) VALUES (?, ?, ?, ?)');
    return this.transaction(() =>
      texts.map((text) => this.getListItem(userId, Number(insert.run(userId, name, text, now).lastInsertRowid))!),
    );
  }

  getListItem(userId: number, id: number): ListItem | null {
    const row = this.db.prepare('SELECT * FROM list_items WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return row ? toListItem(row) : null;
  }

  /** Éléments à faire, toutes listes confondues : ordre stable (liste, puis ancienneté). */
  listOpenItems(userId: number, limit = 200): ListItem[] {
    const rows = this.db
      .prepare('SELECT * FROM list_items WHERE user_id = ? AND done = 0 ORDER BY list ASC, id ASC LIMIT ?')
      .all(userId, limit) as Row[];
    return rows.map(toListItem);
  }

  /** Tous les éléments d'une liste, cochés compris (les plus récents d'abord parmi les cochés). */
  listItems(userId: number, list: string): ListItem[] {
    const rows = this.db
      .prepare('SELECT * FROM list_items WHERE user_id = ? AND list = ? ORDER BY done ASC, CASE WHEN done = 1 THEN -done_at ELSE id END ASC')
      .all(userId, normalizeListName(list)) as Row[];
    return rows.map(toListItem);
  }

  /** Toutes les listes, cochés compris (export). */
  listAllItems(userId: number): ListItem[] {
    const rows = this.db.prepare('SELECT * FROM list_items WHERE user_id = ? ORDER BY list ASC, id ASC').all(userId) as Row[];
    return rows.map(toListItem);
  }

  /** Consommation jour par jour (export), du plus récent au plus ancien. */
  listUsage(userId: number): (UsageTotals & { day: string })[] {
    const rows = this.db.prepare('SELECT * FROM usage WHERE user_id = ? ORDER BY day DESC').all(userId) as Row[];
    return rows.map((r) => ({ day: r.day as string, ...this.getUsage(userId, r.day as string) }));
  }

  countOpenItems(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE user_id = ? AND done = 0').get(userId) as { n: number }).n;
  }

  /** Coche ou décoche ; renvoie les éléments réellement modifiés (ceux d'une autre personne sont ignorés). */
  setListItemsDone(userId: number, ids: number[], done: boolean, now: number): ListItem[] {
    const update = this.db.prepare('UPDATE list_items SET done = ?, done_at = ? WHERE id = ? AND user_id = ? AND done = ?');
    return this.transaction(() =>
      ids.flatMap((id) => (update.run(done ? 1 : 0, done ? now : null, id, userId, done ? 0 : 1).changes === 1 ? [this.getListItem(userId, id)!] : [])),
    );
  }

  removeListItems(userId: number, ids: number[]): number {
    const remove = this.db.prepare('DELETE FROM list_items WHERE id = ? AND user_id = ?');
    return this.transaction(() => ids.reduce((n, id) => n + remove.run(id, userId).changes, 0));
  }

  /** Vide les éléments cochés d'une liste (ou de toutes). */
  clearDoneItems(userId: number, list: string | null): number {
    return list === null
      ? this.db.prepare('DELETE FROM list_items WHERE user_id = ? AND done = 1').run(userId).changes
      : this.db.prepare('DELETE FROM list_items WHERE user_id = ? AND done = 1 AND list = ?').run(userId, normalizeListName(list)).changes;
  }

  // ---------------------------------------------------------------- intégrations

  /** Identifiant Composio de l'utilisateur, créé au premier besoin. */
  ensureComposioUserId(id: number): string {
    const current = this.getUserById(id)?.composioUserId;
    if (current) return current;
    const fresh = `koto-${randomUUID()}`;
    this.db.prepare('UPDATE users SET composio_user_id = ? WHERE id = ? AND composio_user_id IS NULL').run(fresh, id);
    return this.getUserById(id)!.composioUserId!;
  }

  /**
   * Identifiant externe stable de la personne (UUID), unique d'une base à l'autre : sert pour
   * Composio et pour le dossier de profil du navigateur.
   */
  ensureExternalId(id: number): string {
    return this.ensureComposioUserId(id);
  }

  setComposioSessionId(id: number, sessionId: string | null): void {
    this.db.prepare('UPDATE users SET composio_session_id = ? WHERE id = ?').run(sessionId, id);
  }

  setConnection(userId: number, toolkit: string, connected: boolean, now: number): void {
    this.db
      .prepare(
        `INSERT INTO connections (user_id, toolkit, connected, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, toolkit) DO UPDATE SET connected = excluded.connected, checked_at = excluded.checked_at`,
      )
      .run(userId, toolkit, connected ? 1 : 0, now);
  }

  /** Dernier état connu des connexions (toolkit → connecté). Un toolkit absent n'a jamais été vérifié. */
  getConnections(userId: number): Record<string, boolean> {
    const rows = this.db.prepare('SELECT toolkit, connected FROM connections WHERE user_id = ?').all(userId) as Row[];
    return Object.fromEntries(rows.map((r) => [r.toolkit as string, r.connected === 1]));
  }

  // ---------------------------------------------------------------- actions à confirmer

  addPendingAction(userId: number, tool: string, args: Record<string, unknown>, now: number): PendingAction {
    const info = this.db
      .prepare('INSERT INTO pending_actions (user_id, tool, args, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, tool, JSON.stringify(args), now);
    return this.getPendingAction(userId, Number(info.lastInsertRowid))!;
  }

  getPendingAction(userId: number, id: number): PendingAction | null {
    const row = this.db.prepare('SELECT * FROM pending_actions WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return row ? toPendingAction(row) : null;
  }

  /**
   * Réserve une action pour l'exécuter : atomique, donc un double clic ne l'exécute qu'une fois.
   * Une action plus vieille que `maxAgeMs` passe en « expired ».
   */
  claimPendingAction(userId: number, id: number, now: number, maxAgeMs: number): ClaimResult {
    return this.transaction(() => {
      const action = this.getPendingAction(userId, id);
      if (!action) return 'missing';
      if (action.status !== 'pending') return 'already_decided';
      if (now - action.createdAt > maxAgeMs) {
        this.db.prepare(`UPDATE pending_actions SET status = 'expired', decided_at = ? WHERE id = ?`).run(now, id);
        return 'expired';
      }
      const info = this.db
        .prepare(`UPDATE pending_actions SET status = 'running', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'`)
        .run(now, id, userId);
      return info.changes === 1 ? 'claimed' : 'already_decided';
    });
  }

  finishPendingAction(id: number, status: 'done' | 'failed', result: string, now: number): void {
    this.db.prepare('UPDATE pending_actions SET status = ?, result = ?, decided_at = ? WHERE id = ?').run(status, result, now, id);
  }

  // ---------------------------------------------------------------- tâches web

  addBrowserTask(userId: number, goal: string, startUrl: string | null, now: number): BrowserTask {
    const info = this.db
      .prepare('INSERT INTO browser_tasks (user_id, goal, start_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, goal, startUrl, now, now);
    return this.getBrowserTask(Number(info.lastInsertRowid))!;
  }

  getBrowserTask(id: number): BrowserTask | null {
    const row = this.db.prepare('SELECT * FROM browser_tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toBrowserTask(row) : null;
  }

  /** Tâche en cours (file, exécution ou attente d'une réponse) de la personne, s'il y en a une. */
  activeBrowserTask(userId: number): BrowserTask | null {
    const row = this.db
      .prepare(`SELECT * FROM browser_tasks WHERE user_id = ? AND status IN ('queued', 'running', 'waiting') ORDER BY id DESC LIMIT 1`)
      .get(userId) as Row | undefined;
    return row ? toBrowserTask(row) : null;
  }

  listBrowserTasks(userId: number, limit = 5): BrowserTask[] {
    const rows = this.db.prepare('SELECT * FROM browser_tasks WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as Row[];
    return rows.map(toBrowserTask);
  }

  setBrowserTaskStatus(id: number, status: BrowserTaskStatus, now: number): void {
    this.db.prepare('UPDATE browser_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  finishBrowserTask(id: number, status: 'done' | 'failed' | 'stopped', result: string, steps: number, costUsd: number, now: number): void {
    this.db
      .prepare('UPDATE browser_tasks SET status = ?, result = ?, steps = ?, cost_usd = ?, updated_at = ? WHERE id = ?')
      .run(status, result, steps, costUsd, now, id);
  }

  /** Au démarrage : les tâches coupées par un redémarrage sont marquées en échec. */
  failInterruptedBrowserTasks(now: number): BrowserTask[] {
    const rows = this.db.prepare(`SELECT * FROM browser_tasks WHERE status IN ('queued', 'running', 'waiting')`).all() as Row[];
    this.db
      .prepare(
        `UPDATE browser_tasks SET status = 'failed', result = 'Interrompue par un redémarrage de Koto.', updated_at = ?
         WHERE status IN ('queued', 'running', 'waiting')`,
      )
      .run(now);
    return rows.map(toBrowserTask);
  }

  addTaskQuestion(taskId: number, userId: number, kind: string, prompt: string, now: number): number {
    return Number(
      this.db
        .prepare('INSERT INTO task_questions (task_id, user_id, kind, prompt, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, userId, kind, prompt, now).lastInsertRowid,
    );
  }

  answerTaskQuestion(id: number, answer: string, now: number): void {
    this.db.prepare('UPDATE task_questions SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL').run(answer, now, id);
  }

  cancelPendingAction(userId: number, id: number, now: number): boolean {
    return (
      this.db
        .prepare(`UPDATE pending_actions SET status = 'cancelled', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'`)
        .run(now, id, userId).changes === 1
    );
  }

  /**
   * Supprime l'utilisateur et, par cascade, sa mémoire, ses messages, rappels et usage. Les groupes
   * dont il payait les tours sont détachés (owner_id à NULL) et gardent leurs propres données.
   */
  deleteUser(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  countUsers(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE kind = 'person'`).get() as { n: number }).n;
  }

  // ---------------------------------------------------------------- missions
  // Une mission appartient à un compte (personne ou groupe) : chaque lecture et chaque écriture passe par son
  // user_id, celles du scheduler comprises.

  addMission(userId: number, input: NewMission, now: number): Mission {
    const info = this.db
      .prepare(
        `INSERT INTO missions (user_id, title, goal, done_when, interval_minutes, deadline_at, max_cost_usd, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, input.title, input.goal, input.doneWhen, input.intervalMinutes, input.deadlineAt, input.maxCostUsd, input.nextRunAt, now, now);
    return this.getMission(userId, Number(info.lastInsertRowid))!;
  }

  getMission(userId: number, id: number): Mission | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return row ? toMission(row) : null;
  }

  /** Missions en cours, dans un ordre stable : le contexte de l'agent ne change que si la liste change. */
  listActiveMissions(userId: number): Mission[] {
    const rows = this.db.prepare(`SELECT * FROM missions WHERE user_id = ? AND status = 'active' ORDER BY id ASC`).all(userId) as Row[];
    return rows.map(toMission);
  }

  /** Les missions en cours d'abord, puis les plus récentes (/missions, export). */
  listMissions(userId: number, limit = 20): Mission[] {
    const rows = this.db
      .prepare(`SELECT * FROM missions WHERE user_id = ? ORDER BY status = 'active' DESC, id DESC LIMIT ?`)
      .all(userId, limit) as Row[];
    return rows.map(toMission);
  }

  countActiveMissions(userId: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE user_id = ? AND status = 'active'`).get(userId) as { n: number }).n;
  }

  /** Missions dont le passage est dû, tous comptes confondus (pour le scheduler). */
  dueMissions(now: number, limit = 20): Mission[] {
    const rows = this.db
      .prepare(`SELECT * FROM missions WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT ?`)
      .all(now, limit) as Row[];
    return rows.map(toMission);
  }

  /** Réserve le passage dû d'une mission et programme le suivant : atomique, un passage ne part qu'une fois. */
  claimMissionRun(userId: number, id: number, at: number, nextRunAt: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE missions SET next_run_at = ?, last_run_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'active' AND next_run_at <= ?`,
        )
        .run(nextRunAt, at, at, id, userId, at).changes === 1
    );
  }

  /** Repousse un passage sans le faire (personne pour payer, budget du jour épuisé). */
  postponeMission(userId: number, id: number, nextRunAt: number, now: number): void {
    this.db
      .prepare(`UPDATE missions SET next_run_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'`)
      .run(nextRunAt, now, id, userId);
  }

  /** Enregistre un passage : son coût, les nouvelles notes (null = inchangées) et les échecs de suite. */
  recordMissionRun(userId: number, id: number, run: { costUsd: number; notes: string | null; failed: boolean }, now: number): void {
    this.db
      .prepare(
        `UPDATE missions SET runs = runs + 1, cost_usd = cost_usd + ?, notes = COALESCE(?, notes),
                failures = CASE WHEN ? = 1 THEN failures + 1 ELSE 0 END, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(run.costUsd, run.notes, run.failed ? 1 : 0, now, id, userId);
  }

  /** Termine une mission en cours (faux si elle ne l'était plus) ; sa conclusion éventuelle est proposée à la mémoire. */
  endMission(
    userId: number,
    id: number,
    end: { status: Exclude<MissionStatus, 'active'>; reason: MissionEndReason; conclusion?: string | null },
    now: number,
  ): boolean {
    const conclusion = end.conclusion?.trim() || null;
    return (
      this.db
        .prepare(
          `UPDATE missions SET status = ?, end_reason = ?, conclusion = ?, conclusion_state = ?, ended_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'active'`,
        )
        .run(end.status, end.reason, conclusion, conclusion ? 'proposed' : null, now, now, id, userId).changes === 1
    );
  }

  /** Arrête toutes les missions en cours d'un compte (Koto retiré d'un groupe : rien ne pourrait plus partir). */
  stopActiveMissions(userId: number, reason: MissionEndReason, now: number): number {
    return this.db
      .prepare(`UPDATE missions SET status = 'stopped', end_reason = ?, ended_at = ?, updated_at = ? WHERE user_id = ? AND status = 'active'`)
      .run(reason, now, now, userId).changes;
  }

  /** Ajoute une consigne à une mission en cours ; au-delà de `maxChars`, les plus anciennes partent. */
  addMissionInstruction(userId: number, id: number, line: string, maxChars: number, now: number): boolean {
    const mission = this.getMission(userId, id);
    if (!mission || mission.status !== 'active') return false;
    const lines = [...mission.instructions.split('\n').filter(Boolean), line];
    while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
    return (
      this.db
        .prepare(`UPDATE missions SET instructions = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'`)
        .run(lines.join('\n').slice(-maxChars), now, id, userId).changes === 1
    );
  }

  /** Change le rythme, la date limite ou le prochain passage d'une mission en cours. */
  updateMissionSchedule(
    userId: number,
    id: number,
    schedule: { intervalMinutes: number; deadlineAt: number | null; nextRunAt: number },
    now: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE missions SET interval_minutes = ?, deadline_at = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'active'`,
        )
        .run(schedule.intervalMinutes, schedule.deadlineAt, schedule.nextRunAt, now, id, userId).changes === 1
    );
  }

  /** Réponse à la conclusion proposée (atomique : un double clic ne la garde qu'une fois). */
  decideMissionConclusion(userId: number, id: number, decision: 'kept' | 'declined', now: number): boolean {
    return (
      this.db
        .prepare(`UPDATE missions SET conclusion_state = ?, updated_at = ? WHERE id = ? AND user_id = ? AND conclusion_state = 'proposed'`)
        .run(decision, now, id, userId).changes === 1
    );
  }

  // ---------------------------------------------------------------- groupes
  // Un groupe Telegram est un compte à part : sa mémoire, son historique, ses rappels et ses listes
  // passent par les mêmes méthodes que ceux d'une personne, filtrées par son propre id.

  getGroupByChatId(chatId: number): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE telegram_id = ? AND kind = 'group'`).get(chatId) as Row | undefined;
    return row ? toUser(row) : null;
  }

  /** Crée le compte d'un groupe, sans brief ni invitations ; renvoie celui qui existe déjà le cas échéant. */
  createGroup(
    input: { chatId: number; title: string | null; username: string | null; ownerId: number | null; timezone: string; briefTime: string },
    now: number,
  ): User {
    this.db
      .prepare(
        `INSERT INTO users (telegram_id, chat_id, first_name, username, timezone, brief_enabled, brief_time, kind, owner_id, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'group', ?, ?)
         ON CONFLICT (telegram_id) DO NOTHING`,
      )
      .run(input.chatId, input.chatId, input.title, input.username, input.timezone, input.briefTime, input.ownerId, now);
    return this.getGroupByChatId(input.chatId)!;
  }

  /** Rattache le groupe à une personne, seulement s'il n'est rattaché à personne (atomique). */
  claimGroup(groupId: number, ownerId: number): boolean {
    return (
      this.db.prepare(`UPDATE users SET owner_id = ? WHERE id = ? AND kind = 'group' AND owner_id IS NULL`).run(ownerId, groupId).changes === 1
    );
  }

  /** Détache le groupe : plus personne ne paie ses tours, jusqu'à la prochaine personne inscrite qui parle. */
  releaseGroup(groupId: number): void {
    this.db.prepare(`UPDATE users SET owner_id = NULL WHERE id = ? AND kind = 'group'`).run(groupId);
  }

  setGroupTitle(groupId: number, title: string | null): void {
    this.db.prepare(`UPDATE users SET first_name = ? WHERE id = ? AND kind = 'group'`).run(title, groupId);
  }

  /** Passage en supergroupe : Telegram change l'id du groupe, qui garde ses données. */
  moveGroupChat(fromChatId: number, toChatId: number): boolean {
    if (this.getGroupByChatId(toChatId)) return false;
    return (
      this.db
        .prepare(`UPDATE users SET telegram_id = ?, chat_id = ? WHERE telegram_id = ? AND kind = 'group'`)
        .run(toChatId, toChatId, fromChatId).changes === 1
    );
  }

  /** Groupes dont la personne paie les tours (export, suppression de compte). */
  listGroupsOwnedBy(userId: number): User[] {
    const rows = this.db.prepare(`SELECT * FROM users WHERE owner_id = ? AND kind = 'group' ORDER BY id ASC`).all(userId) as Row[];
    return rows.map(toUser);
  }

  countGroups(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE kind = 'group'`).get() as { n: number }).n;
  }

  // ---------------------------------------------------------------- mémoire

  addMemory(userId: number, input: { kind: MemoryKind; content: string; importance: number }, now: number): Memory {
    const info = this.db
      .prepare(
        `INSERT INTO memories (user_id, kind, content, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, input.kind, input.content, input.importance, now, now);
    return this.getMemory(userId, Number(info.lastInsertRowid))!;
  }

  getMemory(userId: number, id: number): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return row ? toMemory(row) : null;
  }

  /** Met à jour un souvenir actif (un souvenir archivé se restaure d'abord : restoreMemory). */
  updateMemory(
    userId: number,
    id: number,
    patch: { content?: string; importance?: number; kind?: MemoryKind },
    now: number,
  ): Memory | null {
    const current = this.getMemory(userId, id);
    if (!current || current.archivedAt !== null) return null;
    this.db
      .prepare('UPDATE memories SET kind = ?, content = ?, importance = ?, updated_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL')
      .run(patch.kind ?? current.kind, patch.content ?? current.content, patch.importance ?? current.importance, now, id, userId);
    return this.getMemory(userId, id);
  }

  /** Supprime définitivement un souvenir, actif ou archivé. */
  deleteMemory(userId: number, id: number): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId).changes === 1;
  }

  /**
   * Mémoire active, dans un ordre stable (importance puis id) : le bloc mémoire du prompt ne bouge que si la
   * mémoire change. Les souvenirs archivés n'y sont pas.
   */
  listMemories(userId: number): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE user_id = ? AND archived_at IS NULL ORDER BY importance DESC, id ASC')
      .all(userId) as Row[];
    return rows.map(toMemory);
  }

  countMemories(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND archived_at IS NULL').get(userId) as { n: number }).n;
  }

  /** Souvenirs archivés par le ménage, les plus récents d'abord (/memoire, export). */
  listArchivedMemories(userId: number, limit = 1_000): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE user_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC LIMIT ?')
      .all(userId, limit) as Row[];
    return rows.map(toMemory);
  }

  countArchivedMemories(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND archived_at IS NOT NULL').get(userId) as { n: number }).n;
  }

  /** Remet un souvenir archivé dans la mémoire active ; faux s'il n'était pas archivé. */
  restoreMemory(userId: number, id: number, now: number): boolean {
    return (
      this.db
        .prepare(
          'UPDATE memories SET archived_at = NULL, archive_reason = NULL, merged_into = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL',
        )
        .run(now, id, userId).changes === 1
    );
  }

  /**
   * Ménage de la mémoire : réécrit un souvenir actif, seulement s'il n'a pas changé depuis que le modèle l'a lu
   * (`seenUpdatedAt`). Un souvenir modifié entre-temps par la conversation est laissé tel quel.
   */
  rewriteMemory(
    userId: number,
    id: number,
    seenUpdatedAt: number,
    patch: { content: string; importance: number; kind: MemoryKind },
    now: number,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memories SET content = ?, importance = ?, kind = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND archived_at IS NULL AND updated_at = ?`,
        )
        .run(patch.content, patch.importance, patch.kind, now, id, userId, seenUpdatedAt).changes === 1
    );
  }

  /** Ménage de la mémoire : archive un souvenir actif (jamais de suppression), à la même condition que rewriteMemory. */
  archiveMemory(userId: number, id: number, seenUpdatedAt: number, archive: { reason: string; mergedInto: number | null }, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memories SET archived_at = ?, archive_reason = ?, merged_into = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND archived_at IS NULL AND updated_at = ?`,
        )
        .run(now, archive.reason, archive.mergedInto, now, id, userId, seenUpdatedAt).changes === 1
    );
  }

  /** Ménage de la mémoire : garde aux archives la version d'un souvenir qui va être réécrit (rien ne se perd). */
  archiveCopy(userId: number, memory: Memory, reason: string, now: number): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO memories (user_id, kind, content, importance, created_at, updated_at, archived_at, archive_reason, merged_into)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, memory.kind, memory.content, memory.importance, memory.createdAt, now, now, reason, memory.id).lastInsertRowid,
    );
  }

  /**
   * Comptes dont la mémoire mérite un ménage, tous comptes confondus (pour le scheduler) : assez de souvenirs,
   * modifiés depuis le dernier ménage, et soit au-delà d'un seuil (après `retryMs`), soit pas rangés depuis `periodMs`.
   */
  accountsDueForMemoryCheck(now: number, rules: MemoryCheckRules, limit = 5): MemoryCheckCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT u.id AS user_id, u.memory_checked_at, s.n, s.chars
         FROM users u
         JOIN (SELECT user_id, COUNT(*) AS n, SUM(LENGTH(content)) AS chars, MAX(updated_at) AS changed
               FROM memories WHERE archived_at IS NULL GROUP BY user_id) s ON s.user_id = u.id
         WHERE s.n >= ?
           AND s.changed > COALESCE(u.memory_checked_at, 0)
           AND (
             ((s.n >= ? OR s.chars >= ?) AND COALESCE(u.memory_checked_at, 0) <= ?)
             OR COALESCE(u.memory_checked_at, u.created_at) <= ?
           )
         ORDER BY COALESCE(u.memory_checked_at, 0) ASC, u.id ASC
         LIMIT ?`,
      )
      .all(rules.minMemories, rules.countThreshold, rules.charsThreshold, now - rules.retryMs, now - rules.periodMs, limit) as Row[];
    return rows.map((r) => ({
      userId: r.user_id as number,
      count: r.n as number,
      chars: r.chars as number,
      checkedAt: (r.memory_checked_at as number | null) ?? null,
    }));
  }

  /** Réserve le ménage d'un compte (atomique : un seul à la fois) ; faux si un autre vient de le faire. */
  claimMemoryCheck(userId: number, at: number, lastSeen: number | null): boolean {
    return (
      this.db
        .prepare('UPDATE users SET memory_checked_at = ? WHERE id = ? AND COALESCE(memory_checked_at, 0) = ?')
        .run(at, userId, lastSeen ?? 0).changes === 1
    );
  }

  /** Fin du ménage : ses propres réécritures ne comptent pas comme des changements à ranger au prochain. */
  finishMemoryCheck(userId: number, at: number): void {
    this.db.prepare('UPDATE users SET memory_checked_at = ? WHERE id = ?').run(at, userId);
  }

  // ---------------------------------------------------------------- historique

  addMessage(userId: number, role: MessageRole, content: string, kind: MessageKind, now: number): number {
    const info = this.db
      .prepare('INSERT INTO messages (user_id, role, content, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, role, content, kind, now);
    return Number(info.lastInsertRowid);
  }

  listMessagesAfter(userId: number, afterId: number): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id ASC')
      .all(userId, afterId) as Row[];
    return rows.map(toMessage);
  }

  /**
   * Recherche plein texte dans tout l'historique du compte, les plus pertinents d'abord. L'index (messages_fts)
   * couvre tous les comptes : c'est la jointure sur messages.user_id qui isole, comme partout ailleurs.
   */
  searchHistory(userId: number, search: HistorySearch): HistoryHit[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, snippet(messages_fts, 0, '', '', '…', 32) AS excerpt, d.id AS document_id
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         LEFT JOIN documents d ON d.message_id = m.id AND d.user_id = m.user_id
         WHERE messages_fts MATCH ? AND m.user_id = ? AND m.created_at >= ? AND m.created_at < ?
           AND (? = 0 OR d.id IS NOT NULL)
         ORDER BY rank, m.id DESC
         LIMIT ?`,
      )
      .all(search.match, userId, search.from ?? 0, search.to ?? Number.MAX_SAFE_INTEGER, search.documentsOnly ? 1 : 0, search.limit) as Row[];
    return rows.map((r) => ({ message: toMessage(r), excerpt: r.excerpt as string, documentId: (r.document_id as number | null) ?? null }));
  }

  /** Message voisin dans l'historique du compte (la question d'une réponse retrouvée, ou l'inverse). */
  neighborMessage(userId: number, id: number, direction: 'before' | 'after'): StoredMessage | null {
    const row = this.db
      .prepare(
        direction === 'before'
          ? 'SELECT * FROM messages WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 1'
          : 'SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 1',
      )
      .get(userId, id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  // ---------------------------------------------------------------- documents reçus

  addDocument(
    userId: number,
    input: { messageId: number | null; kind: DocumentKind; name: string; summary: string | null; fileId: string | null },
    now: number,
  ): StoredDocument {
    const info = this.db
      .prepare('INSERT INTO documents (user_id, message_id, kind, name, summary, file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, input.messageId, input.kind, input.name, input.summary, input.fileId, now);
    return this.getDocument(userId, Number(info.lastInsertRowid))!;
  }

  getDocument(userId: number, id: number): StoredDocument | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return row ? toDocument(row) : null;
  }

  /** Documents reçus, les plus récents d'abord, entre deux dates (ms, incluse puis exclue) si elles sont données. */
  listDocuments(userId: number, options: { from?: number | null; to?: number | null; limit?: number } = {}): StoredDocument[] {
    const rows = this.db
      .prepare('SELECT * FROM documents WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(userId, options.from ?? 0, options.to ?? Number.MAX_SAFE_INTEGER, options.limit ?? 1_000) as Row[];
    return rows.map(toDocument);
  }

  // ---------------------------------------------------------------- rappels, relances, briefs

  addJob(userId: number, input: { kind: JobKind; text: string; dueAt: number; repeat: Repeat; voice?: boolean }, now: number): Job {
    const info = this.db
      .prepare('INSERT INTO jobs (user_id, kind, text, due_at, repeat, voice, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, input.kind, input.text, input.dueAt, input.repeat, input.voice ? 1 : 0, now);
    return this.getJob(userId, Number(info.lastInsertRowid))!;
  }

  getJob(userId: number, id: number): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Rappels et relances à venir (le brief quotidien est un réglage, pas un rappel). */
  listPendingJobs(userId: number, limit = 50): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE user_id = ? AND status = 'pending' AND kind != 'brief'
         ORDER BY due_at ASC, id ASC LIMIT ?`,
      )
      .all(userId, limit) as Row[];
    return rows.map(toJob);
  }

  listPendingJobsBetween(userId: number, start: number, end: number): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE user_id = ? AND status = 'pending' AND kind != 'brief'
           AND due_at >= ? AND due_at < ? ORDER BY due_at ASC, id ASC`,
      )
      .all(userId, start, end) as Row[];
    return rows.map(toJob);
  }

  countPendingJobs(userId: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status = 'pending' AND kind != 'brief'`)
        .get(userId) as { n: number }
    ).n;
  }

  cancelJob(userId: number, id: number): boolean {
    return (
      this.db
        .prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending' AND kind != 'brief'`)
        .run(id, userId).changes === 1
    );
  }

  getBriefJob(userId: number): Job | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE user_id = ? AND kind = 'brief' AND status = 'pending' ORDER BY id DESC LIMIT 1`)
      .get(userId) as Row | undefined;
    return row ? toJob(row) : null;
  }

  cancelBriefJobs(userId: number): void {
    this.db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE user_id = ? AND kind = 'brief' AND status = 'pending'`).run(userId);
  }

  /** Annule tout ce qui reste à envoyer (Koto retiré d'un groupe : plus rien ne pourrait partir). */
  cancelPendingJobs(userId: number): number {
    return this.db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'`).run(userId).changes;
  }

  /** Tâches arrivées à échéance, tous utilisateurs confondus (pour le scheduler). */
  dueJobs(now: number, limit = 25): Job[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT ?`)
      .all(now, limit) as Row[];
    return rows.map(toJob);
  }

  rescheduleJob(id: number, dueAt: number, now: number): void {
    this.db.prepare('UPDATE jobs SET due_at = ?, attempts = 0, last_run_at = ? WHERE id = ?').run(dueAt, now, id);
  }

  retryJobLater(id: number, dueAt: number): void {
    this.db.prepare('UPDATE jobs SET due_at = ?, attempts = attempts + 1 WHERE id = ?').run(dueAt, id);
  }

  finishJob(id: number, status: Exclude<JobStatus, 'pending'>, now: number): void {
    this.db.prepare('UPDATE jobs SET status = ?, last_run_at = ? WHERE id = ?').run(status, now, id);
  }

  // ---------------------------------------------------------------- invitations

  createInvite(createdBy: number | null, now: number): string {
    for (;;) {
      const code = newInviteCode();
      const info = this.db
        .prepare('INSERT OR IGNORE INTO invites (code, created_by, created_at) VALUES (?, ?, ?)')
        .run(code, createdBy, now);
      if (info.changes === 1) return code;
    }
  }

  inviteIsAvailable(code: string): boolean {
    const row = this.db.prepare('SELECT used_by FROM invites WHERE code = ?').get(code) as { used_by: number | null } | undefined;
    return row !== undefined && row.used_by === null;
  }

  /** Atomique : une invitation ne peut servir qu'une fois. */
  redeemInvite(code: string, userId: number, now: number): boolean {
    const info = this.db
      .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .run(userId, now, code);
    return info.changes === 1;
  }

  invitedBy(code: string): number | null {
    const row = this.db.prepare('SELECT created_by FROM invites WHERE code = ?').get(code) as { created_by: number | null } | undefined;
    return row?.created_by ?? null;
  }

  // ---------------------------------------------------------------- usage et coûts

  addUsage(userId: number, day: string, u: UsageTotals): void {
    this.db
      .prepare(
        `INSERT INTO usage (user_id, day, requests, input_tokens, output_tokens, cache_read_tokens,
                            cache_write_tokens, web_searches, web_fetches, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET
           requests           = requests + excluded.requests,
           input_tokens       = input_tokens + excluded.input_tokens,
           output_tokens      = output_tokens + excluded.output_tokens,
           cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           web_searches       = web_searches + excluded.web_searches,
           web_fetches        = web_fetches + excluded.web_fetches,
           cost_usd           = cost_usd + excluded.cost_usd`,
      )
      .run(
        userId,
        day,
        u.requests,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.webSearches,
        u.webFetches,
        u.costUsd,
      );
  }

  getUsage(userId: number, day: string): UsageTotals {
    const r = this.db.prepare('SELECT * FROM usage WHERE user_id = ? AND day = ?').get(userId, day) as Row | undefined;
    if (!r) return emptyUsage();
    return {
      requests: r.requests as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      webSearches: r.web_searches as number,
      webFetches: r.web_fetches as number,
      costUsd: r.cost_usd as number,
    };
  }

  /** Coût total enregistré sur les `days` derniers jours (vue admin, approximative selon les fuseaux). */
  totalCostSince(dayInclusive: string): { costUsd: number; activeUsers: number } {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(DISTINCT user_id) AS users FROM usage WHERE day >= ?')
      .get(dayInclusive) as { cost: number; users: number };
    return { costUsd: r.cost, activeUsers: r.users };
  }
}
