// Missions, brique par brique : données (isolation, réservation des passages), outils de l'agent principal,
// contexte d'un passage, export et effacement. Aucun appel au modèle ici (voir mission-*.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { renderGroupContext, renderUserContext, systemPrompt } from '../src/agent/prompt.js';
import { buildTools, runTool, type TurnToolContext } from '../src/agent/tools.js';
import { buildExport } from '../src/export.js';
import { formatUsd, renderMissionsContext, rhythmLabel, type MissionSettings } from '../src/missions/missions.js';
import { buildPassTools, passSystemPrompt, renderPassContext, type PassFeatures } from '../src/missions/pass.js';
import { coinIds, createNewsService } from '../src/news.js';
import type { NewMission, Store, User } from '../src/store.js';
import { parseLocalDateTime } from '../src/time.js';
import { silentLogger } from '../src/util.js';
import { NOW, makeGroup, makeStore, makeUser } from './helpers.js';

const HOUR = 3_600_000;
const toolNames = (tools: unknown[]) => (tools as { name: string }[]).map((t) => t.name);
const SETTINGS: MissionSettings = { minHours: 1, defaultMaxCostUsd: 0.25 };
const TZ = 'Indian/Antananarivo';

const START = {
  title: 'Vol Tana → Paris du 4 déc.',
  goal: 'Surveiller le prix du vol Antananarivo → Paris du 4 décembre 2026, en classe éco, avec un bagage en soute.',
  done_when: 'prix sous 600 €',
  every_hours: 6,
  deadline: '2026-12-03T09:00',
};

function setup() {
  const store = makeStore();
  const ana = makeUser(store, { firstName: 'Ana' });
  const bob = makeUser(store, { firstName: 'Bob' });
  const as = (userId: number, now = NOW, missions: MissionSettings | null = SETTINGS): TurnToolContext => ({
    store,
    userId,
    now,
    integrations: null,
    pending: [],
    checked: new Set(),
    missions,
  });
  return { store, ana, bob, as };
}

function addMission(store: Store, account: User, overrides: Partial<NewMission> = {}) {
  return store.addMission(
    account.id,
    {
      title: 'Vol Tana → Paris',
      goal: 'Surveiller le prix du vol Tana → Paris du 4 décembre.',
      doneWhen: 'prix sous 600 €',
      intervalMinutes: 360,
      deadlineAt: NOW + 20 * 24 * HOUR,
      maxCostUsd: 0.25,
      nextRunAt: NOW,
      ...overrides,
    },
    NOW,
  );
}

