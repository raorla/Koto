import { describe, expect, it } from 'vitest';
import { scheduleBrief } from '../src/accounts.js';
import { createAgent } from '../src/agent/agent.js';
import type { NewsService } from '../src/news.js';
import type { WeatherService } from '../src/weather.js';
import { createScheduler, type Notifier } from '../src/scheduler.js';
import { KeyedLock, silentLogger } from '../src/util.js';
import { NOW, fakeIntegrations, makeConfig, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';

function setup(responses: Parameters<typeof scriptedCreate>[0] = [], notifier?: Notifier) {
  const store = makeStore();
  const user = makeUser(store);
  const sent: string[] = [];
  const { create, calls } = scriptedCreate(responses);
  let now = NOW;
  const clock = () => now;
  const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, now: clock });
  const scheduler = createScheduler({
    store,
    config: makeConfig(),
    agent,
    locks: new KeyedLock(),
    log: silentLogger,
    now: clock,
    notifier: notifier ?? { send: async (_chatId, t) => void sent.push(t) },
  });
  return { store, user, sent, calls, scheduler, setNow: (t: number) => (now = t) };
}

describe('scheduler', () => {
  it('envoie les rappels dus et reprogramme ceux qui se répètent, sans appeler le modèle', async () => {
    const { store, user, sent, calls, scheduler } = setup();
    const once = store.addJob(user.id, { kind: 'reminder', text: "Boire de l'eau", dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);
    const daily = store.addJob(user.id, { kind: 'reminder', text: 'Sport', dueAt: NOW - 1_000, repeat: 'daily' }, NOW - 5_000);

    expect(await scheduler.tick()).toBe(2);

    expect(sent).toEqual(["⏰ Boire de l'eau", '⏰ Sport']);
    expect(store.getJob(user.id, once.id)?.status).toBe('done');
    expect(store.getJob(user.id, daily.id)).toMatchObject({ status: 'pending', dueAt: NOW - 1_000 + 86_400_000 });
    expect(calls).toHaveLength(0);
  });

  it('saute le brief tant que Koto ne sait rien, puis l’envoie', async () => {
    const { store, user, sent, calls, scheduler, setNow } = setup([message([text('Bonjour ! Priorité du jour : Koto.')], 'end_turn')]);
    scheduleBrief(store, user, NOW);
    const brief = store.getBriefJob(user.id)!;

    setNow(brief.dueAt + 60_000);
    await scheduler.tick();
    expect(sent).toHaveLength(0);
    expect(store.getBriefJob(user.id)!.dueAt).toBe(brief.dueAt + 86_400_000);

    store.addMemory(user.id, { kind: 'project', content: 'Lancer Koto', importance: 3 }, NOW);
    setNow(brief.dueAt + 86_400_000 + 60_000);
    await scheduler.tick();

    expect(sent).toEqual(['Bonjour ! Priorité du jour : Koto.']);
    expect(JSON.stringify(calls[0]!.messages.at(-1))).toContain('[BRIEF DU MATIN]');
    expect(store.listMessagesAfter(user.id, 0)[0]!.content).toBe('[BRIEF DU MATIN — déclenché automatiquement]');
  });

  it('rédige les relances avec l’agent', async () => {
    const { store, user, sent, calls, scheduler } = setup([message([text("Alors, cet entretien ?")], 'end_turn')]);
    store.addJob(user.id, { kind: 'checkin', text: 'Entretien chez Orange', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);

    await scheduler.tick();

    expect(sent).toEqual(['Alors, cet entretien ?']);
    expect(JSON.stringify(calls[0]!.messages.at(-1))).toContain('Entretien chez Orange');
  });

  it("réessaie un envoi raté, puis abandonne", async () => {
    let attempts = 0;
    const failing: Notifier = {
      send: async () => {
        attempts++;
        throw new Error('Telegram indisponible');
      },
    };
    const { store, user, scheduler, setNow } = setup([], failing);
    const job = store.addJob(user.id, { kind: 'reminder', text: 'x', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);

    for (let i = 0; i < 3; i++) {
      setNow(store.getJob(user.id, job.id)!.dueAt + 1);
      await scheduler.tick();
    }

    expect(attempts).toBe(3);
    expect(store.getJob(user.id, job.id)?.status).toBe('failed');
  });
});

describe('scheduler — voix et veille', () => {
  function voiceSetup(responses: Parameters<typeof scriptedCreate>[0] = [], news?: NewsService, speakImpl?: Notifier['speak']) {
    const store = makeStore();
    const user = makeUser(store);
    const { create, calls } = scriptedCreate(responses);
    let now = NOW;
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: true, now: () => now });
    const sent: string[] = [];
    const spoken: string[] = [];
    const scheduler = createScheduler({
      store,
      config: makeConfig(),
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      now: () => now,
      news,
      notifier: { send: async (_chatId, t) => void sent.push(t), speak: speakImpl ?? (async (_user, t) => void spoken.push(t)) },
    });
    return { store, user, calls, scheduler, sent, spoken, setNow: (t: number) => (now = t) };
  }

  it('lit un rappel vocal après l’avoir écrit, sans appeler le modèle', async () => {
    const { store, user, scheduler, sent, spoken, calls } = voiceSetup();
    store.addJob(user.id, { kind: 'reminder', text: "Boire de l'eau", dueAt: NOW - 1_000, repeat: 'none', voice: true }, NOW - 5_000);
    store.addJob(user.id, { kind: 'reminder', text: 'Sport', dueAt: NOW - 1_000, repeat: 'none' }, NOW - 5_000);

    await scheduler.tick();

    expect(sent).toEqual(["⏰ Boire de l'eau", '⏰ Sport']);
    expect(spoken).toEqual(["Petit rappel : Boire de l'eau"]);
    expect(calls).toHaveLength(0);
  });

  it('fait le brief avec la veille gratuite, sans recherche web, et le lit si demandé', async () => {
    const news: NewsService = {
      digest: async (topics) => ({ text: `## Crypto\nCours (CoinGecko) : Bitcoin 81 811 $ (−1,7 % en 24 h)\n- [il y a 2 h] ETF Solana validé (Cryptoast) https://cryptoast.fr/a`, uncovered: topics.includes('pêche') ? ['pêche'] : [] }),
    };
    const { store, user, scheduler, sent, spoken, calls, setNow } = voiceSetup(
      [message([text('Bonjour ! Le bitcoin recule de 1,7 %, et l’ETF Solana est validé ([Cryptoast](https://cryptoast.fr/a)).')], 'end_turn')],
      news,
    );
    // Aucune mémoire : la veille suffit à déclencher le brief.
    store.updateUserSettings(user.id, { newsTopics: 'crypto, pêche', briefVoice: true });
    scheduleBrief(store, user, NOW);
    setNow(store.getBriefJob(user.id)!.dueAt + 60_000);

    await scheduler.tick();

    const trigger = JSON.stringify(calls[0]!.messages.at(-1));
    expect(trigger).toContain('<veille>');
    expect(trigger).toContain('ETF Solana validé (Cryptoast)');
    expect(trigger).toContain('Pas de recherche web pour ces sujets');
    expect(trigger).toContain('UNE seule recherche web');
    expect(trigger).toContain('« pêche »');
    expect(trigger).toContain('lu à voix haute');
    expect(sent).toHaveLength(1);
    expect(spoken).toEqual([sent[0]]);
    // L'historique garde le brief rédigé, pas les titres de la veille.
    expect(store.listMessagesAfter(user.id, 0).map((m) => m.content).join('\n')).not.toContain('<veille>');
  });

  it('ne rejoue pas un rappel déjà écrit si le vocal échoue', async () => {
    const { store, user, scheduler, sent } = voiceSetup([], undefined, async () => {
      throw new Error('synthèse indisponible');
    });
    const job = store.addJob(user.id, { kind: 'reminder', text: 'Appeler Rado', dueAt: NOW - 1_000, repeat: 'none', voice: true }, NOW - 5_000);

    await scheduler.tick();

    expect(sent).toEqual(['⏰ Appeler Rado']);
    expect(store.getJob(user.id, job.id)?.status).toBe('done');
  });
});

describe('scheduler — météo et listes dans le brief', () => {
  it('donne la météo du jour (gratuite) et rappelle les tâches qui comptent', async () => {
    const weather: WeatherService = {
      forecast: async () => [{ date: '2026-10-15', min: 13, max: 25, rainMm: 2.5, label: 'averses' }],
      geocode: async () => null,
      reverse: async (latitude, longitude) => ({ name: 'x', latitude, longitude }),
    };
    const store = makeStore();
    const user = makeUser(store);
    const { create, calls } = scriptedCreate([message([text('Bonjour ! Prends un parapluie.')], 'end_turn')]);
    let now = NOW;
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, weather, now: () => now });
    const sent: string[] = [];
    const scheduler = createScheduler({
      store,
      config: makeConfig(),
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      now: () => now,
      weather,
      notifier: { send: async (_chatId, t) => void sent.push(t) },
    });
    // Ni mémoire ni agenda : un lieu et une tâche suffisent à déclencher le brief.
    store.updateUserSettings(user.id, { place: { name: 'Antananarivo, Madagascar', latitude: -18.91, longitude: 47.53 } });
    store.addListItems(user.id, 'tâches', ['Envoyer le devis à Rado'], NOW);
    scheduleBrief(store, user, NOW);
    now = store.getBriefJob(user.id)!.dueAt + 60_000;

    await scheduler.tick();

    const trigger = JSON.stringify(calls[0]!.messages.at(-1));
    expect(trigger).toContain('Météo du jour à Antananarivo, Madagascar (MET Norway) : 13 à 25 °C, averses, 2,5 mm de pluie');
    expect(trigger).toContain('Ses listes (<listes>)');
    expect(JSON.stringify(calls[0]!.system)).toContain('Envoyer le devis à Rado');
    expect(sent).toEqual(['Bonjour ! Prends un parapluie.']);
  });
});

