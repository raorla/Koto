import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from './db.js';
import type { Logger } from './util.js';

// Sauvegardes de la base par l'API backup de SQLite : la copie reste cohérente même pendant que
// le bot écrit, alors qu'un simple `cp` à ce moment-là peut rater ce qui est encore dans le WAL.

const HOUR = 3_600_000;
const BACKUP_FILE = /^koto-\d{4}-\d{2}-\d{2}\.db$/;

/** Dossier des sauvegardes, à côté de la base (data/backups par défaut). */
export function backupDir(databasePath: string): string {
  return join(dirname(databasePath), 'backups');
}

/** Une sauvegarde par jour, datée en UTC : koto-2026-10-14.db. */
export function backupFileName(now: number): string {
  return `koto-${new Date(now).toISOString().slice(0, 10)}.db`;
}

/** Sauvegardes présentes dans le dossier, de la plus ancienne à la plus récente. */
export function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => BACKUP_FILE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Copie cohérente de la base vers `target`. Le fichier n'apparaît sous son nom qu'une fois complet. */
export async function backupTo(db: DB, target: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.partiel`;
  rmSync(partial, { force: true });
  try {
    await db.backup(partial);
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
}

/** Fait la sauvegarde du jour si elle manque, puis ne garde que les `keep` plus récentes. Renvoie le fichier créé. */
export async function dailyBackup(db: DB, dir: string, now: number, keep: number): Promise<string | null> {
  const name = backupFileName(now);
  if (listBackups(dir).includes(name)) return null;
  await backupTo(db, join(dir, name));
  for (const old of listBackups(dir).slice(0, -keep)) rmSync(join(dir, old), { force: true });
  return name;
}

/** Sauvegarde quotidienne tant que le bot tourne : vérifiée au démarrage, puis toutes les heures. */
export function startDailyBackups(options: { db: DB; dir: string; keep: number; log: Logger; now?: () => number }): { stop(): void } {
  const { db, dir, keep, log } = options;
  const now = options.now ?? Date.now;
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const name = await dailyBackup(db, dir, now(), keep);
      if (name) log.info('base sauvegardée', { file: name, keep });
    } catch (err) {
      log.error('sauvegarde de la base en échec', err);
    } finally {
      running = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), HOUR);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