describe('missions — lancement par l’agent principal', () => {
  it('lance une mission : rythme, date limite et plafond, premier passage tout de suite', async () => {
    const { store, ana, as } = setup();

    const result = await runTool('mission_start', START, as(ana.id));

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Mission #1 lancée : « Vol Tana → Paris du 4 déc. », toutes les 6 h jusqu'au jeudi 3 décembre 2026 à 09:00 (Indian/Antananarivo), plafond 0,25 $.",
    );
    expect(result.content).toContain('en une phrase');
    expect(store.listActiveMissions(ana.id)).toEqual([
      expect.objectContaining({
        id: 1,
        title: START.title,
        goal: START.goal,
        doneWhen: 'prix sous 600 €',
        intervalMinutes: 360,
        deadlineAt: parseLocalDateTime('2026-12-03T09:00', TZ),
        maxCostUsd: 0.25,
        nextRunAt: NOW,
        status: 'active',
        runs: 0,
        notes: '',
      }),
    ]);
  });

  it('ramène rythme et plafond dans les limites, et refuse une date limite passée, lointaine ou mal écrite', async () => {
    const { store, ana, as } = setup();

    const clamped = await runTool('mission_start', { ...START, every_hours: 0.25, max_cost_usd: 5 }, as(ana.id));
    expect(clamped.content).toContain('rythme ramené au minimum : toutes les heures');
    expect(clamped.content).toContain('plafond ramené au maximum : 2,00 $');
    expect(store.listActiveMissions(ana.id)[0]).toMatchObject({ intervalMinutes: 60, maxCostUsd: 2 });

    for (const deadline of ['2026-10-14T18:00', '2026-10-14T19:05', '2027-03-01T09:00', 'jeudi prochain']) {
      expect((await runTool('mission_start', { ...START, deadline }, as(ana.id))).isError).toBe(true);
    }
    // Sans rythme, un passage par jour.
    await runTool('mission_start', { ...START, every_hours: undefined }, as(ana.id));
    expect(store.listActiveMissions(ana.id).at(-1)).toMatchObject({ intervalMinutes: 1_440 });
  });

  it('au plus 5 missions en cours, jamais de secret, et rien quand les missions sont coupées', async () => {
    const { store, ana, bob, as } = setup();
    for (let i = 0; i < 5; i++) expect((await runTool('mission_start', START, as(ana.id))).isError).toBe(false);

    const sixth = await runTool('mission_start', START, as(ana.id));
    expect(sixth).toMatchObject({ isError: true });
    expect(sixth.content).toContain('/missions');
    expect((await runTool('mission_start', START, as(bob.id))).isError).toBe(false);

    const secret = await runTool('mission_start', { ...START, goal: 'Se connecter avec le mot de passe : hunter2 et vérifier le solde' }, as(bob.id));
    expect(secret.isError).toBe(true);
    const off = await runTool('mission_start', START, as(bob.id, NOW, null));
    expect(off).toMatchObject({ isError: true });
    expect(store.countActiveMissions(bob.id)).toBe(1);
  });

  it('transmet une consigne (prochain passage avancé, sans dépasser un passage par heure), change le rythme, arrête', async () => {
    const { store, ana, bob, as } = setup();
    await runTool('mission_start', START, as(ana.id));
    // Premier passage fait à NOW : le suivant est prévu 6 h plus tard.
    expect(store.claimMissionRun(ana.id, 1, NOW, NOW + 6 * HOUR)).toBe(true);

    const noted = await runTool('mission_update', { id: 1, note: 'Air Madagascar de préférence, pas d’escale à Nairobi.' }, as(ana.id, NOW + 10 * 60_000));
    expect(noted.isError).toBe(false);
    expect(store.getMission(ana.id, 1)).toMatchObject({
      instructions: '[mer. 14 oct. 2026, 19:10] Air Madagascar de préférence, pas d’escale à Nairobi.',
      nextRunAt: NOW + HOUR,
    });

    await runTool('mission_update', { id: 1, every_hours: 12 }, as(ana.id, NOW + 20 * 60_000));
    expect(store.getMission(ana.id, 1)).toMatchObject({ intervalMinutes: 720, nextRunAt: NOW + 12 * HOUR });

    // Bob ne peut ni lire, ni changer, ni arrêter la mission d'Ana.
    expect((await runTool('mission_update', { id: 1, stop: true }, as(bob.id))).isError).toBe(true);
    expect((await runTool('mission_update', { id: 1, note: 'piraté' }, as(bob.id))).isError).toBe(true);
    expect(store.getMission(ana.id, 1)?.status).toBe('active');

    expect((await runTool('mission_update', { id: 1 }, as(ana.id))).isError).toBe(true);
    expect(await runTool('mission_update', { id: 1, stop: true }, as(ana.id))).toEqual({ content: 'Mission #1 arrêtée.', isError: false });
    expect(store.getMission(ana.id, 1)).toMatchObject({ status: 'stopped', endReason: 'person' });
    expect((await runTool('mission_update', { id: 1, note: 'trop tard' }, as(ana.id))).isError).toBe(true);
  });

  it('dans un groupe, la mission est celle du groupe', async () => {
    const { store, ana, as } = setup();
    const group = makeGroup(store, ana);

    expect((await runTool('mission_start', START, as(group.id))).isError).toBe(false);

    expect(store.listActiveMissions(group.id)).toHaveLength(1);
    expect(store.listActiveMissions(ana.id)).toHaveLength(0);
  });
});

