import { describe, expect, it, vi } from 'vitest';
import { createInviteFor } from '../src/accounts.js';
import type { Agent, TurnRequest, TurnResult } from '../src/agent/agent.js';
import { startPayload, type BotDeps } from '../src/bot/bot.js';
import { VOICE_FAILED_TEXT } from '../src/bot/delivery.js';
import type { Synthesizer } from '../src/speech.js';
import { emptyUsage } from '../src/store.js';
import { NOW, fakeIntegrations, makeConfig } from './helpers.js';
import { buttons, callbackUpdate, locationUpdate, setupBot as setup, textUpdate, voiceUpdate } from './support/bot.js';

describe('bot Telegram', () => {
  it('refuse poliment un inconnu sans invitation', async () => {
    const { bot, store, sent, requests } = setup();
    await bot.handleUpdate(textUpdate(777, 'salut'));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('sur invitation');
    expect(sent()[0]).toContain('777');
    expect(store.countUsers()).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("accueille un invité puis transmet ses messages à l'agent", async () => {
    const { bot, store, sent, requests } = setup();
    await bot.handleUpdate(textUpdate(1000, '/start'));
    const code = createInviteFor(store, store.getUserByTelegramId(1000)!, NOW)!;

    await bot.handleUpdate(textUpdate(2000, `/start ${code}`));
    const guest = store.getUserByTelegramId(2000)!;
    expect(guest).not.toBeNull();
    expect(sent().at(-1)).toContain('<b>Koto</b>');
    // L'accueil est gardé dans l'historique, précédé du /start.
    expect(store.listMessagesAfter(guest.id, 0).map((m) => m.role)).toEqual(['user', 'assistant']);

    await bot.handleUpdate(textUpdate(2000, 'Je bosse sur mon mémoire de fin d’études'));
    expect(requests.at(-1)).toMatchObject({ userId: guest.id, kind: 'chat', text: 'Je bosse sur mon mémoire de fin d’études' });
    expect(sent().at(-1)).toBe('écho : Je bosse sur mon mémoire de fin d’études');
  });

  it("n'appelle pas l'agent au-delà du budget du jour", async () => {
    const { bot, store, sent, requests } = setup(makeConfig({ registrationMode: 'open', dailyBudgetUsd: 0.1 }));
    await bot.handleUpdate(textUpdate(3000, '/start'));
    store.addUsage(store.getUserByTelegramId(3000)!.id, '2026-10-14', { ...emptyUsage(), costUsd: 0.2 });

    await bot.handleUpdate(textUpdate(3000, 'encore une question'));

    expect(requests).toHaveLength(0);
    expect(sent().at(-1)).toContain('limite');
  });

  it('affiche la mémoire avec /memoire', async () => {
    const { bot, store, sent } = setup(makeConfig({ registrationMode: 'open' }));
    await bot.handleUpdate(textUpdate(4000, '/start'));
    store.addMemory(store.getUserByTelegramId(4000)!.id, { kind: 'project', content: 'Lancer Koto <v1>', importance: 3 }, NOW);

    await bot.handleUpdate(textUpdate(4000, '/memoire'));

    expect(sent().at(-1)).toContain('<b>Projets</b>');
    expect(sent().at(-1)).toContain('Lancer Koto &lt;v1&gt;');
  });

  it('extrait le code des liens t.me/<bot>?start=CODE', () => {
    expect(startPayload('/start ABC123')).toBe('ABC123');
    expect(startPayload('/start@koto_bot XYZ')).toBe('XYZ');
    expect(startPayload('/start')).toBeNull();
    expect(startPayload('bonjour')).toBeNull();
  });
});

describe('bot Telegram — vocaux', () => {
  it('écoute un vocal, compte la transcription et transmet le texte à l’agent', async () => {
    const transcriber = { transcribe: vi.fn(async () => ({ text: 'Rappelle-moi de payer la JIRAMA demain', costUsd: 0.0004 })) };
    const { bot, store, requests } = setup(makeConfig({ registrationMode: 'open' }), {
      transcriber,
      downloadFile: async () => Buffer.from('OggS'),
    });
    await bot.handleUpdate(textUpdate(5000, '/start'));

    await bot.handleUpdate(voiceUpdate(5000, 12));

    expect(transcriber.transcribe).toHaveBeenCalledWith(Buffer.from('OggS'), 'ogg');
    expect(requests.at(-1)).toMatchObject({
      kind: 'chat',
      text: '[message vocal transcrit] Rappelle-moi de payer la JIRAMA demain',
      historyText: '[vocal] Rappelle-moi de payer la JIRAMA demain',
    });
    expect(store.getUsage(store.getUserByTelegramId(5000)!.id, '2026-10-14').costUsd).toBeCloseTo(0.0004);
  });

  it('refuse un vocal trop long sans le transcrire', async () => {
    const transcriber = { transcribe: vi.fn() };
    const { bot, sent } = setup(makeConfig({ registrationMode: 'open' }), { transcriber, downloadFile: async () => Buffer.from('x') });
    await bot.handleUpdate(textUpdate(5001, '/start'));

    await bot.handleUpdate(voiceUpdate(5001, 600));

    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(sent().at(-1)).toContain('5 minutes max');
  });
});

describe('bot Telegram — réponses vocales', () => {
  function voiceSetup(agentResult: Partial<TurnResult> = {}, synthesize?: Synthesizer['synthesize']) {
    const transcriber = { transcribe: vi.fn(async () => ({ text: 'Quoi de neuf ?', costUsd: 0 })) };
    const synthesizer = { synthesize: vi.fn(synthesize ?? (async () => ({ audio: Buffer.from('mp3'), seconds: 4, costUsd: 0.0002 }))) };
    const harness = setup(makeConfig({ registrationMode: 'open' }), {
      transcriber,
      synthesizer,
      downloadFile: async () => Buffer.from('OggS'),
      agent: () => async (request) => ({ text: `**Réponse** à « ${request.text} »`, status: 'ok', usage: emptyUsage(), pendingActions: [], ...agentResult }),
    });
    const voices = () => harness.calls.filter((c) => c.method === 'sendVoice');
    return { ...harness, synthesizer, voices };
  }

  it('répond en vocal à un vocal (réglage par défaut), après le texte, et compte la synthèse', async () => {
    const { bot, store, calls, synthesizer, voices } = voiceSetup();
    await bot.handleUpdate(textUpdate(5100, '/start'));

    await bot.handleUpdate(voiceUpdate(5100, 5));

    expect(synthesizer.synthesize).toHaveBeenCalledWith('Réponse à « [message vocal transcrit] Quoi de neuf ? ».');
    expect(voices()).toHaveLength(1);
    expect(voices()[0]!.payload).toMatchObject({ chat_id: 5100, duration: 4 });
    const order = calls.map((c) => c.method).filter((m) => m === 'sendMessage' || m === 'sendVoice');
    expect(order.slice(-2)).toEqual(['sendMessage', 'sendVoice']);
    expect(store.getUsage(store.getUserByTelegramId(5100)!.id, '2026-10-14').costUsd).toBeCloseTo(0.0002);
  });

  it('reste à l’écrit pour un message écrit, sauf réglage « toujours » ou demande ponctuelle', async () => {
    const { bot, store, voices } = voiceSetup();
    await bot.handleUpdate(textUpdate(5101, '/start'));
    await bot.handleUpdate(textUpdate(5101, 'Salut'));
    expect(voices()).toHaveLength(0);

    store.updateUserSettings(store.getUserByTelegramId(5101)!.id, { voiceReplies: 'always' });
    await bot.handleUpdate(textUpdate(5101, 'Et maintenant ?'));
    expect(voices()).toHaveLength(1);

    const asked = voiceSetup({ voice: true });
    await asked.bot.handleUpdate(textUpdate(5102, '/start'));
    await asked.bot.handleUpdate(textUpdate(5102, 'Réponds-moi en vocal'));
    expect(asked.voices()).toHaveLength(1);
  });

  it('ne parle jamais quand la personne a coupé les vocaux', async () => {
    const { bot, store, voices } = voiceSetup();
    await bot.handleUpdate(textUpdate(5103, '/start'));
    store.updateUserSettings(store.getUserByTelegramId(5103)!.id, { voiceReplies: 'off' });

    await bot.handleUpdate(voiceUpdate(5103, 5));

    expect(voices()).toHaveLength(0);
  });

  it('prévient si le vocal échoue, sans perdre la réponse écrite', async () => {
    const { bot, sent, voices } = voiceSetup({}, async () => Promise.reject(new Error('quota')));
    await bot.handleUpdate(textUpdate(5104, '/start'));

    await bot.handleUpdate(voiceUpdate(5104, 5));

    expect(voices()).toHaveLength(0);
    expect(sent().slice(-2)).toEqual(['<b>Réponse</b> à « [message vocal transcrit] Quoi de neuf ? »', VOICE_FAILED_TEXT]);
  });
});

describe('bot Telegram — Gmail et Agenda', () => {
  it('présente une action préparée avec des boutons et ne l’exécute qu’après « Confirmer »', async () => {
    const fake = fakeIntegrations({ gmail: true });
    const { bot, store, messages, sent } = setup(makeConfig({ registrationMode: 'open' }), {
      integrations: fake.integrations,
      agent: (s) => async (request) => {
        const action = s.addPendingAction(request.userId, 'GMAIL_SEND_EMAIL', { recipient_email: 'rado@exemple.com', subject: 'Devis' }, NOW);
        return { text: "J'ai préparé le mail à Rado.", status: 'ok', usage: emptyUsage(), pendingActions: [action] };
      },
    });
    await bot.handleUpdate(textUpdate(6000, '/start'));
    await bot.handleUpdate(textUpdate(6000, 'Réponds à Rado que je valide'));

    const card = messages().at(-1)!.payload;
    expect(sent().at(-2)).toBe("J'ai préparé le mail à Rado.");
    expect(String(card.text)).toContain('Envoyer un mail');
    expect(String(card.text)).toContain('rado@exemple.com');
    const [confirm, cancel] = buttons(card);
    expect(confirm).toMatchObject({ text: '✅ Confirmer', callback_data: 'act:1:ok' });
    expect(cancel).toMatchObject({ text: '❌ Annuler', callback_data: 'act:1:no' });
    expect(fake.calls).toHaveLength(0);

    await bot.handleUpdate(callbackUpdate(6000, 'act:1:ok'));
    await bot.handleUpdate(callbackUpdate(6000, 'act:1:ok'));

    expect(fake.calls).toEqual([{ userId: store.getUserByTelegramId(6000)!.id, tool: 'GMAIL_SEND_EMAIL', args: { recipient_email: 'rado@exemple.com', subject: 'Devis' } }]);
    expect(sent().slice(-2)).toEqual(["✅ C'est fait.", 'Cette action a déjà été traitée.']);
  });

  it("n'exécute pas l'action d'un autre utilisateur", async () => {
    const fake = fakeIntegrations({ gmail: true });
    const { bot, store, sent } = setup(makeConfig({ registrationMode: 'open' }), { integrations: fake.integrations });
    await bot.handleUpdate(textUpdate(6100, '/start'));
    await bot.handleUpdate(textUpdate(6101, '/start'));
    const owner = store.getUserByTelegramId(6100)!;
    const action = store.addPendingAction(owner.id, 'GMAIL_SEND_EMAIL', { recipient_email: 'x@y.z' }, NOW);

    await bot.handleUpdate(callbackUpdate(6101, `act:${action.id}:ok`));

    expect(fake.calls).toHaveLength(0);
    expect(sent().at(-1)).toBe('Je ne retrouve pas cette action.');
  });

  it('/connecter montre les connexions, envoie le lien et confirme la connexion', async () => {
    const fake = fakeIntegrations({ gmail: false, googlecalendar: true });
    const { bot, store, messages, sent } = setup(makeConfig({ registrationMode: 'open' }), { integrations: fake.integrations });
    await bot.handleUpdate(textUpdate(7000, '/start'));

    await bot.handleUpdate(textUpdate(7000, '/connecter'));
    const panel = messages().at(-1)!.payload;
    expect(String(panel.text)).toContain('✅ Google Agenda');
    expect(String(panel.text)).toContain('⚪️ Gmail');
    expect(buttons(panel).map((b) => b.callback_data)).toEqual(['disconnect:googlecalendar', 'connect:gmail']);

    await bot.handleUpdate(callbackUpdate(7000, 'connect:gmail'));
    // La fausse connexion aboutit tout de suite : le lien n'est pas forcément le dernier message.
    const link = messages().flatMap((m) => buttons(m.payload)).find((b) => b.url);
    expect(link).toEqual({ text: '🔗 Connecter Gmail', url: 'https://connect.example/gmail' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent().at(-1)).toContain('✅ Gmail est connecté');
    expect(store.getConnections(store.getUserByTelegramId(7000)!.id)).toMatchObject({ gmail: true, googlecalendar: true });
  });
});

describe('bot Telegram — tâches web', () => {
  it('transmet la réponse aux boutons et liste les tâches avec un bouton Arrêter', async () => {
    const answers: [number, string][] = [];
    const cancels: number[] = [];
    const browserTasks = {
      answer: (_user: unknown, questionId: number, answer: string) => {
        answers.push([questionId, answer]);
        return questionId === 7;
      },
      cancel: (_user: unknown, taskId: number) => {
        cancels.push(taskId);
        return true;
      },
    } as unknown as NonNullable<BotDeps['browserTasks']>;
    const { bot, store, messages, sent } = setup(makeConfig({ registrationMode: 'open' }), { browserTasks });
    await bot.handleUpdate(textUpdate(8000, '/start'));
    const user = store.getUserByTelegramId(8000)!;
    const task = store.addBrowserTask(user.id, 'Comparer les vols Tana → Paris', null, NOW);
    store.setBrowserTaskStatus(task.id, 'running', NOW);

    await bot.handleUpdate(callbackUpdate(8000, 'bt:7:yes'));
    await bot.handleUpdate(callbackUpdate(8000, 'bt:8:no'));
    expect(answers).toEqual([[7, 'yes'], [8, 'no']]);
    expect(sent().slice(-2)).toEqual(['👍 Je continue.', 'Cette question a expiré ou a déjà reçu une réponse.']);

    await bot.handleUpdate(textUpdate(8000, '/taches'));
    const list = messages().at(-1)!.payload;
    expect(String(list.text)).toContain(`🌐 #${task.id} — Comparer les vols Tana → Paris`);
    expect(buttons(list)).toEqual([{ text: `⏹️ Arrêter #${task.id}`, callback_data: `btcancel:${task.id}` }]);

    await bot.handleUpdate(callbackUpdate(8000, `btcancel:${task.id}`));
    expect(cancels).toEqual([task.id]);
    expect(sent().at(-1)).toBe("⏹️ J'arrête la tâche.");
  });
});

describe('bot Telegram — listes, lieu et export', () => {
  it('affiche les listes à cocher et coche d’un geste, sans appeler le modèle', async () => {
    const { bot, store, calls, requests } = setup(makeConfig({ registrationMode: 'open' }));
    await bot.handleUpdate(textUpdate(9100, '/start'));
    const user = store.getUserByTelegramId(9100)!;
    store.addListItems(user.id, 'courses', ['lait', 'pain'], NOW);

    await bot.handleUpdate(textUpdate(9100, '/listes'));
    const card = calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(buttons(card.payload).map((b) => b.text)).toEqual(['⬜ lait', '⬜ pain']);

    await bot.handleUpdate(callbackUpdate(9100, buttons(card.payload)[0]!.callback_data!, 7));
    const edit = calls.find((c) => c.method === 'editMessageText')!;
    expect(edit.payload).toMatchObject({ message_id: 7 });
    expect(buttons(edit.payload).map((b) => b.text)).toEqual(['⬜ pain', '✅ lait']);
    expect(store.listOpenItems(user.id).map((i) => i.text)).toEqual(['pain']);
    expect(requests).toHaveLength(0);
  });

  it('ne coche jamais l’élément de quelqu’un d’autre', async () => {
    const { bot, store, calls } = setup(makeConfig({ registrationMode: 'open' }));
    await bot.handleUpdate(textUpdate(9101, '/start'));
    await bot.handleUpdate(textUpdate(9102, '/start'));
    const [lait] = store.addListItems(store.getUserByTelegramId(9101)!.id, 'courses', ['lait'], NOW);

    await bot.handleUpdate(callbackUpdate(9102, `li:${lait!.id}`));

    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toContain('n’existe plus');
    expect(store.getListItem(store.getUserByTelegramId(9101)!.id, lait!.id)!.done).toBe(false);
  });

  it('retient une position partagée, arrondie à environ 1 km, pour la météo du brief', async () => {
    const reverse = vi.fn(async (latitude: number, longitude: number) => ({ name: 'Antananarivo, Madagascar', latitude, longitude }));
    const weather = { reverse, geocode: vi.fn(), forecast: vi.fn() };
    const { bot, store, sent } = setup(makeConfig({ registrationMode: 'open' }), { weather });
    await bot.handleUpdate(textUpdate(9103, '/start'));

    await bot.handleUpdate(locationUpdate(9103, -18.910012, 47.525581));

    expect(reverse).toHaveBeenCalledWith(-18.91, 47.53);
    expect(store.getUserByTelegramId(9103)!.place).toEqual({ name: 'Antananarivo, Madagascar', latitude: -18.91, longitude: 47.53 });
    expect(sent().at(-1)).toContain('C’est noté : Antananarivo, Madagascar'.replace('’', "'"));
  });

  it('envoie toutes les données de la personne dans un fichier', async () => {
    const { bot, store, calls } = setup(makeConfig({ registrationMode: 'open' }));
    await bot.handleUpdate(textUpdate(9104, '/start'));
    store.addMemory(store.getUserByTelegramId(9104)!.id, { kind: 'project', content: 'Lancer Koto', importance: 3 }, NOW);

    await bot.handleUpdate(textUpdate(9104, '/exporter'));

    const doc = calls.find((c) => c.method === 'sendDocument')!;
    expect(String(doc.payload.caption)).toContain('/oublier_tout');
    const file = doc.payload.document as { filename?: string };
    expect(file.filename).toBe('koto-mes-donnees-2026-10-14.json');
  });

  it('montre les réglages vocaux et la veille dans /rappels', async () => {
    const { bot, store, sent } = setup(makeConfig({ registrationMode: 'open' }), { synthesizer: { synthesize: vi.fn() }, news: { digest: vi.fn() } });
    await bot.handleUpdate(textUpdate(9105, '/start'));
    store.updateUserSettings(store.getUserByTelegramId(9105)!.id, { briefVoice: true, newsTopics: 'crypto' });

    await bot.handleUpdate(textUpdate(9105, '/rappels'));

    expect(sent().at(-1)).toContain('chaque jour à 07:30 (Indian/Antananarivo), aussi en vocal');
    expect(sent().at(-1)).toContain('📰 Veille : crypto');
    expect(sent().at(-1)).toContain("🔊 Réponses vocales : quand tu m'envoies un vocal");
  });
});
