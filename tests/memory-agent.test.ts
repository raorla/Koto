// Mémoire longue (niveau integration) : la vraie boucle de l'agent avec un document joint (fiche), les outils
// search_history et open_document, le bot Telegram qui lui transmet photos et PDF, et /memoire avec les archives.
import { describe, expect, it } from 'vitest';
import { createAgent, type CreateParams } from '../src/agent/agent.js';
import { FICHE_HINT, FileGone, type FileFetcher } from '../src/memory/documents.js';
import { NOW, makeConfig, makeGroup, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';
import { setupBot, textUpdate } from './support/bot.js';
import type { Update } from 'grammy/types';

const DAY = 86_400_000;

function agentFor(responses: Parameters<typeof scriptedCreate>[0], fetchFile?: FileFetcher) {
  const store = makeStore();
  const { create, calls } = scriptedCreate(responses);
  const agent = createAgent({ create, store, model: 'claude-haiku-5-5', effort: 'low', webTools: false, fetchFile, now: () => NOW });
  return { store, agent, calls };
}

/** Faux Telegram pour open_document : sert les fichiers connus, refuse les autres (file_id expiré) et note les téléchargements. */
function telegramFiles(files: Record<string, Buffer>) {
  const fetched: string[] = [];
  const fetch: FileFetcher = async (fileId) => {
    fetched.push(fileId);
    const file = files[fileId];
    if (!file) throw new FileGone();
    return file;
  };
  return { fetch, fetched };
}

/** Contenu des tool_result du dernier message de la requête. */
function toolResults(params: CreateParams) {
  const last = params.messages.at(-1)!;
  return (Array.isArray(last.content) ? last.content : []).filter((b) => b.type === 'tool_result');
}

const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'facture.pdf' } as const;

describe('documents reçus : la fiche', () => {
  it('retire la fiche de la réponse, l’ajoute à l’historique et range le document, sans requête de plus', async () => {
    const { store, agent, calls } = agentFor([
      message([text('C’est ta facture d’électricité : 84 500 Ar à payer avant le 20.\n\n<fiche>Facture Jirama de septembre 2026, 84 500 Ar, échéance le 20 octobre.</fiche>')], 'end_turn'),
    ]);
    const ana = makeUser(store);

    const result = await agent({
      userId: ana.id,
      kind: 'chat',
      text: 'Tu peux m’expliquer ?',
      historyText: '[fichier : facture.pdf] Tu peux m’expliquer ?',
      attachments: [pdf],
      document: { kind: 'pdf', name: 'facture.pdf', fileId: 'file-9' },
    });

    expect(calls).toHaveLength(1);
    expect(result.text).toBe('C’est ta facture d’électricité : 84 500 Ar à payer avant le 20.');
    // Le rappel de la fiche part avec le document, pas dans l'historique.
    expect(JSON.stringify(calls[0]!.messages.at(-1))).toContain(FICHE_HINT.slice(0, 20));
    const [said, answer] = store.listMessagesAfter(ana.id, 0);
    expect(said!.content).toBe('[fichier : facture.pdf] Tu peux m’expliquer ?\n[fiche du document : Facture Jirama de septembre 2026, 84 500 Ar, échéance le 20 octobre.]');
    expect(answer!.content).not.toContain('fiche');
    expect(store.listDocuments(ana.id)).toEqual([
      expect.objectContaining({ kind: 'pdf', name: 'facture.pdf', fileId: 'file-9', messageId: said!.id, summary: 'Facture Jirama de septembre 2026, 84 500 Ar, échéance le 20 octobre.' }),
    ]);
  });

  it('garde le document même sans fiche, et ne montre jamais une fiche égarée', async () => {
    const { store, agent } = agentFor([message([text('Jolie photo !')], 'end_turn'), message([text('Oui. <fiche>rien</fiche>')], 'end_turn')]);
    const ana = makeUser(store);
    await agent({ userId: ana.id, kind: 'chat', text: '(photo)', historyText: '[photo]', attachments: [], document: { kind: 'photo', name: 'photo', fileId: null } });
    const second = await agent({ userId: ana.id, kind: 'chat', text: 'Merci' });

    expect(store.listDocuments(ana.id)).toEqual([expect.objectContaining({ kind: 'photo', summary: null })]);
    expect(store.listMessagesAfter(ana.id, 0)[0]!.content).toBe('[photo]');
    expect(second.text).toBe('Oui.');
    expect(store.listDocuments(ana.id)).toHaveLength(1);
  });
});