describe('missions — données', () => {
  it('isole les missions de chaque compte, groupes compris', () => {
    const { store, ana, bob } = setup();
    const group = makeGroup(store, ana);
    const mine = addMission(store, ana);
    addMission(store, group, { title: 'Météo Andasibe' });

    expect(store.getMission(bob.id, mine.id)).toBeNull();
    expect(store.listMissions(bob.id)).toEqual([]);
    expect(store.claimMissionRun(bob.id, mine.id, NOW, NOW + HOUR)).toBe(false);
    expect(store.endMission(bob.id, mine.id, { status: 'stopped', reason: 'person' }, NOW)).toBe(false);
    expect(store.addMissionInstruction(bob.id, mine.id, 'x', 100, NOW)).toBe(false);
    expect(store.getMission(group.id, mine.id)).toBeNull();
    expect(store.listMissions(ana.id).map((m) => m.title)).toEqual(['Vol Tana → Paris']);
    expect(store.listMissions(group.id).map((m) => m.title)).toEqual(['Météo Andasibe']);
  });

  it('réserve un passage une seule fois, garde les notes et compte les échecs de suite', () => {
    const { store, ana } = setup();
    const m = addMission(store, ana);
    addMission(store, ana, { nextRunAt: NOW + HOUR });

    expect(store.dueMissions(NOW).map((d) => d.id)).toEqual([m.id]);
    expect(store.claimMissionRun(ana.id, m.id, NOW, NOW + 6 * HOUR)).toBe(true);
    expect(store.claimMissionRun(ana.id, m.id, NOW, NOW + 6 * HOUR)).toBe(false);
    expect(store.dueMissions(NOW)).toEqual([]);

    store.recordMissionRun(ana.id, m.id, { costUsd: 0.01, notes: 'Prix vu : 640 €', failed: false }, NOW);
    store.recordMissionRun(ana.id, m.id, { costUsd: 0, notes: null, failed: true }, NOW);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ runs: 2, failures: 1, notes: 'Prix vu : 640 €', costUsd: 0.01, lastRunAt: NOW });
    store.recordMissionRun(ana.id, m.id, { costUsd: 0.02, notes: 'Prix vu : 610 €', failed: false }, NOW);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ runs: 3, failures: 0, notes: 'Prix vu : 610 €' });
    expect(store.getMission(ana.id, m.id)!.costUsd).toBeCloseTo(0.03);
  });

  it('garde les consignes les plus récentes, termine une seule fois et propose sa conclusion une seule fois', () => {
    const { store, ana } = setup();
    const m = addMission(store, ana);
    for (const line of ['première consigne', 'deuxième consigne', 'troisième consigne']) store.addMissionInstruction(ana.id, m.id, line, 40, NOW);
    expect(store.getMission(ana.id, m.id)!.instructions).toBe('deuxième consigne\ntroisième consigne');

    expect(store.endMission(ana.id, m.id, { status: 'done', reason: 'goal', conclusion: '  Vol à 585 € le 20 oct.  ' }, NOW)).toBe(true);
    expect(store.endMission(ana.id, m.id, { status: 'stopped', reason: 'person' }, NOW)).toBe(false);
    expect(store.getMission(ana.id, m.id)).toMatchObject({ status: 'done', endReason: 'goal', conclusion: 'Vol à 585 € le 20 oct.', conclusionState: 'proposed', endedAt: NOW });
    expect(store.decideMissionConclusion(ana.id, m.id, 'kept', NOW)).toBe(true);
    expect(store.decideMissionConclusion(ana.id, m.id, 'declined', NOW)).toBe(false);
    expect(store.getMission(ana.id, m.id)?.conclusionState).toBe('kept');
  });

  it('exporte les missions avec leurs notes ; /oublier_tout et la suppression du compte les effacent', () => {
    const { store, ana, bob } = setup();
    const m = addMission(store, ana);
    store.recordMissionRun(ana.id, m.id, { costUsd: 0.004, notes: 'Prix vu : 640 €', failed: false }, NOW);
    store.addMissionInstruction(ana.id, m.id, '[mer. 14 oct. 2026, 19:00] Air Madagascar de préférence', 3_000, NOW);
    addMission(store, bob, { title: 'Mission de Bob' });

    const data = buildExport(store, store.getUserById(ana.id)!, NOW);

    expect(data.missions).toEqual([
      expect.objectContaining({
        id: m.id,
        titre: 'Vol Tana → Paris',
        condition_de_fin: 'prix sous 600 €',
        rythme: 'toutes les 6 h',
        statut: 'active',
        passages: 1,
        cout_usd: 0.004,
        plafond_usd: 0.25,
        notes: 'Prix vu : 640 €',
        consignes: '[mer. 14 oct. 2026, 19:00] Air Madagascar de préférence',
        conclusion: null,
      }),
    ]);
    expect(JSON.stringify(data)).not.toContain('Mission de Bob');

    store.wipeUserData(ana.id);
    expect(store.listMissions(ana.id)).toEqual([]);
    expect(store.listMissions(bob.id)).toHaveLength(1);
    store.deleteUser(bob.id);
    expect(store.dueMissions(NOW + 365 * 24 * HOUR)).toEqual([]);
  });
});