describe('scheduler — Gmail et Agenda', () => {
  it("lance le brief dès qu'un compte est connecté, le fait consulter et présente les actions préparées", async () => {
    const store = makeStore();
    const user = makeUser(store);
    store.setConnection(user.id, 'googlecalendar', true, NOW);
    store.setConnection(user.id, 'gmail', true, NOW);
    const fake = fakeIntegrations();
    const { create, calls } = scriptedCreate([
      message([toolUse('t1', 'GMAIL_SEND_EMAIL', { recipient_email: 'rado@exemple.com', subject: 'Relance devis' })], 'tool_use'),
      message([text('Bonjour ! 10h : réunion avec Rado. Je t’ai préparé la relance du devis.')], 'end_turn'),
    ]);
    let now = NOW;
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, integrations: fake.integrations, now: () => now });
    const sent: string[] = [];
    const confirmations: number[] = [];
    const scheduler = createScheduler({
      store,
      config: makeConfig(),
      agent,
      locks: new KeyedLock(),
      log: silentLogger,
      now: () => now,
      notifier: { send: async (_chatId, t) => void sent.push(t), confirm: async (_chatId, action) => void confirmations.push(action.id) },
    });
    scheduleBrief(store, user, NOW);
    now = store.getBriefJob(user.id)!.dueAt + 60_000;

    await scheduler.tick();

    const trigger = JSON.stringify(calls[0]!.messages.at(-1));
    expect(trigger).toContain('consulte Google Agenda');
    expect(trigger).toContain('is:unread newer_than:1d');
    expect(sent).toEqual(['Bonjour ! 10h : réunion avec Rado. Je t’ai préparé la relance du devis.']);
    expect(confirmations).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });
});