describe('search_history dans la boucle de l’agent', () => {
  it('retrouve un échange sorti de la fenêtre, en ajout seul, et ne rapporte rien d’un autre compte', async () => {
    const { store, agent, calls } = agentFor([
      message([toolUse('s1', 'search_history', { query: 'devis toiture Rado' })], 'tool_use'),
      message([text('Le 4 septembre, Rado avait chiffré la toiture à 1,2 million d’ariary.')], 'end_turn'),
    ]);
    const ana = makeUser(store);
    const bob = makeUser(store);
    store.addMessage(ana.id, 'user', 'Rado propose un devis de 1,2 million pour la toiture', 'chat', NOW - 40 * DAY);
    store.addMessage(ana.id, 'assistant', 'Je note le devis de Rado.', 'chat', NOW - 40 * DAY + 1_000);
    store.addMessage(bob.id, 'user', 'Le devis de Rado pour ma toiture à moi est de 3 millions', 'chat', NOW - 2 * DAY);
    // La fenêtre envoyée au modèle ne commence qu'après ces messages.
    const last = store.addMessage(ana.id, 'assistant', 'Bonne soirée !', 'chat', NOW - DAY);
    store.setHistoryStart(ana.id, last);

    const result = await agent({ userId: ana.id, kind: 'chat', text: 'Tu te souviens du devis de Rado pour la toiture ?' });

    expect(result.text).toContain('1,2 million');
    expect(JSON.stringify(calls[0]!.messages)).not.toContain('1,2 million');
    const [first, second] = calls;
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    const found = JSON.stringify(second!.messages.at(-1));
    expect(found).toContain('Rado propose un devis de 1,2 million pour la toiture');
    expect(found).toContain('Je note le devis de Rado.');
    expect(found).not.toContain('3 millions');
    expect((first!.tools as { name: string }[]).map((t) => t.name)).toContain('search_history');
  });

  it('en groupe, ne cherche que dans l’historique du groupe', async () => {
    const { store, agent, calls } = agentFor([
      message([toolUse('s1', 'search_history', { query: 'tente' })], 'tool_use'),
      message([text('Ana apporte la tente.')], 'end_turn'),
    ]);
    const ana = makeUser(store);
    const group = makeGroup(store, ana);
    store.addMessage(ana.id, 'user', 'Ma tente perso est trouée', 'chat', NOW - 5 * DAY);
    store.addMessage(group.id, 'user', 'Ana : j’apporte la tente pour Andasibe', 'chat', NOW - 5 * DAY);

    await agent({ userId: group.id, kind: 'chat', text: 'Bob : qui apporte la tente ?' });

    const found = JSON.stringify(calls[1]!.messages.at(-1));
    expect(found).toContain('j’apporte la tente pour Andasibe');
    expect(found).not.toContain('trouée');
  });
});