describe('missions — ce que voit le modèle', () => {
  it('<missions> dans le contexte de l’agent : déterministe, sans coût ni notes ; absent si les missions sont coupées', () => {
    const { store, ana } = setup();
    const m = addMission(store, ana, { deadlineAt: parseLocalDateTime('2026-12-03T09:00', TZ) });
    store.recordMissionRun(ana.id, m.id, { costUsd: 0.01, notes: 'Notes de travail secrètes', failed: false }, NOW);
    const user = store.getUserById(ana.id)!;
    const features = { speech: false, news: false, missions: true };

    const context = renderUserContext(user, [], [], null, features, [], store.listActiveMissions(ana.id));

    expect(context).toContain("<missions>\n- #1 · « Vol Tana → Paris » · toutes les 6 h · jusqu'au jeudi 3 décembre 2026 à 09:00\n</missions>");
    expect(context).not.toContain('Notes de travail');
    // Un autre passage (coût, notes) ne change pas le contexte : le cache reste valide.
    store.recordMissionRun(ana.id, m.id, { costUsd: 0.02, notes: 'Autres notes', failed: false }, NOW);
    expect(renderUserContext(user, [], [], null, features, [], store.listActiveMissions(ana.id))).toBe(context);
    expect(renderUserContext(user, [], [], null, features, [], [])).toContain('<missions>\n(aucune)\n</missions>');
    expect(renderUserContext(user, [], [], null, { speech: false, news: false }, [], store.listActiveMissions(ana.id))).not.toContain('<missions>');
    expect(renderGroupContext(makeGroup(store, ana), [], [], features, [], [])).toContain('<missions>\n(aucune)\n</missions>');
  });

  it('un passage ne voit que sa mission, ses consignes, ses notes et un profil minimal : jamais la mémoire', () => {
    const { store, ana } = setup();
    store.updateUserSettings(ana.id, { displayName: 'Nana', place: { name: 'Antananarivo, Madagascar', latitude: -18.91, longitude: 47.53 } });
    store.addMemory(ana.id, { kind: 'about', content: 'Ana prépare le concours de l’ENAM', importance: 3 }, NOW);
    const m = addMission(store, ana);
    store.addMissionInstruction(ana.id, m.id, '[mer. 14 oct. 2026, 19:10] Air Madagascar de préférence', 3_000, NOW);
    store.recordMissionRun(ana.id, m.id, { costUsd: 0.012, notes: 'Prix vu le 14 oct. : 640 €', failed: false }, NOW);
    const mission = store.getMission(ana.id, m.id)!;
    const account = store.getUserById(ana.id)!;

    const context = renderPassContext({ mission, account, at: NOW + 6 * HOUR, final: false, maxCostUsd: 0.05, connections: { gmail: true }, weather: true });

    expect(context).toMatch(/^\[jeu\. 15 oct\. 2026, 01:00\] Passage de la mission #1\./);
    for (const expected of [
      'Objectif : Surveiller le prix du vol Tana → Paris du 4 décembre.',
      'Condition de fin : prix sous 600 €',
      'Rythme : toutes les 6 h',
      'Passage : n° 2',
      'Budget : 0,012 $ dépensés sur 0,25 $ ; 0,05 $ au plus pour ce passage',
      '<consignes>\n- [mer. 14 oct. 2026, 19:10] Air Madagascar de préférence\n</consignes>',
      '<notes>\nPrix vu le 14 oct. : 640 €\n</notes>',
      'Nom : Nana',
      'Lieu : Antananarivo, Madagascar',
      'Connexions : Google Agenda (non connecté) · Gmail (connecté)',
    ]) {
      expect(context).toContain(expected);
    }
    expect(context).not.toContain('ENAM');
    expect(context).not.toContain('DERNIER PASSAGE');
    expect(renderPassContext({ mission, account, at: NOW, final: true, maxCostUsd: 0.05, connections: null, weather: false })).toContain('DERNIER PASSAGE');

    const group = makeGroup(store, ana);
    const groupMission = addMission(store, group, { title: 'Météo Andasibe' });
    const inGroup = renderPassContext({ mission: groupMission, account: group, at: NOW, final: false, maxCostUsd: 0.05, connections: { gmail: true }, weather: false });
    expect(inGroup).toContain('Groupe Telegram : Sortie Andasibe');
    expect(inGroup).toContain("Gmail, l'agenda et le navigateur n'y sont pas disponibles");
    expect(inGroup).toContain('(vides : premier passage)');
    for (const leak of ['Nana', 'ENAM', 'Connexions']) expect(inGroup).not.toContain(leak);
  });

  it('prompt et outils des passages : figés, identiques pour toutes les missions, selon la configuration', () => {
    const full: PassFeatures = { webTools: true, news: true, weather: true, browser: true, integrations: [] };
    const bare: PassFeatures = { webTools: false, news: false, weather: false, browser: false, integrations: [] };

    expect(buildPassTools(full)).toEqual(buildPassTools({ ...full }));
    expect(toolNames(buildPassTools(full))).toEqual(['news', 'crypto_price', 'weather', 'browse_web', 'finish', 'web_search', 'web_fetch']);
    expect(toolNames(buildPassTools(bare))).toEqual(['finish']);
    const prompt = passSystemPrompt(full);
    expect(prompt).toContain('Tu es le module de missions de Koto');
    expect(prompt).toContain('`browse_web` en dernier recours');
    expect(passSystemPrompt(bare)).not.toContain('browse_web');
    expect(passSystemPrompt(bare)).not.toContain('web_search');
  });

  it('l’agent principal n’annonce les missions (section, outils) que si elles sont activées', () => {
    const on = systemPrompt({ integrations: true, browser: true, missions: true });
    expect(on).toContain('# Missions');
    expect(on).toContain('<listes> et <missions>');
    expect(on).toContain('Une mission lancée ici appartient au groupe');
    expect(systemPrompt({ integrations: false })).not.toContain('# Missions');

    const tools = toolNames(buildTools(true, [], false, { speech: false, news: false, missions: SETTINGS }));
    expect(tools).toEqual(expect.arrayContaining(['mission_start', 'mission_update']));
    expect(toolNames(buildTools(true, [], false, { speech: false, news: false }))).not.toContain('mission_start');
  });
});

describe('missions — petites briques', () => {
  it('dit le rythme et les montants à la française', () => {
    expect([30, 60, 90, 360, 1_440, 2_880].map(rhythmLabel)).toEqual([
      'toutes les 30 min',
      'toutes les heures',
      'toutes les 1 h 30',
      'toutes les 6 h',
      'tous les jours',
      'tous les 2 jours',
    ]);
    expect([0, 0.0004, 0.0042, 0.012, 0.03, 0.25, 2].map(formatUsd)).toEqual(['0,00 $', '< 0,001 $', '0,004 $', '0,012 $', '0,03 $', '0,25 $', '2,00 $']);
    expect(renderMissionsContext([], TZ)).toBe('(aucune)');
  });

  it('reconnaît les cryptos citées par leur nom ou leur identifiant CoinGecko', () => {
    expect(coinIds('bitcoin, RLC, le cours de l’ETH, pepe, ???, BTC')).toEqual({ ids: ['bitcoin', 'iexec-rlc', 'ethereum', 'pepe'], rejected: ['???'] });
  });

  it('donne des cours frais (cache de 10 min) sans toucher au cache du brief', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('coingecko')
        ? new Response(JSON.stringify({ bitcoin: { usd: 81811, usd_24h_change: -1.7 } }))
        : new Response('indisponible', { status: 503 }),
    );
    const news = createNewsService({ log: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch });
    const coingecko = () => fetchImpl.mock.calls.filter(([url]) => String(url).includes('coingecko')).length;

    expect(await news.quotes!(['bitcoin'], NOW)).toEqual([{ id: 'bitcoin', usd: 81811, change24h: -1.7 }]);
    await news.quotes!(['bitcoin'], NOW + 9 * 60_000);
    expect(coingecko()).toBe(1);
    await news.quotes!(['bitcoin'], NOW + 11 * 60_000);
    expect(coingecko()).toBe(2);
    // Le brief garde son propre cache de 2 h.
    await news.digest('Bitcoin', NOW);
    await news.digest('Bitcoin', NOW + HOUR);
    expect(coingecko()).toBe(3);
  });
});
