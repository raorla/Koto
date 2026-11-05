// Mémoire longue (niveau unit) : index plein texte de l'historique, search_history, fiches des documents,
// archives de la mémoire et règles du ménage. Base SQLite réelle (en mémoire ou dans un fichier temporaire).
import Database from 'better-sqlite3';
import { GrammyError, type Api } from 'grammy';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cheapestModel, estimateUsd } from '../src/agent/pricing.js';
import { renderUserContext } from '../src/agent/prompt.js';
import { buildTools, executeTool, runTool, type TurnToolContext } from '../src/agent/tools.js';
import { telegramDownloader } from '../src/bot/bot.js';
import { readConfig } from '../src/config.js';
import { MIGRATIONS, openDatabase } from '../src/db.js';
import { buildExport } from '../src/export.js';
import { applyConsolidation, consolidationText, planConsolidation, renderConsolidationContext, MEMORY_RULES } from '../src/memory/consolidate.js';
import { FileGone, FileTooLarge, extractFiche, withFiche, type FileFetcher } from '../src/memory/documents.js';
import { ftsQuery, searchPast } from '../src/memory/search.js';
import { Store, type DocumentKind, type Memory, type User } from '../src/store.js';
import { NOW, makeGroup, makeStore, makeUser } from './helpers.js';

const DAY = 86_400_000;
const as = (store: Store, userId: number) => ({ store, userId, now: NOW });

function say(store: Store, user: User, role: 'user' | 'assistant', content: string, at: number): number {
  return store.addMessage(user.id, role, content, 'chat', at);
}

describe('migration v8', () => {
  it('indexe les messages déjà en base et suit les suivants', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'koto-v8-')), 'koto.db');
    const old = new Database(path);
    for (const [i, sql] of MIGRATIONS.slice(0, 7).entries()) {
      old.exec(sql);
      old.pragma(`user_version = ${i + 1}`);
    }
    old
      .prepare(`INSERT INTO users (telegram_id, chat_id, timezone, brief_time, created_at) VALUES (1, 1, 'Indian/Antananarivo', '07:30', ?)`)
      .run(NOW - 90 * DAY);
    old.prepare(`INSERT INTO messages (user_id, role, content, kind, created_at) VALUES (1, 'user', ?, 'chat', ?)`).run('Le devis de Rado pour la toiture : 1,2 million', NOW - 60 * DAY);
    old.close();

    const store = new Store(openDatabase(path));
    expect(store.db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const user = store.getUserById(1)!;
    expect(store.searchHistory(user.id, { match: ftsQuery('devis toiture', 'all')!, from: null, to: null, documentsOnly: false, limit: 5 })).toHaveLength(1);

    say(store, user, 'user', 'Rado a envoyé la facture de la toiture', NOW);
    const hits = store.searchHistory(user.id, { match: ftsQuery('toiture', 'all')!, from: null, to: null, documentsOnly: false, limit: 5 });
    expect(hits.map((h) => h.message.content)).toEqual(['Rado a envoyé la facture de la toiture', 'Le devis de Rado pour la toiture : 1,2 million']);
    store.db.close();
  });

  it('retire de l’index les messages effacés, y compris par la suppression d’un compte', () => {
    const store = makeStore();
    const ana = makeUser(store);
    say(store, ana, 'user', 'Mon code de vélo zorglub', NOW);
    const count = () => (store.db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH '"zorglub"'`).get() as { n: number }).n;
    expect(count()).toBe(1);
    store.deleteUser(ana.id);
    expect(count()).toBe(0);
    store.db.exec(`INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')`);
  });
});

describe('ftsQuery', () => {
  it('ne garde que des mots-clés entre guillemets, avec un préfixe pour les mots', () => {
    expect(ftsQuery('Tu te souviens du devis de Rado ?', 'all')).toBe('"devis"* "rado"*');
    expect(ftsQuery('facture 2026 Jirama', 'any')).toBe('"facture"* OR "2026" OR "jirama"*');
  });

  it('neutralise la syntaxe FTS5 et refuse une requête vide de sens', () => {
    const query = ftsQuery('NEAR(a b) OR "x" -y * AND col:valeur', 'all')!;
    expect(query).toBe('"near"* "col"* "valeur"*');
    expect(ftsQuery('le la de du ?', 'all')).toBeNull();
    expect(ftsQuery('"""', 'all')).toBeNull();
  });
});

