import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDir, backupFileName, dailyBackup, listBackups, startDailyBackups } from '../src/backup.js';
import { openDatabase, type DB } from '../src/db.js';
import { silentLogger } from '../src/util.js';
import { NOW } from './helpers.js';

const DAY = 86_400_000;

describe('sauvegardes de la base', () => {
  let root = '';
  let db: DB;
  let dir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'koto-backup-'));
    db = openDatabase(join(root, 'koto.db'));
    dir = backupDir(join(root, 'koto.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const countUsers = (file: string) => {
    const copy = new Database(join(dir, file), { readonly: true });
    try {
      return (copy.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
    } finally {
      copy.close();
    }
  };

  it('range une sauvegarde par jour (date UTC) à côté de la base', () => {
    expect(backupDir('./data/koto.db')).toBe(join('data', 'backups'));
    expect(backupFileName(Date.parse('2026-10-14T23:30:00Z'))).toBe('koto-2026-10-14.db');
  });

  it("copie aussi ce qui n'est encore que dans le WAL, sans laisser de fichier partiel", async () => {
    db.prepare("INSERT INTO users (telegram_id, chat_id, timezone, brief_time, created_at) VALUES (1, 1, 'UTC', '07:30', 0)").run();

    expect(await dailyBackup(db, dir, NOW, 14)).toBe('koto-2026-10-14.db');
    expect(readdirSync(dir)).toEqual(['koto-2026-10-14.db']);
    expect(countUsers('koto-2026-10-14.db')).toBe(1);
    // Le même jour, rien de plus.
    expect(await dailyBackup(db, dir, NOW + 3_600_000, 14)).toBeNull();
  });

  it('ne garde que les plus récentes, sans toucher aux autres fichiers', async () => {
    writeFileSync(join(root, 'notes.txt'), '');
    for (let day = 0; day < 5; day++) await dailyBackup(db, dir, NOW + day * DAY, 3);
    expect(listBackups(dir)).toEqual(['koto-2026-10-16.db', 'koto-2026-10-17.db', 'koto-2026-10-18.db']);
    expect(readdirSync(root).sort()).toEqual(['backups', 'koto.db', 'koto.db-shm', 'koto.db-wal', 'notes.txt']);
  });

  it('sauvegarde dès le démarrage du bot, puis une fois par jour', async () => {
    let now = NOW;
    const info = vi.fn();
    const backups = startDailyBackups({ db, dir, keep: 14, log: { ...silentLogger, info }, now: () => now });
    try {
      await vi.waitFor(() => expect(listBackups(dir)).toEqual(['koto-2026-10-14.db']));
      expect(info).toHaveBeenCalledWith('base sauvegardée', { file: 'koto-2026-10-14.db', keep: 14 });
    } finally {
      backups.stop();
    }
    // Redémarrage le lendemain : nouvelle sauvegarde, et les anciennes restent.
    now += DAY;
    const next = startDailyBackups({ db, dir, keep: 14, log: silentLogger, now: () => now });
    next.stop();
    await vi.waitFor(() => expect(listBackups(dir)).toEqual(['koto-2026-10-14.db', 'koto-2026-10-15.db']));
  });
});
