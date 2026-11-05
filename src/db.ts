import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

// Chaque entrée est une migration ; `PRAGMA user_version` retient la dernière appliquée.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id      INTEGER NOT NULL UNIQUE,
    chat_id          INTEGER NOT NULL,
    first_name       TEXT,
    username         TEXT,
    display_name     TEXT,
    language         TEXT,
    timezone         TEXT    NOT NULL,
    brief_enabled    INTEGER NOT NULL DEFAULT 1,
    brief_time       TEXT    NOT NULL,
    is_admin         INTEGER NOT NULL DEFAULT 0,
    invites_left     INTEGER NOT NULL DEFAULT 0,
    invited_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    history_start_id INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    importance INTEGER NOT NULL DEFAULT 2,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX memories_user ON memories(user_id);

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT    NOT NULL,
    kind       TEXT    NOT NULL DEFAULT 'chat',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_user ON messages(user_id, id);

  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('reminder', 'checkin', 'brief')),
    text        TEXT    NOT NULL,
    due_at      INTEGER NOT NULL,
    repeat      TEXT    NOT NULL DEFAULT 'none',
    status      TEXT    NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_run_at INTEGER
  );
  CREATE INDEX jobs_due ON jobs(status, due_at);
  CREATE INDEX jobs_user ON jobs(user_id, status);

  CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at    INTEGER
  );

  CREATE TABLE usage (
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day                TEXT    NOT NULL,
    requests           INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    web_searches       INTEGER NOT NULL DEFAULT 0,
    web_fetches        INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  `,
  // v2 — intégrations (Gmail, Google Agenda via Composio) et actions à confirmer.
  `
  ALTER TABLE users ADD COLUMN composio_user_id TEXT;
  ALTER TABLE users ADD COLUMN composio_session_id TEXT;
  CREATE UNIQUE INDEX users_composio_user ON users(composio_user_id);

  CREATE TABLE connections (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    toolkit    TEXT    NOT NULL,
    connected  INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, toolkit)
  );

  CREATE TABLE pending_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool       TEXT    NOT NULL,
    args       TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',
    result     TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX pending_actions_user ON pending_actions(user_id, status);
  `,
  // v3 — tâches web (navigateur) et questions posées à la personne pendant ces tâches.
  `
  CREATE TABLE browser_tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal       TEXT    NOT NULL,
    start_url  TEXT,
    status     TEXT    NOT NULL DEFAULT 'queued',
    result     TEXT,
    steps      INTEGER NOT NULL DEFAULT 0,
    cost_usd   REAL    NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX browser_tasks_user ON browser_tasks(user_id, status);

  CREATE TABLE task_questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES browser_tasks(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    prompt      TEXT    NOT NULL,
    answer      TEXT,
    created_at  INTEGER NOT NULL,
    answered_at INTEGER
  );
  `,
  // v4 — réponses vocales (réglage par personne, brief lu, rappel vocal) et veille d'actualité du brief.
  `
  ALTER TABLE users ADD COLUMN voice_replies TEXT NOT NULL DEFAULT 'mirror';
  ALTER TABLE users ADD COLUMN brief_voice INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN news_topics TEXT;
  ALTER TABLE jobs ADD COLUMN voice INTEGER NOT NULL DEFAULT 0;
  `,
  // v5 — listes (courses, tâches…) et lieu de la personne (météo du brief).
  `
  CREATE TABLE list_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    list       TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    done_at    INTEGER
  );
  CREATE INDEX list_items_user ON list_items(user_id, done, list);

  ALTER TABLE users ADD COLUMN place_name TEXT;
  ALTER TABLE users ADD COLUMN latitude REAL;
  ALTER TABLE users ADD COLUMN longitude REAL;
  `,
  // v6 — conversations de groupe. Un groupe Telegram est un compte à part (kind = 'group', telegram_id =
  // chat_id = id du groupe) : sa mémoire, son historique, ses rappels et ses listes sont isolés par son
  // propre user_id, comme ceux d'une personne. owner_id = la personne inscrite qui l'a ajouté ou lui a
  // parlé en premier : son budget du jour paie les tours du groupe.
  `
  ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'group'));
  ALTER TABLE users ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  CREATE INDEX users_owner ON users(owner_id);
  `,
  // v7 — missions : des objectifs suivis en arrière-plan pendant plusieurs jours (surveiller un prix, préparer
  // un dossier pour une date…). Isolées par user_id comme le reste : un groupe a les siennes. notes = carnet de
  // travail réécrit à chaque passage ; instructions = consignes ajoutées en cours de route ; conclusion = ce qui
  // est proposé à la mémoire principale quand la mission se termine (jamais les notes).
  `
  CREATE TABLE missions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title            TEXT    NOT NULL,
    goal             TEXT    NOT NULL,
    done_when        TEXT    NOT NULL,
    interval_minutes INTEGER NOT NULL,
    deadline_at      INTEGER,
    max_cost_usd     REAL    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'active',
    end_reason       TEXT,
    next_run_at      INTEGER NOT NULL,
    last_run_at      INTEGER,
    runs             INTEGER NOT NULL DEFAULT 0,
    failures         INTEGER NOT NULL DEFAULT 0,
    cost_usd         REAL    NOT NULL DEFAULT 0,
    instructions     TEXT    NOT NULL DEFAULT '',
    notes            TEXT    NOT NULL DEFAULT '',
    conclusion       TEXT,
    conclusion_state TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    ended_at         INTEGER
  );
  CREATE INDEX missions_due ON missions(status, next_run_at);
  CREATE INDEX missions_user ON missions(user_id, status);
  `,
  // v8 — mémoire longue. messages_fts : index plein texte (FTS5, local et gratuit) de tout l'historique, tenu à
  // jour par des déclencheurs ; il ne garde que l'index, le texte reste dans messages, et toute recherche repasse
  // par messages.user_id. documents : la fiche (nom, date, résumé écrit par le modèle) de chaque photo ou PDF reçu,
  // aussi ajoutée au message de l'historique pour être retrouvée. Mémoire : la consolidation archive au lieu de
  // supprimer (archived_at, raison, souvenir dans lequel il a été fusionné) ; memory_checked_at = dernier ménage.
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content = 'messages',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
  END;
  INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');

  CREATE TABLE documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    kind       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    summary    TEXT,
    file_id    TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX documents_user ON documents(user_id, created_at);
  CREATE INDEX documents_message ON documents(message_id);

  ALTER TABLE memories ADD COLUMN archived_at INTEGER;
  ALTER TABLE memories ADD COLUMN archive_reason TEXT;
  ALTER TABLE memories ADD COLUMN merged_into INTEGER;
  CREATE INDEX memories_user_active ON memories(user_id, archived_at);
  ALTER TABLE users ADD COLUMN memory_checked_at INTEGER;
  `,
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