describe('search_history', () => {
  it('retrouve un vieil échange, daté, avec la réponse de Koto, malgré les accents et le pluriel', () => {
    const store = makeStore();
    const ana = makeUser(store);
    say(store, ana, 'user', 'Réunion avec les fournisseurs de vanille mardi à Sambava', NOW - 40 * DAY);
    say(store, ana, 'assistant', 'Noté, je te rappelle de préparer les échantillons.', NOW - 40 * DAY + 5_000);
    say(store, ana, 'user', 'Il fait beau', NOW - DAY);

    const result = executeTool('search_history', { query: 'reunion fournisseur' }, as(store, ana.id));

    expect(result.isError).toBe(false);
    expect(result.content).toContain('1 extrait');
    expect(result.content).toContain('[ven. 4 sept. 2026, 19:00] Elle : Réunion avec les fournisseurs de vanille');
    expect(result.content).toContain('↳ Koto : Noté, je te rappelle');
    expect(result.content).not.toContain('Il fait beau');
  });

  it('ne voit jamais l’historique d’un autre compte, personne ou groupe', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const bob = makeUser(store);
    const group = makeGroup(store, ana);
    say(store, ana, 'user', 'Le code du portail est caché sous le pot', NOW);
    store.addMessage(group.id, 'user', 'Bob : le portail de la maison d’Andasibe', 'chat', NOW);

    expect(executeTool('search_history', { query: 'portail' }, as(store, bob.id)).content).toContain('Rien trouvé');
    const inGroup = executeTool('search_history', { query: 'portail' }, as(store, group.id)).content;
    expect(inGroup).toContain('Bob : le portail');
    expect(inGroup).not.toContain('pot');
    expect(executeTool('search_history', { query: 'portail' }, as(store, ana.id)).content).not.toContain('Andasibe');
  });

  it('élargit à l’un des mots quand tous ne sont pas trouvés ensemble', () => {
    const store = makeStore();
    const ana = makeUser(store);
    say(store, ana, 'user', 'Le garagiste demande 300 000 Ar pour les freins', NOW - 3 * DAY);
    const result = executeTool('search_history', { query: 'freins voiture devis' }, as(store, ana.id));
    expect(result.content).toContain('300 000 Ar pour les freins');
  });

  it('filtre par période (jours locaux) et liste les documents reçus', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const old = say(store, ana, 'user', '[fichier : facture.pdf]\n[fiche du document : Facture Jirama de septembre, 84 500 Ar]', NOW - 30 * DAY);
    const doc = store.addDocument(ana.id, { messageId: old, kind: 'pdf', name: 'facture.pdf', summary: 'Facture Jirama de septembre, 84 500 Ar', fileId: 'f1' }, NOW - 30 * DAY);
    say(store, ana, 'user', 'La facture du plombier arrive demain', NOW - DAY);

    const docs = executeTool('search_history', { documents: true }, as(store, ana.id)).content;
    // L'id du document accompagne sa fiche : open_document le rouvre avec.
    expect(docs).toContain(`document #${doc.id} : PDF « facture.pdf » — Facture Jirama de septembre, 84 500 Ar`);
    const onlyDocs = executeTool('search_history', { query: 'facture', documents: true }, as(store, ana.id)).content;
    expect(onlyDocs).toContain(`(document #${doc.id} reçu : PDF « facture.pdf »)`);
    expect(onlyDocs).not.toContain('plombier');
    const recent = executeTool('search_history', { query: 'facture', from: '2026-10-10' }, as(store, ana.id)).content;
    expect(recent).toContain('plombier');
    expect(recent).not.toContain('Jirama');
    expect(executeTool('search_history', { query: 'facture', to: '2026-09-20' }, as(store, ana.id)).content).toContain('Jirama');
    expect(executeTool('search_history', { query: 'facture', from: '15/09' }, as(store, ana.id)).isError).toBe(true);
  });

  it('en groupe, rend le prénom de qui parlait même dans un extrait coupé', () => {
    const store = makeStore();
    const group = makeGroup(store, null);
    store.addMessage(group.id, 'user', `Ana : ${'bla '.repeat(150)}et surtout la tente orange pour samedi ${'bla '.repeat(60)}`, 'chat', NOW);
    const result = searchPast(store, group, { query: 'tente orange', documents: false });
    expect(result.content).toMatch(/\] Ana : ….*tente orange/);
  });

  it('fait partie des outils de tout le monde, comme le reste', () => {
    const names = buildTools(false).map((t) => (t as { name: string }).name);
    expect(names.slice(0, 6)).toEqual(['remember', 'update_memory', 'forget', 'search_history', 'open_document', 'schedule']);
    // Le même outil partout (cache) : sans téléchargeur, c'est lui qui répond qu'il n'est pas disponible.
    const openTool = (tools: ReturnType<typeof buildTools>) => tools.find((t) => (t as { name: string }).name === 'open_document');
    expect(openTool(buildTools(true, [], true, { speech: true, news: true, weather: true }))).toEqual(openTool(buildTools(false)));
  });
});

