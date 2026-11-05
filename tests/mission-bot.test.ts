// Le bot grammY réel avec les missions (API Telegram interceptée) : /missions, bouton Arrêter, conclusion gardée
// en mémoire, en privé comme en groupe. Rien de tout cela ne passe par le modèle.
import { describe, expect, it } from 'vitest';
import { MissionRunner } from '../src/missions/runner.js';
import type { NewMission, Store, User } from '../src/store.js';
import { KeyedLock } from '../src/util.js';
import { NOW, makeConfig } from './helpers.js';
import { botMembershipUpdate, buttons, callbackUpdate, groupCallbackUpdate, groupTextUpdate, setupBot, textUpdate } from './support/bot.js';

const ANA = 9300;
const BOB = 9301;
const GROUP = -100888;
const HOUR = 3_600_000;

function harness(missions = true) {
  const config = makeConfig({ registrationMode: 'open' });
  const h = setupBot(config, {
    ...(missions
      ? {
          missions: (store: Store) =>
            new MissionRunner({
              store,
              config,
              create: async () => {
                throw new Error('aucun passage dans ces tests');
              },
              notifier: { send: async () => {}, confirm: async () => {}, proposeConclusion: async () => {} },
              locks: new KeyedLock(),
            }),
        }
      : {}),
  });
  const answers = () => h.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text);
  const toGroup = () => h.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === GROUP);
  return { ...h, answers, toGroup };
}

function addMission(store: Store, account: User, overrides: Partial<NewMission> = {}) {
  return store.addMission(
    account.id,
    {
      title: 'Vol Tana → Paris',
      goal: 'Surveiller le prix du vol Tana → Paris du 4 décembre.',
      doneWhen: 'prix sous 600 €',
      intervalMinutes: 360,
      deadlineAt: Date.parse('2026-10-20T06:00:00Z'), // mardi 20 octobre, 09:00 à Antananarivo
      maxCostUsd: 0.25,
      nextRunAt: NOW + HOUR,
      ...overrides,
    },
    NOW,
  );
}