describe('open_document dans la boucle de l’agent', () => {
  const BAIL = Buffer.from('%PDF-1.4 Bail - Clause 4 : preavis de trois mois');

  it('retrouve puis rouvre un vieux PDF : le fichier ne part que dans le tool_result, en ajout seul, et son coût est compté', async () => {
    const telegram = telegramFiles({ 'f-bail': BAIL });
    const { store, agent, calls } = agentFor(
      [
        message([toolUse('s1', 'search_history', { query: 'bail', documents: true })], 'tool_use'),
        // Le modèle prend l'id que search_history vient de lui donner.
        (params) => {
          const found = JSON.stringify(toolResults(params));
          return message([toolUse('o1', 'open_document', { id: Number(/document #(\d+)/.exec(found)![1]) })], 'tool_use');
        },
        message([text('La clause 4 prévoit un préavis de trois mois.')], 'end_turn'),
      ],
      telegram.fetch,
    );
    const ana = makeUser(store);
    const said = store.addMessage(ana.id, 'user', '[fichier : bail.pdf]\n[fiche du document : Bail du T2, signé en septembre 2026]', 'chat', NOW - 40 * DAY);
    store.addDocument(ana.id, { messageId: said, kind: 'pdf', name: 'bail.pdf', summary: 'Bail du T2, signé en septembre 2026', fileId: 'f-bail' }, NOW - 40 * DAY);
    store.setHistoryStart(ana.id, store.addMessage(ana.id, 'assistant', 'Bonne soirée !', 'chat', NOW - DAY));

    const result = await agent({ userId: ana.id, kind: 'chat', text: 'Relis-moi la clause 4 du bail que je t’ai envoyé en septembre' });

    expect(result).toMatchObject({ status: 'ok', text: 'La clause 4 prévoit un préavis de trois mois.' });
    expect(telegram.fetched).toEqual(['f-bail']);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.messages.slice(0, calls[1]!.messages.length)).toEqual(calls[1]!.messages);
    const [opened] = toolResults(calls[2]!);
    expect(opened).toMatchObject({
      content: [
        { type: 'text', text: expect.stringContaining('Document #1 rouvert : PDF « bail.pdf »') },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: BAIL.toString('base64') }, title: 'bail.pdf' },
      ],
    });
    expect(opened).not.toHaveProperty('is_error');
    // Mêmes outils qu'à la requête précédente : rien ne change pendant le tour.
    expect(calls[2]!.tools).toEqual(calls[0]!.tools);
    // Jamais dans l'historique, ni dans les requêtes du tour suivant.
    const history = JSON.stringify(store.listMessagesAfter(ana.id, 0));
    expect(history).not.toContain(BAIL.toString('base64'));
    expect(history).toContain('préavis de trois mois');
    expect(store.getUsage(ana.id, '2026-10-14')).toMatchObject({ requests: 3 });
  });

  it('en groupe, rouvre les documents du groupe, jamais ceux d’un membre', async () => {
    const telegram = telegramFiles({ 'f-perso': BAIL, 'f-groupe': BAIL });
    const { store, agent, calls } = agentFor(
      [
        message([toolUse('o1', 'open_document', { id: 1 })], 'tool_use'),
        message([toolUse('o2', 'open_document', { id: 2 })], 'tool_use'),
        message([text('Le programme dit départ à 6 h.')], 'end_turn'),
      ],
      telegram.fetch,
    );
    const ana = makeUser(store);
    const group = makeGroup(store, ana);
    store.addDocument(ana.id, { messageId: null, kind: 'pdf', name: 'bail.pdf', summary: null, fileId: 'f-perso' }, NOW - DAY);
    store.addDocument(group.id, { messageId: null, kind: 'pdf', name: 'programme.pdf', summary: null, fileId: 'f-groupe' }, NOW - DAY);

    await agent({ userId: group.id, kind: 'chat', text: 'Bob : relis le programme' });

    expect(toolResults(calls[1]!)).toEqual([expect.objectContaining({ is_error: true, content: expect.stringContaining('Aucun document #1 ici') })]);
    expect(toolResults(calls[2]!)[0]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('PDF « programme.pdf »') }, { type: 'document' }] });
    expect(telegram.fetched).toEqual(['f-groupe']);
  });

  it('un file_id expiré chez Telegram : le tour continue, avec une réponse claire', async () => {
    const telegram = telegramFiles({});
    const { store, agent, calls } = agentFor(
      [message([toolUse('o1', 'open_document', { id: 1 })], 'tool_use'), message([text('Telegram ne me le donne plus : tu peux me le renvoyer ?')], 'end_turn')],
      telegram.fetch,
    );
    const ana = makeUser(store);
    store.addDocument(ana.id, { messageId: null, kind: 'pdf', name: 'bail.pdf', summary: 'Bail du T2', fileId: 'f-ancien' }, NOW - 400 * DAY);

    const result = await agent({ userId: ana.id, kind: 'chat', text: 'Relis-moi mon bail' });

    expect(result.status).toBe('ok');
    expect(telegram.fetched).toEqual(['f-ancien']);
    const [gone] = toolResults(calls[1]!);
    expect(gone).toMatchObject({ is_error: true, content: expect.stringContaining('propose-lui de te le renvoyer') });
    expect(String(gone!.content)).toContain('Sa fiche dit : « Bail du T2 »');
  });

  it('un seul document par tour, et sans téléchargeur (CLI) rien n’est tenté', async () => {
    const telegram = telegramFiles({ 'f-1': BAIL, 'f-2': BAIL });
    const { store, agent, calls } = agentFor(
      [
        message([toolUse('o1', 'open_document', { id: 1 }), toolUse('o2', 'open_document', { id: 2 })], 'tool_use'),
        message([text('Voici le premier.')], 'end_turn'),
      ],
      telegram.fetch,
    );
    const ana = makeUser(store);
    store.addDocument(ana.id, { messageId: null, kind: 'pdf', name: 'bail.pdf', summary: null, fileId: 'f-1' }, NOW - DAY);
    store.addDocument(ana.id, { messageId: null, kind: 'pdf', name: 'avenant.pdf', summary: null, fileId: 'f-2' }, NOW - DAY);

    await agent({ userId: ana.id, kind: 'chat', text: 'Relis le bail et l’avenant' });

    // Les deux résultats partent dans un seul message ; le second est refusé sans téléchargement.
    const [first, second] = toolResults(calls[1]!);
    expect(first).not.toHaveProperty('is_error');
    expect(second).toMatchObject({ is_error: true, content: expect.stringContaining('Un seul document rouvert par tour') });
    expect(telegram.fetched).toEqual(['f-1']);

    const cli = agentFor([message([toolUse('o1', 'open_document', { id: 1 })], 'tool_use'), message([text('Je ne peux pas le rouvrir ici.')], 'end_turn')]);
    const bob = makeUser(cli.store);
    cli.store.addDocument(bob.id, { messageId: null, kind: 'pdf', name: 'bail.pdf', summary: null, fileId: 'f-1' }, NOW - DAY);
    await cli.agent({ userId: bob.id, kind: 'chat', text: 'Relis mon bail' });
    expect(toolResults(cli.calls[1]!)[0]).toMatchObject({ is_error: true, content: expect.stringContaining("n'est pas possible ici") });
  });
});