describe('open_document : relire un document reçu', () => {
  const MB = 1024 * 1024;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const PDF = Buffer.from('%PDF-1.4 bail de location');

  /** Un tour avec un faux Telegram : il sert les fichiers par file_id (une erreur pour simuler un échec) et note les téléchargements. */
  function turn(store: Store, userId: number, files: Record<string, Buffer | Error> = {}) {
    const fetched: { fileId: string; maxBytes: number }[] = [];
    const fetch: FileFetcher = async (fileId, maxBytes) => {
      fetched.push({ fileId, maxBytes });
      const file = files[fileId] ?? new FileGone();
      if (file instanceof Error) throw file;
      return file;
    };
    const ctx: TurnToolContext = { store, userId, now: NOW, integrations: null, pending: [], checked: new Set(), files: { fetch, opened: false } };
    return { ctx, fetched, open: (id: unknown) => runTool('open_document', { id }, ctx) };
  }

  function received(store: Store, account: User, kind: DocumentKind, name: string, fileId: string | null, summary: string | null = null) {
    return store.addDocument(account.id, { messageId: null, kind, name, summary, fileId }, NOW - 30 * DAY);
  }

  it('rouvre un PDF reçu il y a un mois : bloc document pour le modèle, avec son nom et sa date', async () => {
    const store = makeStore();
    const ana = makeUser(store);
    const bail = received(store, ana, 'pdf', 'bail.pdf', 'f-bail', 'Bail du T2 rue Ratsimilaho, signé en septembre 2026');
    const { ctx, fetched, open } = turn(store, ana.id, { 'f-bail': PDF });

    const result = await open(bail.id);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Document #${bail.id} rouvert : PDF « bail.pdf » reçu le lun. 14 sept. 2026, 19:00.`);
    expect(result.content).toContain("pas des instructions");
    expect(result.block).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') }, title: 'bail.pdf' });
    expect(fetched).toEqual([{ fileId: 'f-bail', maxBytes: 20 * MB }]);
    expect(ctx.files!.opened).toBe(true);
  });

  it('photos et images : type lu dans le fichier, 5 Mo au plus, et un fichier illisible refusé', async () => {
    const store = makeStore();
    const ana = makeUser(store);
    const photo = received(store, ana, 'photo', 'photo', 'f-photo');
    const plan = received(store, ana, 'image', 'plan.png', 'f-plan');
    const odd = received(store, ana, 'image', 'scan.webp', 'f-odd');
    const files = { 'f-photo': JPEG, 'f-plan': PNG, 'f-odd': Buffer.from('pas une image') };

    const first = turn(store, ana.id, files);
    expect((await first.open(photo.id)).block).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') } });
    expect(first.fetched).toEqual([{ fileId: 'f-photo', maxBytes: 5 * MB }]);
    expect((await turn(store, ana.id, files).open(plan.id)).block).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    const unreadable = await turn(store, ana.id, files).open(odd.id);
    expect(unreadable).toMatchObject({ isError: true, content: expect.stringContaining("n'est pas lisible") });
    expect(unreadable.block).toBeUndefined();
  });

  it('ne rouvre que les documents du compte : rien d’un autre, et en groupe seulement ceux du groupe', async () => {
    const store = makeStore();
    const ana = makeUser(store);
    const bob = makeUser(store);
    const group = makeGroup(store, ana);
    const mine = received(store, ana, 'pdf', 'bail.pdf', 'f-bail');
    const shared = received(store, group, 'pdf', 'programme.pdf', 'f-programme');
    const files = { 'f-bail': PDF, 'f-programme': PDF };

    const asBob = turn(store, bob.id, files);
    expect(await asBob.open(mine.id)).toMatchObject({ isError: true, content: expect.stringContaining(`Aucun document #${mine.id} ici`) });
    expect(asBob.fetched).toEqual([]);
    const inGroup = turn(store, group.id, files);
    expect((await inGroup.open(mine.id)).isError).toBe(true);
    expect((await inGroup.open(shared.id)).isError).toBe(false);
    expect(inGroup.fetched.map((f) => f.fileId)).toEqual(['f-programme']);
    // Même la personne rattachée ne lit pas en privé un document du groupe.
    const asAna = turn(store, ana.id, files);
    expect((await asAna.open(shared.id)).isError).toBe(true);
    expect(asAna.fetched).toEqual([]);
  });

  it('fichier expiré, trop lourd ou injoignable : une réponse claire avec la fiche, sans compter dans la limite du tour', async () => {
    const store = makeStore();
    const ana = makeUser(store);
    const fiche = 'Bail du T2 rue Ratsimilaho, signé en septembre 2026';
    const gone = received(store, ana, 'pdf', 'bail.pdf', 'f-expire', fiche);
    const heavy = received(store, ana, 'pdf', 'annexes.pdf', 'f-lourd');
    const offline = received(store, ana, 'photo', 'photo', 'f-reseau');
    const kept = received(store, ana, 'photo', 'photo', null, 'Reçu Shoprite, 12 000 Ar');
    const { ctx, open } = turn(store, ana.id, { 'f-lourd': new FileTooLarge(), 'f-reseau': new Error('fetch failed') });

    const expired = await open(gone.id);
    expect(expired.isError).toBe(true);
    expect(expired.content).toContain('Telegram ne donne plus le fichier');
    expect(expired.content).toContain('propose-lui de te le renvoyer');
    expect(expired.content).toContain(`Sa fiche dit : « ${fiche} »`);
    expect((await open(heavy.id)).content).toContain('trop lourd');
    expect((await open(offline.id)).content).toContain('réessaie plus tard');
    expect((await open(kept.id)).content).toContain("n'a pas été gardé : seule sa fiche reste. Sa fiche dit : « Reçu Shoprite, 12 000 Ar »");
    expect(ctx.files!.opened).toBe(false);
  });

  it('un seul document par tour, une entrée invalide refusée, et rien sans téléchargeur (CLI)', async () => {
    const store = makeStore();
    const ana = makeUser(store);
    const bail = received(store, ana, 'pdf', 'bail.pdf', 'f-bail');
    const quittance = received(store, ana, 'pdf', 'quittance.pdf', 'f-quittance');
    const { fetched, open } = turn(store, ana.id, { 'f-bail': PDF, 'f-quittance': PDF });

    expect((await open('trois')).isError).toBe(true);
    expect((await open(bail.id)).isError).toBe(false);
    expect(await open(quittance.id)).toMatchObject({ isError: true, content: expect.stringContaining('Un seul document rouvert par tour') });
    expect(fetched).toHaveLength(1);

    const cli: TurnToolContext = { store, userId: ana.id, now: NOW, integrations: null, pending: [], checked: new Set() };
    expect(await runTool('open_document', { id: bail.id }, cli)).toMatchObject({ isError: true, content: expect.stringContaining("n'est pas possible ici") });
  });

  it('Telegram : un identifiant refusé devient FileGone, un fichier trop gros FileTooLarge', async () => {
    const refusing = (description: string) =>
      ({
        getFile: async () => {
          throw new GrammyError('refusé', { ok: false, error_code: 400, description }, 'getFile', {});
        },
      }) as unknown as Api;
    const download = telegramDownloader('token', 'https://telegram.invalid');
    await expect(download(refusing('Bad Request: wrong file_id or the file is temporarily unavailable'), 'x', MB)).rejects.toBeInstanceOf(FileGone);
    await expect(download(refusing('Bad Request: invalid file_id'), 'x', MB)).rejects.toBeInstanceOf(FileGone);
    await expect(download(refusing('Bad Request: file is too big'), 'x', MB)).rejects.toBeInstanceOf(FileTooLarge);
    const announced = { getFile: async () => ({ file_id: 'x', file_unique_id: 'u', file_size: 2 * MB, file_path: 'documents/x.pdf' }) } as unknown as Api;
    await expect(download(announced, 'x', MB)).rejects.toBeInstanceOf(FileTooLarge);
  });
});