describe('bot Telegram — missions', () => {
  it('/missions : la liste, un bouton Arrêter par mission en cours, sans appeler le modèle', async () => {
    const { bot, store, messages, sent, requests } = harness();
    await bot.handleUpdate(textUpdate(ANA, '/start'));
    const ana = store.getUserByTelegramId(ANA)!;
    const flight = addMission(store, ana);
    const dossier = addMission(store, ana, { title: 'Dossier subventions' });
    store.recordMissionRun(ana.id, dossier.id, { costUsd: 0.012, notes: 'x', failed: false }, NOW);
    store.endMission(ana.id, dossier.id, { status: 'done', reason: 'goal' }, NOW);

    await bot.handleUpdate(textUpdate(ANA, '/missions'));

    const list = messages().at(-1)!.payload;
    expect(String(list.text)).toContain(`🎯 <b>#${flight.id} · Vol Tana → Paris</b>\ntoutes les 6 h, jusqu'à mardi à 09:00 · 0 passage · 0,00 $ sur 0,25 $`);
    expect(String(list.text)).toContain(`✅ <b>#${dossier.id} · Dossier subventions</b>\nterminée (objectif atteint), aujourd'hui à 19:00 · 1 passage · 0,012 $`);
    expect(buttons(list)).toEqual([{ text: `⏹️ Arrêter #${flight.id}`, callback_data: `ms:${flight.id}:stop` }]);

    await bot.handleUpdate(callbackUpdate(ANA, `ms:${flight.id}:stop`));
    expect(sent().at(-1)).toBe(`⏹️ Mission #${flight.id} arrêtée.`);
    expect(store.getMission(ana.id, flight.id)).toMatchObject({ status: 'stopped', endReason: 'person' });
    // Koto ne la présentera plus comme en cours.
    expect(store.listMessagesAfter(ana.id, 0).at(-1)).toMatchObject({ kind: 'mission', content: `⏹️ Mission #${flight.id} « Vol Tana → Paris » arrêtée depuis /missions.` });
    await bot.handleUpdate(callbackUpdate(ANA, `ms:${flight.id}:stop`));
    expect(sent().at(-1)).toBe('Cette mission est déjà terminée.');
    expect(requests).toHaveLength(0);
  });

  it('le bouton Arrêter n’atteint jamais la mission de quelqu’un d’autre', async () => {
    const { bot, store, sent } = harness();
    await bot.handleUpdate(textUpdate(ANA, '/start'));
    await bot.handleUpdate(textUpdate(BOB, '/start'));
    const ana = store.getUserByTelegramId(ANA)!;
    const flight = addMission(store, ana);

    await bot.handleUpdate(callbackUpdate(BOB, `ms:${flight.id}:stop`));
    await bot.handleUpdate(textUpdate(BOB, '/missions'));

    expect(sent().slice(-2)).toEqual([
      'Cette mission est déjà terminée.',
      "Aucune mission pour l'instant. Demande-moi par exemple : « Surveille le vol Tana → Paris du 4 décembre et préviens-moi s'il passe sous 600 € ».",
    ]);
    expect(store.getMission(ana.id, flight.id)?.status).toBe('active');
  });

  it('garde la conclusion d’une mission terminée d’un bouton, une seule fois, et seulement pour son compte', async () => {
    const { bot, store, sent, answers } = harness();
    await bot.handleUpdate(textUpdate(ANA, '/start'));
    await bot.handleUpdate(textUpdate(BOB, '/start'));
    const ana = store.getUserByTelegramId(ANA)!;
    const bob = store.getUserByTelegramId(BOB)!;
    const kept = addMission(store, ana);
    store.endMission(ana.id, kept.id, { status: 'done', reason: 'goal', conclusion: 'Le 14 oct. 2026, le vol Tana → Paris était à 585 €.' }, NOW);
    const other = addMission(store, ana, { title: 'Dossier subventions' });
    store.endMission(ana.id, other.id, { status: 'done', reason: 'deadline', conclusion: 'Trois subventions repérées pour les startups malgaches.' }, NOW);

    await bot.handleUpdate(callbackUpdate(ANA, `ms:${kept.id}:keep`));
    expect(answers().at(-1)).toBe('Gardé en mémoire 🧠');
    expect(sent().at(-1)).toBe('🧠 C’est noté dans ma mémoire (/memoire).');
    await bot.handleUpdate(callbackUpdate(ANA, `ms:${kept.id}:keep`));
    expect(answers().at(-1)).toBe('Déjà traité.');

    await bot.handleUpdate(callbackUpdate(BOB, `ms:${other.id}:keep`));
    expect(store.listMemories(bob.id)).toEqual([]);
    expect(store.getMission(ana.id, other.id)?.conclusionState).toBe('proposed');
    await bot.handleUpdate(callbackUpdate(ANA, `ms:${other.id}:drop`));
    expect(answers().at(-1)).toBe('D’accord, je ne garde rien.');

    expect(store.listMemories(ana.id).map((m) => m.content)).toEqual(['Le 14 oct. 2026, le vol Tana → Paris était à 585 €.']);
    expect(store.getMission(ana.id, other.id)?.conclusionState).toBe('declined');
  });

  it('en groupe : /missions montre celles du groupe, les boutons n’atteignent jamais celles d’un membre, et retirer Koto les arrête', async () => {
    const { bot, store, toGroup, answers } = harness();
    await bot.handleUpdate(textUpdate(ANA, '/start'));
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'added'));
    const ana = store.getUserByTelegramId(ANA)!;
    const group = store.getGroupByChatId(GROUP)!;
    const personal = addMission(store, ana, { title: 'Mission privée d’Ana' });
    const shared = addMission(store, group, { title: 'Météo Andasibe' });

    await bot.handleUpdate(groupTextUpdate(GROUP, BOB, '/missions', { firstName: 'Bob' }));
    const list = toGroup().at(-1)!.payload;
    expect(String(list.text)).toContain('🎯 <b>Les missions du groupe</b>');
    expect(String(list.text)).toContain('Météo Andasibe');
    expect(String(list.text)).not.toContain('Mission privée');
    expect(buttons(list)).toEqual([{ text: `⏹️ Arrêter #${shared.id}`, callback_data: `ms:${shared.id}:stop` }]);

    await bot.handleUpdate(groupCallbackUpdate(GROUP, BOB, `ms:${personal.id}:stop`));
    expect(String(toGroup().at(-1)!.payload.text)).toBe('Cette mission est déjà terminée.');
    expect(store.getMission(ana.id, personal.id)?.status).toBe('active');
    store.endMission(group.id, shared.id, { status: 'done', reason: 'goal', conclusion: 'Pluie prévue samedi à Andasibe.' }, NOW);
    await bot.handleUpdate(groupCallbackUpdate(GROUP, BOB, `ms:${shared.id}:keep`));
    expect(answers().at(-1)).toBe('Gardé en mémoire 🧠');
    expect(store.listMemories(group.id).map((m) => m.content)).toEqual(['Pluie prévue samedi à Andasibe.']);
    expect(store.listMemories(ana.id)).toEqual([]);

    const running = addMission(store, group, { title: 'Prix du charbon' });
    await bot.handleUpdate(botMembershipUpdate(GROUP, ANA, 'removed'));
    expect(store.getMission(group.id, running.id)).toMatchObject({ status: 'stopped', endReason: 'removed' });
    expect(store.getMission(ana.id, personal.id)?.status).toBe('active');
  });

  it('annonce /missions dans l’aide, et répond simplement quand les missions sont coupées', async () => {
    const on = harness();
    await on.bot.handleUpdate(textUpdate(ANA, '/aide'));
    expect(on.sent().at(-1)).toContain('/missions — tes missions en arrière-plan');

    const off = harness(false);
    await off.bot.handleUpdate(textUpdate(ANA, '/missions'));
    await off.bot.handleUpdate(textUpdate(ANA, '/aide'));
    expect(off.sent().at(-2)).toBe('Les missions ne sont pas activées sur ce Koto.');
    expect(off.sent().at(-1)).not.toContain('/missions');
  });
});
