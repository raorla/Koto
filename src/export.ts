// Export des données d'une personne (/exporter) : tout ce que Koto garde sur elle, dans un seul
// fichier JSON lisible. Uniquement ses propres données : chaque lecture passe par son user_id.
import { rhythmLabel } from './missions/missions.js';
import { MEMORY_KIND_LABELS, type Store, type User } from './store.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function buildExport(store: Store, user: User, now: number): Record<string, unknown> {
  return {
    exporte_le: iso(now),
    personne: {
      nom_d_usage: user.displayName,
      prenom: user.firstName,
      telegram: user.username,
      langue: user.language,
      fuseau_horaire: user.timezone,
      lieu: user.place?.name ?? null,
      brief_du_matin: user.briefEnabled ? { heure: user.briefTime, en_vocal: user.briefVoice } : null,
      reponses_vocales: user.voiceReplies,
      veille: user.newsTopics,
      inscrit_le: iso(user.createdAt),
    },
    memoire: store.listMemories(user.id).map((m) => ({
      id: m.id,
      type: MEMORY_KIND_LABELS[m.kind],
      contenu: m.content,
      importance: m.importance,
      cree_le: iso(m.createdAt),
      modifie_le: iso(m.updatedAt),
    })),
    // Ce que le ménage de la mémoire a retiré (fusions, faits périmés, anciennes versions) : rien n'est effacé.
    memoire_archivee: store.listArchivedMemories(user.id).map((m) => ({
      id: m.id,
      type: MEMORY_KIND_LABELS[m.kind],
      contenu: m.content,
      importance: m.importance,
      raison: m.archiveReason,
      fusionne_dans: m.mergedInto,
      cree_le: iso(m.createdAt),
      archive_le: iso(m.archivedAt),
    })),
    // Photos et PDF reçus : leur fiche seulement, Koto ne garde pas les fichiers.
    documents: store.listDocuments(user.id).map((d) => ({
      type: d.kind,
      nom: d.name,
      fiche: d.summary,
      recu_le: iso(d.createdAt),
    })),
    listes: store.listAllItems(user.id).map((i) => ({ liste: i.list, element: i.text, fait: i.done, ajoute_le: iso(i.createdAt), fait_le: iso(i.doneAt) })),
    rappels_a_venir: store.listPendingJobs(user.id, 1_000).map((j) => ({
      id: j.id,
      type: j.kind === 'reminder' ? 'rappel' : 'relance',
      texte: j.text,
      prevu_le: iso(j.dueAt),
      repetition: j.repeat,
      vocal: j.voice,
    })),
    taches_web: store.listBrowserTasks(user.id, 1_000).map((t) => ({
      id: t.id,
      objectif: t.goal,
      statut: t.status,
      resultat: t.result,
      cout_usd: t.costUsd,
      cree_le: iso(t.createdAt),
    })),
    // Les missions, notes de travail comprises : c'est tout ce qu'elles gardent.
    missions: store.listMissions(user.id, 1_000).map((m) => ({
      id: m.id,
      titre: m.title,
      objectif: m.goal,
      condition_de_fin: m.doneWhen,
      rythme: rhythmLabel(m.intervalMinutes),
      date_limite: iso(m.deadlineAt),
      statut: m.status,
      raison_de_fin: m.endReason,
      passages: m.runs,
      cout_usd: Number(m.costUsd.toFixed(5)),
      plafond_usd: m.maxCostUsd,
      consignes: m.instructions || null,
      notes: m.notes || null,
      conclusion: m.conclusion,
      creee_le: iso(m.createdAt),
      terminee_le: iso(m.endedAt),
    })),
    connexions: store.getConnections(user.id),
    // Les groupes dont elle paie les tours : leur nom seulement. Leur mémoire appartient au groupe.
    groupes_rattaches: store.listGroupsOwnedBy(user.id).map((g) => ({ nom: g.firstName, depuis: iso(g.createdAt) })),
    historique: store.listMessagesAfter(user.id, 0).map((m) => ({ role: m.role === 'user' ? 'toi' : 'koto', contenu: m.content, date: iso(m.createdAt) })),
    consommation: store.listUsage(user.id).map((u) => ({ jour: u.day, requetes: u.requests, cout_usd: Number(u.costUsd.toFixed(5)) })),
  };
}

export function exportFileName(now: number): string {
  return `koto-mes-donnees-${new Date(now).toISOString().slice(0, 10)}.json`;
}