describe('fiches des documents', () => {
  it('retire la fiche du message et la garde à part', () => {
    expect(extractFiche('Voici ce que dit ta facture.\n\n<fiche>Facture  Jirama\nde septembre</fiche>')).toEqual({
      text: 'Voici ce que dit ta facture.',
      fiche: 'Facture Jirama de septembre',
    });
    expect(extractFiche('Rien à dire.')).toEqual({ text: 'Rien à dire.', fiche: null });
    // Coupée par la limite de tokens, ou en double : jamais montrée.
    expect(extractFiche('Réponse <fiche>Contrat de bail')).toEqual({ text: 'Réponse', fiche: 'Contrat de bail' });
    expect(extractFiche('<fiche>A</fiche> Ok <FICHE>B</FICHE>').fiche).toBe('A');
    expect(extractFiche(`<fiche>${'x'.repeat(900)}</fiche>`).fiche).toHaveLength(401);
  });

  it('ajoute la fiche au message de l’historique', () => {
    expect(withFiche('[photo] mon reçu', 'Reçu Shoprite, 12 000 Ar')).toBe('[photo] mon reçu\n[fiche du document : Reçu Shoprite, 12 000 Ar]');
    expect(withFiche('[photo]', null)).toBe('[photo]');
  });
});

describe('archives de la mémoire', () => {
  function withMemories(store: Store, user: User, items: [string, number][]): Memory[] {
    return items.map(([content, importance]) => store.addMemory(user.id, { kind: 'note', content, importance }, NOW - 10 * DAY));
  }

  it('sort les souvenirs archivés du prompt, les garde et les restaure', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const [exam, koto] = withMemories(store, ana, [
      ['Examen du permis le 3 octobre 2026', 2],
      ['Projet Koto en cours', 3],
    ]);
    expect(store.archiveMemory(ana.id, exam!.id, exam!.updatedAt, { reason: 'passé', mergedInto: null }, NOW)).toBe(true);

    expect(store.listMemories(ana.id).map((m) => m.id)).toEqual([koto!.id]);
    expect(store.countMemories(ana.id)).toBe(1);
    expect(renderUserContext(ana, store.listMemories(ana.id), [])).not.toContain('permis');
    expect(store.listArchivedMemories(ana.id)).toEqual([expect.objectContaining({ id: exam!.id, archiveReason: 'passé' })]);

    // Archivé : update_memory refuse sans restore, puis le remet.
    expect(executeTool('update_memory', { id: exam!.id, content: 'x' }, as(store, ana.id)).isError).toBe(true);
    expect(executeTool('update_memory', { id: exam!.id, restore: true }, as(store, ana.id)).content).toBe(`Souvenir [${exam!.id}] restauré.`);
    expect(store.listMemories(ana.id)).toHaveLength(2);
    // Personne d'autre ne peut restaurer ou oublier ses souvenirs.
    const bob = makeUser(store);
    expect(executeTool('update_memory', { id: koto!.id, restore: true }, as(store, bob.id)).isError).toBe(true);
    expect(executeTool('forget', { id: koto!.id }, as(store, bob.id)).isError).toBe(true);
  });

  it('/oublier_tout efface archives, documents et index ; l’export les contient', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const [old] = withMemories(store, ana, [['Ancien numéro de bureau 12', 1]]);
    store.archiveMemory(ana.id, old!.id, old!.updatedAt, { reason: 'remplacé', mergedInto: null }, NOW);
    const m = say(store, ana, 'user', '[photo]\n[fiche du document : Reçu de la pharmacie]', NOW);
    store.addDocument(ana.id, { messageId: m, kind: 'photo', name: 'photo', summary: 'Reçu de la pharmacie', fileId: 'p1' }, NOW);

    const data = buildExport(store, ana, NOW) as Record<string, unknown[]>;
    expect(data.memoire_archivee).toEqual([expect.objectContaining({ contenu: 'Ancien numéro de bureau 12', raison: 'remplacé' })]);
    expect(data.documents).toEqual([expect.objectContaining({ type: 'photo', fiche: 'Reçu de la pharmacie' })]);

    store.wipeUserData(ana.id);
    expect(store.listArchivedMemories(ana.id)).toEqual([]);
    expect(store.listDocuments(ana.id)).toEqual([]);
    expect(executeTool('search_history', { query: 'pharmacie' }, as(store, ana.id)).content).toContain('Rien trouvé');
  });
});