let updateId = 50_000;

function photoUpdate(fromId: number, caption?: string): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Ana' },
      from: { id: fromId, is_bot: false, first_name: 'Ana', language_code: 'fr' },
      photo: [
        { file_id: 'petite', file_unique_id: 'p1', width: 90, height: 90 },
        { file_id: 'grande', file_unique_id: 'p2', width: 1280, height: 960 },
      ],
      ...(caption ? { caption } : {}),
    },
  } as Update;
}

function pdfUpdate(fromId: number, name: string): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Ana' },
      from: { id: fromId, is_bot: false, first_name: 'Ana', language_code: 'fr' },
      document: { file_id: 'doc-7', file_unique_id: 'd7', file_name: name, mime_type: 'application/pdf', file_size: 2_000 },
    },
  } as Update;
}

describe('bot Telegram — documents et mémoire', () => {
  it('transmet photos et PDF à l’agent avec de quoi les ranger', async () => {
    const { bot, requests } = setupBot(makeConfig({ registrationMode: 'open' }), { downloadFile: async () => Buffer.from('%PDF-1.7') });
    await bot.handleUpdate(textUpdate(6100, '/start'));

    await bot.handleUpdate(photoUpdate(6100, 'mon reçu'));
    await bot.handleUpdate(pdfUpdate(6100, 'bail.pdf'));

    expect(requests.at(-2)).toMatchObject({ historyText: '[photo] mon reçu', document: { kind: 'photo', name: 'photo', fileId: 'grande' } });
    expect(requests.at(-1)).toMatchObject({ historyText: '[fichier : bail.pdf]', document: { kind: 'pdf', name: 'bail.pdf', fileId: 'doc-7' } });
  });

  it('/memoire montre aussi les souvenirs archivés, et comment les reprendre', async () => {
    const { bot, store, sent } = setupBot(makeConfig({ registrationMode: 'open' }));
    await bot.handleUpdate(textUpdate(6101, '/start'));
    const ana = store.getUserByTelegramId(6101)!;
    store.addMemory(ana.id, { kind: 'project', content: 'Lancer Koto', importance: 3 }, NOW);
    const old = store.addMemory(ana.id, { kind: 'note', content: 'Examen du permis le 3 octobre', importance: 2 }, NOW - 30 * DAY);
    store.archiveMemory(ana.id, old.id, old.updatedAt, { reason: 'passé', mergedInto: null }, NOW);

    await bot.handleUpdate(textUpdate(6101, '/memoire'));

    expect(sent().at(-1)).toContain('Lancer Koto');
    expect(sent().at(-1)).toContain('🗄️ Archivés');
    expect(sent().at(-1)).toContain(`[${old.id}] Examen du permis le 3 octobre <i>(passé)</i>`);
    expect(sent().at(-1)).toContain('remets le 12');
  });
});
