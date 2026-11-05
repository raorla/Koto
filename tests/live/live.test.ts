// Tests réels, sur les vrais services, avec les clés de .env : `npm run test:live`.
// Désactivés par défaut (KOTO_LIVE=1 pour les lancer). Coût d'un passage : environ 0,01 $
// (quatre tours de Haiku, deux passages de mission, un ménage de la mémoire, une transcription ; voix,
// flux RSS, cours CoinGecko, météo et Telegram sont gratuits).
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src/agent/agent.js';
import { readConfig } from '../../src/config.js';
import { createLlmClient } from '../../src/llm.js';
import { MemoryKeeper } from '../../src/memory/consolidate.js';
import { MissionRunner } from '../../src/missions/runner.js';
import { createNewsService } from '../../src/news.js';
import { createOpenRouterSynthesizer, fetchSpeechCatalog, mp3Duration, setupSynthesizer } from '../../src/speech.js';
import { localDay } from '../../src/time.js';
import { KeyedLock, silentLogger } from '../../src/util.js';
import { createOpenRouterTranscriber } from '../../src/voice.js';
import { createWeatherService } from '../../src/weather.js';
import { makeStore, makeUser } from '../helpers.js';
import { toTelegramVoice } from '../support/ogg-opus.js';
import { makePdf } from '../support/pdf.js';

const LIVE = process.env.KOTO_LIVE === '1';
if (LIVE) process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
const config = LIVE ? readConfig() : null;
const userAgent = () => 'Koto/0.4 (tests réels; +https://t.me/kotosi_bot)';