describe('ménage de la mémoire : garde-fous', () => {
  function memories(store: Store, user: User, items: [string, number][]): Memory[] {
    return items.map(([content, importance]) => store.addMemory(user.id, { kind: 'project', content, importance }, NOW - 20 * DAY));
  }

  it('refuse ids inconnus, doublons, secrets et archives d’un souvenir ★★★', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const [a, b, c, d] = memories(store, ana, [
      ['Projet Koto : bot Telegram', 2],
      ['Koto est un bot Telegram', 1],
      ['Projet central', 3],
      ['Détail périmé', 1],
    ]);
    const plan = planConsolidation([a!, b!, c!, d!], {
      merges: [
        { ids: [b!.id, a!.id], content: 'Projet Koto : agent IA perso sur Telegram', importance: 1 },
        { ids: [a!.id, d!.id], content: 'doublon' },
        { ids: [999, d!.id], content: 'inconnu' },
      ],
      updates: [{ id: d!.id, content: 'Mon mot de passe Gmail est hunter2' }],
      archives: [{ id: c!.id, reason: 'fini' }, { id: d!.id, reason: 'passé' }, { id: 'x' }],
    });
    // Le plus petit id survit, avec l'importance la plus haute du groupe.
    expect(plan.merges).toEqual([expect.objectContaining({ keep: a, absorbed: [b], importance: 2, kind: 'project' })]);
    expect(plan.updates).toEqual([]);
    expect(plan.archives.map((x) => x.memory.id)).toEqual([d!.id]);
    expect(plan.rejected).toBe(5);
  });

  it('archive au plus 30 % de la mémoire, les détails d’abord', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const list = memories(
      store,
      ana,
      Array.from({ length: 10 }, (_, i) => [`Souvenir ${i}`, i < 5 ? 2 : 1] as [string, number]),
    );
    const plan = planConsolidation(list, { merges: [], updates: [], archives: list.map((m) => ({ id: m.id, reason: 'vieux' })) });
    expect(plan.archives).toHaveLength(3);
    expect(plan.archives.every((x) => x.memory.importance === 1)).toBe(true);
    expect(plan.rejected).toBe(7);
  });

  it('n’efface rien : versions et souvenirs fusionnés passent aux archives, avec un compte rendu', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const [a, b, c, d] = memories(store, ana, [
      ['Projet Koto : bot Telegram', 2],
      ['Koto tourne sur Haiku', 1],
      ['Rendez-vous chez le dentiste demain', 2],
      ['Ancienne adresse : Ivato', 1],
    ]);
    const before = (store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const plan = planConsolidation([a!, b!, c!, d!], {
      merges: [{ ids: [a!.id, b!.id], content: 'Projet Koto : bot Telegram, tourne sur Haiku' }],
      updates: [{ id: c!.id, content: 'Rendez-vous chez le dentiste le 5 octobre 2026' }],
      archives: [{ id: d!.id, reason: 'déménagé' }],
    });
    const report = applyConsolidation(store, ana.id, plan, NOW);

    expect(report).toMatchObject({ merged: [{ id: a!.id, absorbed: [b!.id] }], updated: [{ id: c!.id }], archived: [{ id: d!.id, reason: 'déménagé' }], skipped: 0 });
    expect(store.listMemories(ana.id).map((m) => m.content)).toEqual([
      'Projet Koto : bot Telegram, tourne sur Haiku',
      'Rendez-vous chez le dentiste le 5 octobre 2026',
    ]);
    const archived = store.listArchivedMemories(ana.id).map((m) => [m.content, m.archiveReason]);
    expect(archived).toEqual(
      expect.arrayContaining([
        ['Projet Koto : bot Telegram', `ancienne version de [${a!.id}], avant fusion`],
        ['Koto tourne sur Haiku', `fusionné dans [${a!.id}]`],
        ['Rendez-vous chez le dentiste demain', `ancienne version de [${c!.id}]`],
        ['Ancienne adresse : Ivato', 'déménagé'],
      ]),
    );
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(before + 2);

    const text = consolidationText(ana, report)!;
    expect(text).toContain(`fusionné [${a!.id}] + [${b!.id}] → [${a!.id}]`);
    expect(text).toContain(`archivé [${d!.id}] « Ancienne adresse : Ivato » (déménagé)`);
    expect(text).toContain('Rien n’est effacé'.replace('’', "'"));
    expect(consolidationText(ana, { merged: [], updated: [], archived: [], skipped: 2 })).toBeNull();
  });

  it('ne touche pas un souvenir modifié par la conversation pendant le ménage', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const [a, b] = memories(store, ana, [
      ['Priorité : finir le dossier de visa', 2],
      ['Détail', 1],
    ]);
    const plan = planConsolidation([a!, b!], { merges: [], updates: [{ id: a!.id, content: 'Priorité : visa (déposé)' }], archives: [{ id: b!.id, reason: 'inutile' }] });
    store.updateMemory(ana.id, a!.id, { content: 'Priorité : visa obtenu le 14 octobre' }, NOW + 1);
    store.deleteMemory(ana.id, b!.id);

    const report = applyConsolidation(store, ana.id, plan, NOW + 2);

    expect(report).toMatchObject({ updated: [], archived: [], skipped: 2 });
    expect(store.getMemory(ana.id, a!.id)!.content).toBe('Priorité : visa obtenu le 14 octobre');
  });

  it('présente la mémoire au modèle dans un ordre stable, datée, avec la consigne d’alléger au-delà du seuil', () => {
    const store = makeStore();
    const ana = makeUser(store);
    const list = memories(store, ana, [
      ['B', 1],
      ['A', 3],
    ]);
    const context = renderConsolidationContext(ana, [...list].reverse(), NOW, { ...MEMORY_RULES, countThreshold: 2 });
    expect(context).toContain(`[${list[0]!.id}] project ★ · créé le 24 sept. 2026 · B\n[${list[1]!.id}] project ★★★`);
    expect(context).toContain('Mémoire trop lourde');
    expect(context).toContain("Aujourd'hui : mercredi 14 octobre 2026");
  });
});

