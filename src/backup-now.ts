// Sauvegarde immédiate de la base, sans risque même pendant que le bot tourne (API backup de SQLite) :
// `npm run backup` écrit la sauvegarde du jour dans data/backups ; `npm run backup -- fichier.db` l'écrit ailleurs.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { backupDir, backupFileName, backupTo } from './backup.js';
import { loadEnvFile, readConfig } from './config.js';

loadEnvFile();
const { databasePath } = readConfig();
const target = process.argv[2] ?? join(backupDir(databasePath), backupFileName(Date.now()));

let db: Database.Database;
try {
  // Connexion à part, sans migration : la base n'est pas modifiée.
  db = new Database(databasePath, { fileMustExist: true });
} catch {
  console.error(`❌ Base introuvable : ${databasePath} (DATABASE_PATH)`);
  process.exit(1);
}
await backupTo(db, target);
db.close();
console.log(`✅ Sauvegarde écrite : ${target}`);
