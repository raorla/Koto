import { describe, expect, it } from 'vitest';
import { buildExport, exportFileName } from '../src/export.js';
import { emptyUsage } from '../src/store.js';
import { NOW, makeStore, makeUser } from './helpers.js';

describe('export des données', () => {
  it('rassemble tout ce que Koto garde sur la personne, et rien sur les autres', () => {
    const store = makeStore();
    const ana = makeUser(store, { firstName: 'Ana' });
    const bob = makeUser(store, { firstName: 'Bob' });
    store.addMemory(ana.id, { kind: 'project', content: 'Lancer Koto', importance: 3 }, NOW);
    store.addMemory(bob.id, { kind: 'note', content: 'Secret de Bob', importance: 1 }, NOW);
    store.addListItems(ana.id, 'courses', ['lait'], NOW);
    store.addJob(ana.id, { kind: 'reminder', text: 'Appeler Rado', dueAt: NOW + 3_600_000, repeat: 'none', voice: true }, NOW);
    store.addMessage(ana.id, 'user', 'Salut Koto', 'chat', NOW);
    store.addMessage(ana.id, 'assistant', 'Salut Ana !', 'chat', NOW);
    store.addUsage(ana.id, '2026-10-14', { ...emptyUsage(), requests: 2, costUsd: 0.0021 });
    store.updateUserSettings(ana.id, { newsTopics: 'crypto', place: { name: 'Antananarivo, Madagascar', latitude: -18.91, longitude: 47.53 } });

    const data = buildExport(store, store.getUserById(ana.id)!, NOW);

    expect(data).toMatchObject({
      exporte_le: '2026-10-14T16:00:00.000Z',
      personne: { prenom: 'Ana', veille: 'crypto', lieu: 'Antananarivo, Madagascar', reponses_vocales: 'mirror' },
      memoire: [{ type: 'Projets', contenu: 'Lancer Koto', importance: 3 }],
      listes: [{ liste: 'courses', element: 'lait', fait: false }],
      rappels_a_venir: [{ type: 'rappel', texte: 'Appeler Rado', vocal: true }],
      historique: [
        { role: 'toi', contenu: 'Salut Koto' },
        { role: 'koto', contenu: 'Salut Ana !' },
      ],
      consommation: [{ jour: '2026-10-14', requetes: 2, cout_usd: 0.0021 }],
    });
    expect(JSON.stringify(data)).not.toContain('Secret de Bob');
    expect(exportFileName(NOW)).toBe('koto-mes-donnees-2026-10-14.json');
  });

  it('oublie tout : mémoire, listes, veille, lieu et tâches web terminées', () => {
    const store = makeStore();
    const ana = makeUser(store);
    store.addMemory(ana.id, { kind: 'note', content: 'x', importance: 1 }, NOW);
    store.addListItems(ana.id, 'courses', ['lait'], NOW);
    store.updateUserSettings(ana.id, { newsTopics: 'crypto', place: { name: 'Tana', latitude: -18.9, longitude: 47.5 } });
    const task = store.addBrowserTask(ana.id, 'Vols Tana → Paris', null, NOW);
    store.finishBrowserTask(task.id, 'done', 'Air Madagascar à 650 €', 3, 0.01, NOW);

    store.wipeUserData(ana.id);

    const user = store.getUserById(ana.id)!;
    expect(user).toMatchObject({ newsTopics: null, place: null });
    expect(store.listMemories(ana.id)).toHaveLength(0);
    expect(store.listAllItems(ana.id)).toHaveLength(0);
    expect(store.listBrowserTasks(ana.id, 10)).toHaveLength(0);
  });
});