describe('ménage de la mémoire : quand', () => {
  const rules = { ...MEMORY_RULES, minMemories: 3, countThreshold: 5 };

  function fill(store: Store, user: User, n: number, at: number) {
    for (let i = 0; i < n; i++) store.addMemory(user.id, { kind: 'note', content: `Souvenir ${i}`, importance: 2 }, at);
  }

  it('au-delà du seuil (une fois par jour au plus), sinon une fois par semaine si la mémoire a changé', () => {
    const store = makeStore();
    const small = makeUser(store); // 2 souvenirs : rien à ranger
    const heavy = makeUser(store); // au-delà du seuil
    const steady = makeUser(store); // sous le seuil, inscrit depuis un jour
    fill(store, small, 2, NOW - DAY);
    fill(store, heavy, 6, NOW - DAY);
    fill(store, steady, 3, NOW - DAY);
    const due = (at: number) => store.accountsDueForMemoryCheck(at, rules).map((c) => c.userId);

    expect(due(NOW)).toEqual([heavy.id]);
    expect(store.claimMemoryCheck(heavy.id, NOW, null)).toBe(true);
    expect(store.claimMemoryCheck(heavy.id, NOW, null)).toBe(false); // déjà réservé
    store.finishMemoryCheck(heavy.id, NOW);
    // Rien de neuf depuis : pas de nouveau ménage, même plus tard.
    expect(due(NOW + 8 * DAY)).toEqual([steady.id]);
    // Un nouveau souvenir le lendemain : de nouveau dû.
    store.addMemory(heavy.id, { kind: 'note', content: 'Neuf', importance: 2 }, NOW + DAY + 1);
    expect(due(NOW + DAY + 2)).toEqual([heavy.id]);
  });
});

describe('modèle du ménage', () => {
  it('le moins cher par défaut, quel que soit le modèle de la conversation', () => {
    expect(cheapestModel()).toBe('claude-haiku-5-5');
    expect(estimateUsd('claude-haiku-5-5', 10_000, 2_000)).toBeCloseTo(0.002);
    expect(readConfig({ KOTO_MODEL: 'claude-opus-5-5' }).memoryModel).toBe('claude-haiku-5-5');
    expect(readConfig({ OPENROUTER_API_KEY: 'sk-or', KOTO_MODEL: 'anthropic/claude-opus-5.5' }).memoryModel).toBe('anthropic/claude-haiku-5.5');
    expect(readConfig({ KOTO_MEMORY_MODEL: 'claude-sonnet-5-5' }).memoryModel).toBe('claude-sonnet-5-5');
    expect(readConfig({ KOTO_MEMORY_CONSOLIDATION: 'off' }).memoryConsolidation).toBe(false);
  });
});
