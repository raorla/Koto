import { describe, expect, it } from 'vitest';
import { executeTool } from '../src/agent/tools.js';
import { parseLocalDateTime } from '../src/time.js';
import { NOW, makeStore, makeUser } from './helpers.js';

function setup() {
  const store = makeStore();
  const alice = makeUser(store, { firstName: 'Alice' });
  const bob = makeUser(store, { firstName: 'Bob' });
  const as = (userId: number) => ({ store, userId, now: NOW });
  return { store, alice, bob, as };
}

describe('réglages vocaux et veille', () => {
  it('par défaut : vocal seulement en réponse à un vocal, pas de brief lu ni de veille', () => {
    const { alice } = setup();
    expect(alice).toMatchObject({ voiceReplies: 'mirror', briefVoice: false, newsTopics: null });
  });

  it('change les réponses vocales, le brief en vocal et la veille, et efface la veille avec une chaîne vide', () => {
    const { store, alice, as } = setup();
    const result = executeTool('update_settings', { voice_replies: 'always', brief_voice: true, news_topics: 'crypto (Bitcoin, RLC)' }, as(alice.id));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('réponses vocales : à chaque réponse');
    expect(store.getUserById(alice.id)).toMatchObject({ voiceReplies: 'always', briefVoice: true, newsTopics: 'crypto (Bitcoin, RLC)' });

    executeTool('update_settings', { news_topics: '' }, as(alice.id));
    expect(store.getUserById(alice.id)!.newsTopics).toBeNull();
    expect(executeTool('update_settings', { voice_replies: 'parfois' }, as(alice.id)).isError).toBe(true);
  });

  it('programme un rappel vocal', () => {
    const { store, alice, as } = setup();
    const result = executeTool('schedule', { kind: 'reminder', when: '2026-10-15T09:00', text: 'Appeler Rado', voice: true }, as(alice.id));
    expect(result.content).toContain('rappel vocal');
    expect(store.listPendingJobs(alice.id)[0]).toMatchObject({ text: 'Appeler Rado', voice: true });
  });
});

describe('outils mémoire', () => {
  it("isole la mémoire de chaque utilisateur", () => {
    const { store, alice, bob, as } = setup();
    expect(executeTool('remember', { kind: 'project', content: 'Lancer Koto', importance: 3 }, as(alice.id)).isError).toBe(false);
    const id = store.listMemories(alice.id)[0]!.id;

    expect(executeTool('update_memory', { id, content: 'piraté' }, as(bob.id)).isError).toBe(true);
    expect(executeTool('forget', { id }, as(bob.id)).isError).toBe(true);
    expect(store.getMemory(alice.id, id)?.content).toBe('Lancer Koto');
    expect(store.listMemories(bob.id)).toHaveLength(0);

    expect(executeTool('update_memory', { id, content: 'Lancer Koto en novembre' }, as(alice.id)).isError).toBe(false);
    expect(store.getMemory(alice.id, id)?.content).toBe('Lancer Koto en novembre');
    expect(executeTool('forget', { id }, as(alice.id)).isError).toBe(false);
    expect(store.listMemories(alice.id)).toHaveLength(0);
  });

  it('refuse les secrets et évite les doublons', () => {
    const { store, alice, as } = setup();
    expect(executeTool('remember', { kind: 'note', content: 'Mon mot de passe Gmail est hunter2', importance: 1 }, as(alice.id)).isError).toBe(true);
    expect(executeTool('remember', { kind: 'note', content: 'Carte : 4970 1012 3456 7890', importance: 1 }, as(alice.id)).isError).toBe(true);
    expect(executeTool('remember', { kind: 'note', content: 'Sa clé privée : 0xabc123', importance: 1 }, as(alice.id)).isError).toBe(true);
    // Parler de mots de passe sans en donner reste permis.
    expect(executeTool('remember', { kind: 'preference', content: 'Utilise un gestionnaire de mots de passe', importance: 1 }, as(alice.id)).isError).toBe(false);
    expect(executeTool('remember', { kind: 'about', content: 'Joignable au +261 34 12 345 67', importance: 1 }, as(alice.id)).isError).toBe(false);

    executeTool('remember', { kind: 'person', content: 'Rado est son associé', importance: 2 }, as(alice.id));
    const again = executeTool('remember', { kind: 'person', content: 'rado est son associé', importance: 2 }, as(alice.id));
    expect(again.content).toContain('Déjà en mémoire');
    expect(store.listMemories(alice.id)).toHaveLength(3);
  });

  it('renvoie une erreur lisible pour une entrée invalide', () => {
    const { alice, as } = setup();
    const result = executeTool('remember', { kind: 'secret', content: '' }, as(alice.id));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Entrée invalide');
    expect(executeTool('inconnu', {}, as(alice.id)).isError).toBe(true);
  });
});

describe('outils rappels', () => {
  it("programme à l'heure locale et refuse le passé", () => {
    const { store, alice, as } = setup();
    const result = executeTool('schedule', { kind: 'reminder', when: '2026-10-15T09:00', text: 'Appeler Rado' }, as(alice.id));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('jeudi 15 octobre 2026 à 09:00');
    expect(store.listPendingJobs(alice.id)[0]).toMatchObject({ dueAt: Date.parse('2026-10-15T06:00:00Z'), repeat: 'none' });

    expect(executeTool('schedule', { kind: 'reminder', when: '2026-10-14T18:00', text: 'trop tard' }, as(alice.id)).isError).toBe(true);
    expect(executeTool('schedule', { kind: 'reminder', when: 'demain 9h', text: 'x' }, as(alice.id)).isError).toBe(true);
  });

  it("liste et annule seulement ses propres rappels", () => {
    const { store, alice, bob, as } = setup();
    executeTool('schedule', { kind: 'checkin', when: '2026-10-17T18:00', text: "Demander comment s'est passé l'entretien" }, as(alice.id));
    const id = store.listPendingJobs(alice.id)[0]!.id;

    expect(executeTool('list_scheduled', {}, as(bob.id)).content).toBe('Aucun rappel ni relance à venir.');
    expect(executeTool('cancel_scheduled', { id }, as(bob.id)).isError).toBe(true);
    expect(executeTool('list_scheduled', {}, as(alice.id)).content).toContain(`#${id} · relance`);
    expect(executeTool('cancel_scheduled', { id }, as(alice.id)).isError).toBe(false);
    expect(store.listPendingJobs(alice.id)).toHaveLength(0);
  });
});

describe('outil réglages', () => {
  it('change le fuseau et reprogramme le brief', () => {
    const { store, alice, as } = setup();
    expect(executeTool('update_settings', { timezone: 'Europe/Paris', brief_time: '08:15' }, as(alice.id)).isError).toBe(false);
    expect(store.getUserById(alice.id)).toMatchObject({ timezone: 'Europe/Paris', briefTime: '08:15' });
    expect(store.getBriefJob(alice.id)?.dueAt).toBe(parseLocalDateTime('2026-10-15T08:15', 'Europe/Paris'));

    expect(executeTool('update_settings', { timezone: 'Mars/Olympus' }, as(alice.id)).isError).toBe(true);
    expect(executeTool('update_settings', { brief_time: '25:00' }, as(alice.id)).isError).toBe(true);

    executeTool('update_settings', { brief_enabled: false }, as(alice.id));
    expect(store.getBriefJob(alice.id)).toBeNull();
  });
});
