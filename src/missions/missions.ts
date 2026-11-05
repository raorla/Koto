// Missions : des objectifs suivis en arrière-plan pendant plusieurs jours (surveiller un prix, préparer un
// dossier pour une date, vérifier qu'une réponse arrive). L'agent principal les lance (mission_start) ; le
// scheduler en lance chaque passage (runner.ts), chacun avec son propre contexte (pass.ts). Ici : les limites
// et les textes communs, sans dépendance vers l'agent.
import type { Mission, MissionEndReason, MissionStatus } from '../store.js';
import { formatDateTime } from '../time.js';

/** Réglages des missions, fixés par la configuration : les mêmes pour tout le monde. */
export interface MissionSettings {
  /** Heures minimum entre deux passages. */
  minHours: number;
  /** Plafond de coût d'une mission quand la personne n'en donne pas. */
  defaultMaxCostUsd: number;
}

export const MISSION_LIMITS = {
  /** Missions en cours par compte (personne ou groupe). */
  active: 5,
  maxDays: 90,
  /** Plafond le plus haut qu'on puisse donner à une mission. */
  maxCostUsd: 2,
  titleChars: 80,
  goalChars: 2_000,
  doneWhenChars: 300,
  noteChars: 500,
  instructionsChars: 3_000,
  notesChars: 6_000,
  messageChars: 3_500,
  conclusionChars: 600,
};

/** « 0,25 $ », « 0,012 $ » ou « 0,004 $ » pour les petits montants, « < 0,001 $ » pour les tout petits. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.001) return '< 0,001 $';
  const digits = amount > 0 && amount < 0.1 && Math.round(amount * 1_000) % 10 !== 0 ? 3 : 2;
  return `${amount.toFixed(digits).replace('.', ',')} $`;
}

/** « toutes les heures », « toutes les 6 h », « tous les jours », « tous les 3 jours »… */
export function rhythmLabel(minutes: number): string {
  if (minutes % 1_440 === 0) return minutes === 1_440 ? 'tous les jours' : `tous les ${minutes / 1_440} jours`;
  if (minutes === 60) return 'toutes les heures';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `toutes les ${rest} min`;
  return rest === 0 ? `toutes les ${hours} h` : `toutes les ${hours} h ${String(rest).padStart(2, '0')}`;
}

/** Bloc <missions> du contexte de l'agent : déterministe (dates absolues, ordre des ids), sans coût ni notes. */
export function renderMissionsContext(missions: Mission[], timezone: string): string {
  if (missions.length === 0) return '(aucune)';
  return missions
    .map((m) => {
      const until = m.deadlineAt === null ? 'sans date limite' : `jusqu'au ${formatDateTime(m.deadlineAt, timezone)}`;
      return `- #${m.id} · « ${m.title} » · ${rhythmLabel(m.intervalMinutes)} · ${until}`;
    })
    .join('\n');
}

export const MISSION_ICONS: Record<MissionStatus, string> = { active: '🎯', done: '✅', stopped: '⏹️', failed: '⚠️' };

export const END_REASON_LABELS: Record<MissionEndReason, string> = {
  goal: 'objectif atteint',
  deadline: 'date limite atteinte',
  budget: 'plafond de coût atteint',
  person: 'sur demande',
  errors: 'trop d’erreurs',
  removed: 'Koto retiré du groupe',
};

/** Message d'un passage qui continue : un résultat utile, ou une question. */
export function progressText(mission: Mission, kind: 'notify' | 'question', message: string): string {
  const head = `🎯 **Mission #${mission.id}** · ${mission.title}`;
  return kind === 'question'
    ? `${head} — une question\n\n${message}\n\n_Réponds-moi ici : je lui transmets._`
    : `${head}\n\n${message}`;
}

/** Message de fin d'une mission (objectif atteint, date limite, plafond, erreurs). */
export function endText(mission: Mission, reason: 'goal' | 'deadline' | 'budget' | 'errors', message: string | null, failures = 0): string {
  switch (reason) {
    case 'goal':
      return `🎯 **Mission #${mission.id} terminée** · ${mission.title}\n\n${message ?? 'Objectif atteint.'}`;
    case 'deadline':
      return `🎯 **Mission #${mission.id} terminée** · ${mission.title}\n\n${message ?? "La date limite est arrivée : je m'arrête là."}`;
    case 'budget':
      return `🎯 **Mission #${mission.id} arrêtée** · ${mission.title}\n\nSon plafond de coût (${formatUsd(mission.maxCostUsd)}) est atteint après ${mission.runs} passage${mission.runs > 1 ? 's' : ''}.${
        message ? `\n\n${message}` : ''
      }\n\nRedemande-la-moi avec un plafond plus haut si besoin.`;
    case 'errors':
      return `⚠️ **Mission #${mission.id} arrêtée** · ${mission.title}\n\nJe n'arrive plus à la mener (${failures} erreurs de suite). Redemande-la-moi si besoin.`;
  }
}