describe.skipIf(!LIVE)('services réels', () => {
  it('Telegram : le token du bot est valide (getMe, gratuit)', async () => {
    const response = await fetch(`https://api.telegram.org/bot${config!.telegramToken}/getMe`);
    const body = (await response.json()) as { ok: boolean; result?: { is_bot: boolean } };
    expect(body).toMatchObject({ ok: true, result: { is_bot: true } });
  });

  it('modèle : Haiku via OpenRouter comprend la demande et appelle le bon outil (~0,002 $)', async () => {
    const store = makeStore();
    const user = makeUser(store);
    const llm = createLlmClient(config!);
    const agent = createAgent({
      create: (params) => llm.beta.messages.create(params),
      store,
      provider: config!.provider,
      model: config!.model,
      effort: config!.effort,
      webTools: false,
      log: silentLogger,
    });

    const result = await agent({ userId: user.id, kind: 'chat', text: 'Ajoute du lait et des œufs à ma liste de courses, merci' });

    expect(result.status).toBe('ok');
    expect(store.listItems(user.id, 'courses').map((i) => i.text.toLowerCase()).join(' ')).toMatch(/lait.*œufs|œufs.*lait/);
    expect(result.usage.costUsd).toBeLessThan(0.02);
  }, 60_000);

  it('missions : un vrai passage se tait quand rien ne bouge et prévient quand le seuil est franchi (~0,004 $)', async () => {
    const store = makeStore();
    const user = makeUser(store);
    const llm = createLlmClient(config!);
    const sent: string[] = [];
    const runner = new MissionRunner({
      store,
      // Sources gratuites seulement : pas de recherche web payante dans ce test.
      config: { ...config!, webTools: false },
      create: (params) => llm.beta.messages.create(params),
      notifier: { send: async (_account, text) => void sent.push(text), confirm: async () => {}, proposeConclusion: async () => {} },
      locks: new KeyedLock(),
      log: silentLogger,
      news: createNewsService({ log: silentLogger }),
    });
    const now = Date.now();
    const base = { intervalMinutes: 360, deadlineAt: now + 7 * 86_400_000, maxCostUsd: 0.25, nextRunAt: now };
    const quiet = store.addMission(
      user.id,
      { ...base, title: 'Bitcoin sous 1 000 $', goal: 'Surveiller le cours du Bitcoin et prévenir la personne s’il passe sous 1 000 $.', doneWhen: 'le Bitcoin passe sous 1 000 $' },
      now,
    );
    const alert = store.addMission(
      user.id,
      { ...base, title: 'Bitcoin au-dessus de 1 000 $', goal: 'Prévenir la personne dès que le cours du Bitcoin est au-dessus de 1 000 $.', doneWhen: 'le Bitcoin est au-dessus de 1 000 $' },
      now,
    );

    expect(runner.dispatch(now)).toBe(2);
    await runner.idle();

    expect(store.getMission(user.id, quiet.id)).toMatchObject({ status: 'active', runs: 1, failures: 0 });
    expect(store.getMission(user.id, quiet.id)!.notes).toMatch(/\d/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`Mission #${alert.id}`);
    const spent = store.getUsage(user.id, localDay(now, user.timezone));
    expect(spent.webSearches).toBe(0);
    expect(spent.costUsd).toBeGreaterThan(0);
    expect(spent.costUsd).toBeLessThan(0.02);
  }, 120_000);

  it('mémoire longue : la fiche d’un vrai PDF, puis une vraie recherche dans le passé (~0,002 $)', async () => {
    const store = makeStore();
    const user = makeUser(store);
    const llm = createLlmClient(config!);
    const agent = createAgent({
      create: (params) => llm.beta.messages.create(params),
      store,
      provider: config!.provider,
      model: config!.model,
      effort: config!.effort,
      webTools: false,
      log: silentLogger,
    });
    const pdf = makePdf(['FACTURE JIRAMA - Electricite', 'Periode : septembre 2026', 'Montant a payer : 84 500 Ar', 'Date limite de paiement : 20 octobre 2026']);

    const read = await agent({
      userId: user.id,
      kind: 'chat',
      text: "C'est quoi ce document ?",
      historyText: "[fichier : facture.pdf] C'est quoi ce document ?",
      attachments: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') }, title: 'facture.pdf' }],
      document: { kind: 'pdf', name: 'facture.pdf', fileId: null },
    });
    expect(read.status).toBe('ok');
    expect(read.text).not.toContain('fiche>');
    const [doc] = store.listDocuments(user.id);
    expect(doc!.summary).toMatch(/jirama/i);
    expect(doc!.summary).toMatch(/84[\s.,]?500/);

    // Le document sort de la fenêtre envoyée au modèle : seul search_history peut le retrouver.
    const last = store.addMessage(user.id, 'assistant', 'Bonne soirée !', 'chat', Date.now());
    store.setHistoryStart(user.id, last);
    const found = await agent({ userId: user.id, kind: 'chat', text: 'Tu te souviens du montant de la facture Jirama que je t’ai envoyée ?' });
    expect(found.status).toBe('ok');
    expect(found.text).toMatch(/84[\s.,]?500/);
    expect(found.usage.requests).toBeGreaterThanOrEqual(2);
    console.log(`[coût] lecture du PDF avec sa fiche : ${read.usage.costUsd.toFixed(5)} $ ; tour avec search_history : ${found.usage.costUsd.toFixed(5)} $ (${found.usage.requests} requêtes)`);
    expect(read.usage.costUsd + found.usage.costUsd).toBeLessThan(0.02);
  }, 120_000);

  it('mémoire longue : un vrai PDF rouvert avec open_document quand la fiche ne suffit pas (~0,001 $)', async () => {
    const store = makeStore();
    const user = makeUser(store);
    const llm = createLlmClient(config!);
    const bail = makePdf([
      'CONTRAT DE BAIL - T2 rue Ratsimilaho, Antananarivo',
      'Clause 1 : loyer mensuel de 600 000 Ar',
      'Clause 4 : preavis de depart de trois mois, par lettre recommandee',
      'Clause 5 : depot de garantie de deux mois de loyer',
    ]);
    const fetched: string[] = [];
    const agent = createAgent({
      create: (params) => llm.beta.messages.create(params),
      store,
      provider: config!.provider,
      model: config!.model,
      effort: config!.effort,
      webTools: false,
      // Le faux Telegram : le fichier du bail, tel qu'il y est resté.
      fetchFile: async (fileId) => {
        fetched.push(fileId);
        return bail;
      },
      log: silentLogger,
    });
    // Le bail est arrivé il y a un mois ; sa fiche ne dit rien du préavis.
    const at = Date.now() - 30 * 86_400_000;
    const fiche = 'Bail du T2 rue Ratsimilaho à Antananarivo, loyer de 600 000 Ar.';
    const said = store.addMessage(user.id, 'user', `[fichier : bail.pdf]\n[fiche du document : ${fiche}]`, 'chat', at);
    store.addDocument(user.id, { messageId: said, kind: 'pdf', name: 'bail.pdf', summary: fiche, fileId: 'live-bail' }, at);
    store.setHistoryStart(user.id, store.addMessage(user.id, 'assistant', 'Bonne soirée !', 'chat', Date.now() - 86_400_000));

    const result = await agent({ userId: user.id, kind: 'chat', text: 'Relis-moi la clause 4 de mon bail, que dit-elle exactement ?' });

    expect(result.status).toBe('ok');
    expect(fetched).toEqual(['live-bail']);
    expect(result.text).toMatch(/trois mois|3 mois/i);
    console.log(`[coût] relecture du bail avec open_document : ${result.usage.costUsd.toFixed(5)} $ (${result.usage.requests} requêtes)`);
    expect(result.usage.costUsd).toBeLessThan(0.02);
  }, 120_000);

  it('mémoire longue : un vrai ménage fusionne les doublons et archive le périmé, sans rien perdre (~0,001 $)', async () => {
    const store = makeStore();
    const user = makeUser(store);
    const llm = createLlmClient(config!);
    const now = Date.now();
    const day = 86_400_000;
    const facts: [string, 'about' | 'project' | 'priority' | 'goal' | 'person' | 'preference' | 'note', number, number][] = [
      ['Développeur à Antananarivo', 'about', 3, 60],
      ['Projet Koto : agent IA personnel sur Telegram', 'project', 2, 30],
      ['Koto est un bot Telegram écrit en TypeScript', 'project', 1, 20],
      ['Koto tourne avec Claude Haiku via OpenRouter', 'project', 1, 10],
      ['Priorité : lancer Koto v1 avant fin octobre 2026', 'priority', 3, 15],
      ['Préfère les réponses courtes', 'preference', 2, 40],
      ['Aime quand les réponses sont brèves', 'preference', 1, 5],
      ['Rado est son associé', 'person', 2, 40],
      ['Rado, son associé, s’occupe des devis', 'person', 1, 8],
      ['Anniversaire de sa mère le 3 mars', 'person', 2, 50],
      ['Rendez-vous chez le dentiste le 2 octobre 2026 à 10 h', 'note', 2, 25],
      ['Doit acheter du pain demain', 'note', 1, 20],
    ];
    for (const [content, kind, importance, age] of facts) store.addMemory(user.id, { kind, content, importance }, now - age * day);
    const sent: string[] = [];
    const keeper = new MemoryKeeper({
      store,
      config: config!,
      create: (params) => llm.beta.messages.create(params),
      notifier: { send: async (_account, text) => void sent.push(text) },
      locks: new KeyedLock(),
      log: silentLogger,
    });

    const { status, report } = await keeper.consolidate(user, now);

    expect(status).toBe('done');
    expect(report!.merged.length + report!.archived.length).toBeGreaterThan(0);
    const active = store.listMemories(user.id).map((m) => m.content).join('\n');
    expect(active).toContain('Antananarivo');
    expect(active).toMatch(/anniversaire/i);
    expect(store.listMemories(user.id).length).toBeLessThan(facts.length);
    // Rien n'est perdu : actifs et archives couvrent au moins tous les souvenirs de départ.
    expect(store.listMemories(user.id).length + store.listArchivedMemories(user.id).length).toBeGreaterThanOrEqual(facts.length);
    expect(sent).toHaveLength(1);
    const spent = store.getUsage(user.id, localDay(now, user.timezone));
    console.log(
      `[coût] ménage de ${facts.length} souvenirs avec ${config!.memoryModel} : ${spent.costUsd.toFixed(5)} $ (${report!.merged.length} fusions, ${report!.updated.length} mises à jour, ${report!.archived.length} archives)`,
    );
    expect(spent.costUsd).toBeGreaterThan(0);
    expect(spent.costUsd).toBeLessThan(0.01);
  }, 120_000);

  it('voix : la voix gratuite et Kokoro existent toujours et parlent français (0 $ et ~0,00003 $)', async () => {
    const { synthesizer, voices } = await setupSynthesizer({
      apiKey: config!.openrouterApiKey,
      primary: { model: config!.speechModel, voice: config!.speechVoice },
      fallback: config!.speechFallbackModel ? { model: config!.speechFallbackModel, voice: config!.speechFallbackVoice } : null,
      log: silentLogger,
    });
    expect(voices).toHaveLength(config!.speechFallbackModel ? 2 : 1);
    const speech = await synthesizer.synthesize('Bonjour, je suis Koto.');
    expect(speech.seconds).toBeGreaterThanOrEqual(1);

    const kokoro = (await fetchSpeechCatalog()).find((m) => m.id === config!.speechFallbackModel)!;
    const fallback = createOpenRouterSynthesizer({ apiKey: config!.openrouterApiKey, model: kokoro.id, voice: config!.speechFallbackVoice, pricing: kokoro });
    expect(mp3Duration((await fallback.synthesize('Petit rappel : boire de l’eau.')).audio)).toBeGreaterThan(1);
  }, 60_000);

  it('vocaux reçus : un vrai vocal Telegram (OGG/Opus) est bien transcrit (~0,0002 $)', async () => {
    const { synthesizer } = await setupSynthesizer({
      apiKey: config!.openrouterApiKey,
      primary: { model: config!.speechModel, voice: config!.speechVoice },
      fallback: config!.speechFallbackModel ? { model: config!.speechFallbackModel, voice: config!.speechFallbackVoice } : null,
      log: silentLogger,
    });
    const mp3 = (await synthesizer.synthesize('Rappelle-moi de payer la facture d’électricité demain matin.')).audio;
    const browser = await chromium.launch({ headless: true, ...(config!.browserChannel ? { channel: config!.browserChannel } : {}) });
    const ogg = await toTelegramVoice(browser, mp3).finally(() => browser.close());
    expect(ogg.subarray(0, 4).toString('latin1')).toBe('OggS');

    const heard = await createOpenRouterTranscriber(config!.openrouterApiKey, config!.transcribeModel).transcribe(ogg, 'ogg');
    expect(heard.text.toLowerCase()).toMatch(/rappelle-moi.*factur/);
  }, 90_000);

  it('veille : flux RSS crypto et cours CoinGecko joignables (gratuit)', async () => {
    const digest = await createNewsService({ log: silentLogger }).digest('crypto (Bitcoin, RLC)', Date.now());
    expect(digest.text).toMatch(/Cours \(CoinGecko\) : Bitcoin .* \$/);
    expect(digest.text.split('\n').filter((line) => line.startsWith('- ')).length).toBeGreaterThan(0);
  }, 30_000);

  it('météo : MET Norway et OpenStreetMap répondent (gratuit)', async () => {
    const weather = createWeatherService({ userAgent, log: silentLogger });
    const tana = await weather.geocode('Antananarivo');
    expect(tana?.name).toContain('Madagascar');
    const days = await weather.forecast(tana!, 2, 'Indian/Antananarivo', Date.now());
    expect(days.length).toBe(2);
    expect(days[1]!.max).toBeGreaterThan(days[1]!.min - 1);
  }, 30_000);
});
