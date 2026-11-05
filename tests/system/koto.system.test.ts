// Test système : le vrai Koto, lancé comme en production (npm run dev), parle à un faux Telegram et à
// un faux OpenRouter. On vérifie de bout en bout ce qu'une personne voit, ce qui est écrit en base et ce
// qui part vers les services : modèle, transcription, voix.
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInitData } from '../../src/call/auth.js';
import { makeWav } from '../support/wav.js';
import { FakeOpenRouter, FakeTelegram, startKoto, type RecordedCall, type RunningKoto, type ScriptedModel } from './support.js';

const ADMIN = 1000;
const STRANGER = 2000;
const BOB = 3000; // membre du groupe, jamais inscrit
const CLARA = 4000; // invitée par l'admin
const GROUP = -1001777000;
const GROUP_TITLE = 'Sortie Andasibe';
const TIMEOUT = 30_000;

let toolId = 1;
const say = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const toolUse = (name: string, input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', id: `toolu_${toolId++}`, name, input }],
  stop_reason: 'tool_use',
});

/** Texte d'un tool_result ; un document rouvert y apparaît comme [document application/pdf]. */
function resultText(block: Record<string, unknown>): string {
  if (!Array.isArray(block.content)) return String(block.content);
  return (block.content as Record<string, unknown>[])
    .map((part) => (part.type === 'text' ? String(part.text) : `[${String(part.type)} ${String((part.source as { media_type?: string }).media_type)}]`))
    .join(' ');
}

/** Un modèle prévisible : il appelle les outils de Koto selon le message, puis résume leur résultat. */
const model: ScriptedModel = (body) => {
  // Le ménage de la mémoire : fusionne les deux premiers souvenirs qu'il lit et archive le dernier.
  if (JSON.stringify(body.system ?? []).includes('module de mémoire de Koto')) {
    const ids = [...String(body.messages[0]!.content).matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    return toolUse('consolidate', {
      merges: [{ ids: [ids[0], ids[1]], content: 'Projet Koto : agent IA perso sur Telegram, en ligne depuis octobre 2026' }],
      updates: [],
      archives: [{ id: ids.at(-1), reason: 'passé' }],
    });
  }
  const last = body.messages.at(-1)!;
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  const results = blocks.filter((b) => b.type === 'tool_result');
  if (results.length > 0) return say(`C'est fait. ${results.map(resultText).join(' | ')}`);
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('\n');
  // Un PDF joint : la réponse, puis sa fiche (que Koto retire avant l'envoi).
  if (blocks.some((b) => b.type === 'document') && text.includes('Mon bail')) {
    return say("C'est ton bail, signé le 1er septembre.\n\n<fiche>Bail du T2 rue Ratsimilaho, signé le 1er septembre 2026, loyer 600 000 Ar.</fiche>");
  }
  if (blocks.some((b) => b.type === 'document')) {
    return say(
      "C'est le devis de Rado pour la toiture : 1,2 million d'ariary.\n\n<fiche>Devis de Rado pour la réfection de la toiture, 1 200 000 Ar, valable jusqu'au 30 novembre 2026.</fiche>",
    );
  }
  if (text.includes('Relis-moi le document')) return toolUse('open_document', { id: Number(/#(\d+)/.exec(text)![1]) });
  if (text.includes('Tu te souviens')) return toolUse('search_history', { query: text.includes('plombier') ? 'plombier fuite' : 'devis toiture Rado' });
  // Un passage de mission : le premier ne trouve rien de neuf (il se tait), le suivant prévient.
  if (text.includes('<mission>')) {
    return text.includes('(vides : premier passage)')
      ? toolUse('finish', { outcome: 'continue', notes: 'Prix vu : 640 € chez Air Madagascar.' })
      : toolUse('finish', {
          outcome: 'notify',
          notes: 'Prix vu : 580 € chez Air Madagascar. Signalé.',
          message: 'Le vol Tana → Paris du 4 décembre est passé à 580 € chez Air Madagascar.',
        });
  }
  // Les déclencheurs d'abord : la consigne du brief parle elle-même de « liste de courses ».
  if (text.includes('[BRIEF DU MATIN]')) return say('☀️ Bonjour ! Voici ton brief du jour.');
  if (text.includes('[RÉSUMÉ]')) return say('📝 Résumé : départ samedi à 6 h, charbon et brochettes sur la liste.');
  if (text.includes('liste de la sortie')) return toolUse('list_add', { list: 'sortie', items: ['charbon', 'brochettes'] });
  if (text.includes('liste de courses')) return toolUse('list_add', { list: 'courses', items: ['lait', 'pain'] });
  if (text.includes('Surveille le vol')) {
    const deadline = DateTime.now().setZone('Indian/Antananarivo').plus({ days: 30 }).toFormat("yyyy-LL-dd'T'HH:mm");
    return toolUse('mission_start', {
      title: 'Vol Tana → Paris du 4 déc.',
      goal: 'Surveiller le prix du vol Antananarivo → Paris du 4 décembre, en classe éco.',
      done_when: 'prix sous 600 €',
      every_hours: 6,
      deadline,
    });
  }
  if (text.includes('Rappelle-moi')) {
    const when = DateTime.now().setZone('Indian/Antananarivo').plus({ hours: 2 }).toFormat("yyyy-LL-dd'T'HH:mm");
    return toolUse('schedule', { kind: 'reminder', when, text: "Boire de l'eau" });
  }
  if (text.includes('Rappelez-nous')) {
    const when = DateTime.now().setZone('Indian/Antananarivo').plus({ days: 2 }).toFormat("yyyy-LL-dd'T'HH:mm");
    return toolUse('schedule', { kind: 'reminder', when, text: 'Départ pour Andasibe' });
  }
  return say(`Bien reçu : ${text.replace(/^\[[^\]]+\]\s*/, '')}`);
};

let telegram: FakeTelegram;
let openrouter: FakeOpenRouter;
let koto: RunningKoto;

const toAdmin = (call: RecordedCall) => Number(call.payload.chat_id) === ADMIN;
const messageTo = (chatId: number, needle: string) => (call: RecordedCall) =>
  call.method === 'sendMessage' && Number(call.payload.chat_id) === chatId && String(call.payload.text).includes(needle);
const buttons = (call: RecordedCall) =>
  ((call.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] }).inline_keyboard ?? []).flat();

function db() {
  const handle = new Database(koto.dbPath);
  handle.pragma('busy_timeout = 5000');
  return handle;
}

/** Lit une ligne de la base du Koto testé. */
function row<T>(sql: string, ...params: unknown[]): T {
  const handle = db();
  try {
    return handle.prepare(sql).get(...params) as T;
  } finally {
    handle.close();
  }
}

/** Attend qu'une condition sur la base soit vraie (le scheduler du Koto testé tourne toutes les 300 ms). */
async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition jamais remplie');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Un port libre pour le serveur d'appel du Koto testé. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

let callUrl = '';

beforeAll(async () => {
  callUrl = `http://127.0.0.1:${await freePort()}`;
  telegram = await FakeTelegram.start();
  openrouter = await FakeOpenRouter.start(model);
  koto = await startKoto({
    TELEGRAM_BOT_TOKEN: telegram.token,
    TELEGRAM_API_ROOT: telegram.url,
    OPENROUTER_API_KEY: 'sk-or-test-systeme',
    OPENROUTER_BASE_URL: openrouter.url,
    KOTO_MODEL: 'anthropic/claude-haiku-5.5',
    ADMIN_TELEGRAM_IDS: String(ADMIN),
    KOTO_BROWSER: 'off',
    KOTO_BACKUP_KEEP: '0',
    KOTO_SCHEDULER_INTERVAL_MS: '300',
    KOTO_PUBLIC_URL: callUrl,
    KOTO_CALL_PORT: new URL(callUrl).port,
  });
}, 60_000);

afterAll(async () => {
  await koto?.stop().catch(() => null);
  await telegram?.close();
  await openrouter?.close();
});

describe('Koto de bout en bout (vrai processus, faux Telegram, faux OpenRouter)', () => {
  it('démarre comme en production : webhook retiré, commandes publiées, voix prêtes', async () => {
    await telegram.waitFor((c) => c.method === 'deleteWebhook');
    const commands = await telegram.waitFor((c) => c.method === 'setMyCommands');
    expect((commands.payload.commands as { command: string }[]).map((c) => c.command)).toEqual(
      expect.arrayContaining(['memoire', 'rappels', 'listes', 'missions', 'brief', 'exporter']),
    );
    expect(openrouter.requests.some((r) => r.path === '/api/v1/models')).toBe(true);
    expect(koto.output()).toContain('réponses vocales prêtes');
  });

  it('refuse poliment un inconnu sans invitation, sans appeler le modèle', async () => {
    const before = openrouter.requests.length;
    telegram.sendText(STRANGER, 'salut');
    const reply = await telegram.waitFor(messageTo(STRANGER, 'sur invitation'));
    expect(String(reply.payload.text)).toContain(String(STRANGER));
    expect(openrouter.requests.slice(before).some((r) => r.path === '/api/v1/messages')).toBe(false);
  });

  it('accueille l’admin puis lui répond avec le modèle, outils et prompt figés compris', async () => {
    telegram.sendText(ADMIN, '/start');
    await telegram.waitFor(messageTo(ADMIN, 'Koto'));

    telegram.sendText(ADMIN, 'Salut, ça va ?');
    await telegram.waitFor(messageTo(ADMIN, 'Bien reçu : Salut, ça va ?'));

    const call = openrouter.requests.findLast((r) => r.path === '/api/v1/messages')!;
    expect(call.body.model).toBe('anthropic/claude-haiku-5.5');
    expect(call.body.session_id).toMatch(/^koto-user-\d+$/);
    const tools = (call.body.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['remember', 'schedule', 'list_add', 'list_update', 'weather', 'reply_by_voice', 'web_search']));
  }, TIMEOUT);

  it('tient la liste de courses et la fait cocher d’un geste dans Telegram', async () => {
    telegram.sendText(ADMIN, 'Ajoute du lait et du pain à ma liste de courses');
    await telegram.waitFor(messageTo(ADMIN, 'Ajouté à « courses »'));

    const since = telegram.calls.length;
    telegram.sendText(ADMIN, '/listes');
    const list = await telegram.waitFor((c) => c.method === 'sendMessage' && toAdmin(c) && c.payload.reply_markup !== undefined, { since });
    expect(buttons(list).map((b) => b.text)).toEqual(['⬜ lait', '⬜ pain']);

    const lait = buttons(list)[0]!;
    telegram.pressButton(ADMIN, lait.callback_data, (list.result as { message_id: number }).message_id);
    const edited = await telegram.waitFor((c) => c.method === 'editMessageText', { since });
    expect(buttons(edited).map((b) => b.text)).toEqual(['⬜ pain', '✅ lait']);

    const handle = db();
    const rows = handle.prepare('SELECT text, done FROM list_items ORDER BY id').all();
    handle.close();
    expect(rows).toEqual([
      { text: 'lait', done: 1 },
      { text: 'pain', done: 0 },
    ]);
  }, TIMEOUT);

  it('écoute un vocal, programme le rappel et répond aussi en vocal avec la voix gratuite', async () => {
    telegram.addFile('vocal-1', Buffer.from('OggS — faux vocal Telegram'));
    openrouter.transcript = "Rappelle-moi de boire de l'eau dans deux heures";
    const since = telegram.calls.length;

    telegram.sendVoice(ADMIN, 'vocal-1', 3);

    await telegram.waitFor(messageTo(ADMIN, "Programmé"), { since });
    const voice = await telegram.waitFor((c) => c.method === 'sendVoice' && toAdmin(c), { since });
    expect(voice.files.voice?.bytes.length).toBeGreaterThan(1_000);
    expect(Number(voice.payload.duration)).toBe(3);

    const transcription = openrouter.requests.findLast((r) => r.path === '/api/v1/chat/completions')!;
    expect(JSON.stringify(transcription.body)).toContain('"format":"ogg"');
    const speech = openrouter.requests.findLast((r) => r.path === '/api/v1/audio/speech')!;
    expect(speech.body).toMatchObject({ model: 'fish-audio/s2.1-pro-free:free', response_format: 'mp3' });

    const handle = db();
    const job = handle.prepare("SELECT kind, text, status FROM jobs WHERE kind = 'reminder'").get();
    const history = handle.prepare("SELECT content FROM messages WHERE content LIKE '[vocal]%'").get();
    handle.close();
    expect(job).toEqual({ kind: 'reminder', text: "Boire de l'eau", status: 'pending' });
    expect(history).toEqual({ content: "[vocal] Rappelle-moi de boire de l'eau dans deux heures" });
  }, TIMEOUT);

  it('envoie un rappel vocal à l’heure dite, sans appeler le modèle', async () => {
    const since = telegram.calls.length;
    const before = openrouter.requests.filter((r) => r.path === '/api/v1/messages').length;
    const handle = db();
    const admin = handle.prepare('SELECT id FROM users WHERE telegram_id = ?').get(ADMIN) as { id: number };
    handle
      .prepare("INSERT INTO jobs (user_id, kind, text, due_at, repeat, voice, created_at) VALUES (?, 'reminder', ?, ?, 'none', 1, ?)")
      .run(admin.id, 'Prendre tes médicaments', Date.now() - 1_000, Date.now() - 60_000);
    handle.close();

    await telegram.waitFor(messageTo(ADMIN, '⏰ Prendre tes médicaments'), { since });
    await telegram.waitFor((c) => c.method === 'sendVoice' && toAdmin(c), { since });
    expect(openrouter.requests.filter((r) => r.path === '/api/v1/messages')).toHaveLength(before);
  }, TIMEOUT);

  it('fait le brief à la demande', async () => {
    telegram.sendText(ADMIN, '/brief');
    await telegram.waitFor(messageTo(ADMIN, 'Voici ton brief du jour'));
    const call = openrouter.requests.findLast((r) => r.path === '/api/v1/messages')!;
    expect(JSON.stringify(call.body.messages)).toContain('[BRIEF DU MATIN]');
  }, TIMEOUT);

  it('dans un groupe, ne répond qu’à ce qui lui est adressé, au nom du groupe et aux frais de qui l’a ajouté', async () => {
    const since = telegram.calls.length;
    const modelCalls = () => openrouter.requests.filter((r) => r.path === '/api/v1/messages');
    const before = modelCalls().length;

    // L'admin ajoute Koto : présentation, et le groupe lui est rattaché.
    telegram.addBotToGroup(GROUP, GROUP_TITLE, ADMIN, 'Ana');
    const welcome = await telegram.waitFor(messageTo(GROUP, 'rattaché à Ana'), { since });
    expect(String(welcome.payload.text)).toContain('Ce groupe a sa propre mémoire');

    // Bob, qui n'est pas inscrit : un message qui ne s'adresse pas à Koto, puis une mention.
    telegram.sendGroupText(GROUP, GROUP_TITLE, BOB, 'Bob', 'On part à quelle heure samedi ?');
    telegram.sendGroupText(GROUP, GROUP_TITLE, BOB, 'Bob', '@koto_test_bot ajoute charbon et brochettes à la liste de la sortie');
    const added = await telegram.waitFor(messageTo(GROUP, 'Ajouté à « sortie »'), { since });
    expect(added.payload.reply_parameters).toMatchObject({ message_id: expect.any(Number) });

    const call = modelCalls()[before]!;
    expect(call.body.session_id).toMatch(/^koto-group-\d+$/);
    const context = (call.body.system as { text: string }[])[1]!.text;
    expect(context).toMatch(/^<groupe>\nGroupe Telegram : Sortie Andasibe/);
    // Rien de personnel à l'admin (sa liste de courses, son rappel) dans le contexte du groupe.
    for (const personal of ['<personne>', 'lait', "Boire de l'eau"]) expect(context).not.toContain(personal);
    const sent = JSON.stringify(call.body.messages);
    expect(sent).toContain('Bob : ajoute charbon et brochettes à la liste de la sortie');
    expect(sent).not.toContain('On part à quelle heure');

    // L'admin répond au message de Koto : rappel pour le groupe.
    telegram.sendGroupText(GROUP, GROUP_TITLE, ADMIN, 'Ana', 'Rappelez-nous le départ samedi à 6 h', { replyTo: added });
    await telegram.waitFor(messageTo(GROUP, 'Programmé'), { since });

    // Un rappel du groupe arrivé à échéance part dans le groupe, sans appeler le modèle.
    const handle = db();
    const group = handle.prepare('SELECT id, kind, owner_id FROM users WHERE telegram_id = ?').get(GROUP) as { id: number; kind: string; owner_id: number };
    const admin = handle.prepare('SELECT id FROM users WHERE telegram_id = ?').get(ADMIN) as { id: number };
    handle
      .prepare("INSERT INTO jobs (user_id, kind, text, due_at, repeat, voice, created_at) VALUES (?, 'reminder', ?, ?, 'none', 0, ?)")
      .run(group.id, 'On se retrouve au parking', Date.now() - 1_000, Date.now() - 60_000);
    handle.close();
    const calledBefore = modelCalls().length;
    await telegram.waitFor(messageTo(GROUP, '⏰ On se retrouve au parking'), { since });
    expect(modelCalls()).toHaveLength(calledBefore);

    // Résumé à la demande.
    telegram.sendGroupText(GROUP, GROUP_TITLE, BOB, 'Bob', '/resume@koto_test_bot');
    await telegram.waitFor(messageTo(GROUP, '📝 Résumé'), { since });
    expect(JSON.stringify(modelCalls().at(-1)!.body.messages)).toContain('[RÉSUMÉ] Bob demande un résumé');

    const check = db();
    const groupJobs = check.prepare("SELECT text FROM jobs WHERE user_id = ? AND status = 'pending'").all(group.id);
    const groupItems = check.prepare('SELECT text FROM list_items WHERE user_id = ? ORDER BY id').all(group.id);
    const groupUsage = check.prepare('SELECT COUNT(*) AS n FROM usage WHERE user_id = ?').get(group.id) as { n: number };
    const adminTalk = check.prepare('SELECT content FROM messages WHERE user_id = ?').all(admin.id) as { content: string }[];
    const bobAccounts = check.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_id = ?').get(BOB) as { n: number };
    check.close();
    expect(group).toMatchObject({ kind: 'group', owner_id: admin.id });
    expect(groupJobs).toEqual([{ text: 'Départ pour Andasibe' }]);
    expect(groupItems).toEqual([{ text: 'charbon' }, { text: 'brochettes' }]);
    expect(groupUsage.n).toBe(0); // les tours du groupe comptent dans le budget de l'admin
    expect(adminTalk.map((m) => m.content).join('\n')).not.toContain('charbon');
    expect(bobAccounts.n).toBe(0);

    const menu = telegram.calls.find((c) => c.method === 'setMyCommands' && (c.payload.scope as { type?: string } | undefined)?.type === 'all_group_chats');
    expect((menu!.payload.commands as { command: string }[]).map((c) => c.command)).toContain('resume');
  }, TIMEOUT);

  it('lance une mission par la conversation : un premier passage silencieux, puis un passage qui prévient', async () => {
    const since = telegram.calls.length;
    const passes = () =>
      openrouter.requests.filter((r) => r.path === '/api/v1/messages' && JSON.stringify(r.body.system).includes('Tu es le module de missions de Koto'));
    type MissionRow = { id: number; status: string; runs: number; notes: string; cost_usd: number; end_reason: string | null };
    const mission = () => row<MissionRow | undefined>('SELECT id, status, runs, notes, cost_usd, end_reason FROM missions ORDER BY id DESC LIMIT 1');

    telegram.sendText(ADMIN, 'Surveille le vol Tana → Paris du 4 décembre et préviens-moi s’il passe sous 600 €');
    await telegram.waitFor(messageTo(ADMIN, 'Mission #1 lancée'), { since });

    // Premier passage, aussitôt : rien de nouveau, donc rien n'est envoyé ; ses notes sont gardées.
    await until(() => mission()?.runs === 1);
    expect(mission()).toMatchObject({ status: 'active', notes: 'Prix vu : 640 € chez Air Madagascar.' });
    expect(telegram.calls.slice(since).some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('🎯'))).toBe(false);

    // Passage suivant (avancé pour le test) : le seuil est franchi, la personne est prévenue.
    const handle = db();
    handle.prepare('UPDATE missions SET next_run_at = ? WHERE id = ?').run(Date.now() - 1_000, mission()!.id);
    handle.close();
    const alert = await telegram.waitFor(messageTo(ADMIN, 'est passé à 580 €'), { since });
    expect(String(alert.payload.text)).toMatch(/^🎯 <b>Mission #1<\/b> · Vol Tana → Paris du 4 déc\./);
    await until(() => mission()?.runs === 2);
    expect(mission()).toMatchObject({ status: 'active', notes: 'Prix vu : 580 € chez Air Madagascar. Signalé.' });
    expect(mission()!.cost_usd).toBeGreaterThan(0);

    // Chaque passage a son propre contexte : la mission, ses notes, un profil minimal ; jamais la mémoire ni les listes.
    const [first, second] = passes();
    expect(first!.body.model).toBe('anthropic/claude-haiku-5.5');
    expect((first!.body.tools as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(['news', 'crypto_price', 'weather', 'finish', 'web_search']));
    const sent = JSON.stringify(first!.body.messages);
    for (const personal of ['lait', "Boire de l'eau", 'médicaments']) expect(sent).not.toContain(personal);
    expect(JSON.stringify(second!.body.messages)).toContain('Prix vu : 640 € chez Air Madagascar.');
    const history = row<{ kind: string }>("SELECT kind FROM messages WHERE content LIKE '%est passé à 580 €%'");
    expect(history.kind).toBe('mission');

    // /missions : la liste, gratuite, et le bouton Arrêter.
    const listed = telegram.calls.length;
    telegram.sendText(ADMIN, '/missions');
    const list = await telegram.waitFor((c) => c.method === 'sendMessage' && toAdmin(c) && c.payload.reply_markup !== undefined, { since: listed });
    expect(String(list.payload.text)).toContain('Vol Tana → Paris du 4 déc.');
    const stop = buttons(list)[0]!;
    expect(stop).toMatchObject({ text: '⏹️ Arrêter #1', callback_data: 'ms:1:stop' });
    telegram.pressButton(ADMIN, stop.callback_data, (list.result as { message_id: number }).message_id);
    await telegram.waitFor(messageTo(ADMIN, '⏹️ Mission #1 arrêtée.'), { since: listed });
    expect(mission()).toMatchObject({ status: 'stopped', end_reason: 'person' });
    expect(passes()).toHaveLength(2);
  }, TIMEOUT);

  it('mémoire longue : fiche d’un PDF, recherche dans le passé et ménage de la mémoire', async () => {
    const since = telegram.calls.length;
    const modelCalls = () => openrouter.requests.filter((r) => r.path === '/api/v1/messages');
    const admin = row<{ id: number }>('SELECT id FROM users WHERE telegram_id = ?', ADMIN);

    // Un PDF : la réponse arrive sans sa fiche, qui est gardée (table documents et message de l'historique).
    telegram.addFile('pdf-1', Buffer.from('%PDF-1.7 faux devis'));
    telegram.sendDocument(ADMIN, 'pdf-1', 'devis-toiture.pdf', 'application/pdf', 'Garde ça');
    const reply = await telegram.waitFor(messageTo(ADMIN, 'devis de Rado pour la toiture'), { since });
    expect(String(reply.payload.text)).not.toContain('fiche');
    expect(JSON.stringify(modelCalls().at(-1)!.body.messages)).toContain('"media_type":"application/pdf"');
    expect(row('SELECT kind, name, summary FROM documents WHERE user_id = ?', admin.id)).toEqual({
      kind: 'pdf',
      name: 'devis-toiture.pdf',
      summary: "Devis de Rado pour la réfection de la toiture, 1 200 000 Ar, valable jusqu'au 30 novembre 2026.",
    });

    // La fiche est retrouvée plus tard par search_history, gratuitement (aucune requête de plus que le tour).
    const before = modelCalls().length;
    telegram.sendText(ADMIN, 'Tu te souviens du devis de Rado pour la toiture ?');
    const found = await telegram.waitFor(messageTo(ADMIN, "C'est fait. "), { since });
    expect(String(found.payload.text)).toContain('Devis de Rado pour la réfection de la toiture');
    expect(modelCalls()).toHaveLength(before + 2);

    // Un échange vieux de 40 jours, écrit directement en base : l'index plein texte le suit (déclencheurs).
    const handle = db();
    handle
      .prepare("INSERT INTO messages (user_id, role, content, kind, created_at) VALUES (?, 'user', ?, 'chat', ?)")
      .run(admin.id, "Le plombier passe le 12 septembre pour la fuite sous l'évier", Date.now() - 40 * 86_400_000);
    handle.close();
    const asked = telegram.calls.length;
    telegram.sendText(ADMIN, 'Tu te souviens quand le plombier devait passer ?');
    const old = await telegram.waitFor(messageTo(ADMIN, "C'est fait. "), { since: asked });
    expect(String(old.payload.text)).toContain("Le plombier passe le 12 septembre pour la fuite sous l'évier");

    // Ménage : 61 souvenirs, au-delà du seuil. Le scheduler le lance seul, avec le modèle le moins cher.
    const fill = db();
    const insert = fill.prepare("INSERT INTO memories (user_id, kind, content, importance, created_at, updated_at) VALUES (?, 'note', ?, 2, ?, ?)");
    const at = Date.now() - 10 * 86_400_000;
    fill.transaction(() => {
      for (let i = 0; i < 61; i++) insert.run(admin.id, `Souvenir de test n° ${i}`, at, at);
    })();
    fill.close();
    const tidy = await telegram.waitFor(messageTo(ADMIN, "🧹 J'ai rangé ma mémoire"), { since });
    expect(String(tidy.payload.text)).toContain('Projet Koto : agent IA perso sur Telegram');
    const request = modelCalls().findLast((r) => JSON.stringify(r.body.system).includes('module de mémoire de Koto'))!;
    expect(request.body.model).toBe('anthropic/claude-haiku-5.5');
    expect((request.body.tools as { name: string }[]).map((t) => t.name)).toEqual(['consolidate']);
    // Rien n'est effacé : le souvenir fusionné, l'ancienne version et le souvenir périmé sont aux archives.
    await until(() => row<{ n: number }>('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND archived_at IS NOT NULL', admin.id).n === 3);
    expect(row('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND archived_at IS NULL', admin.id)).toEqual({ n: 59 });
    expect(row("SELECT kind FROM messages WHERE content LIKE '🧹%'")).toEqual({ kind: 'memory' });

    const listed = telegram.calls.length;
    telegram.sendText(ADMIN, '/memoire');
    const memoire = await telegram.waitFor(messageTo(ADMIN, 'Archivés'), { since: listed });
    expect(String(memoire.payload.text)).toContain('(passé)');
  }, TIMEOUT);

  it('rouvre un document reçu plus tôt quand la fiche ne suffit pas, jamais celui d’un autre, et dit quand Telegram ne le donne plus', async () => {
    const modelCalls = () => openrouter.requests.filter((r) => r.path === '/api/v1/messages');
    const fileRequests = (since: number) => telegram.calls.slice(since).filter((c) => c.method === 'getFile').map((c) => c.payload.file_id);
    // Une deuxième personne, invitée par l'admin (qui a déjà beaucoup écrit cette minute : limite de débit).
    const invited = telegram.calls.length;
    telegram.sendText(ADMIN, '/inviter');
    const link = await telegram.waitFor(messageTo(ADMIN, '?start='), { since: invited });
    const code = /\?start=(\S+)/.exec(String(link.payload.text))![1]!;
    telegram.sendText(CLARA, `/start ${code}`);
    await telegram.waitFor(messageTo(CLARA, ''), { since: invited });
    const clara = row<{ id: number }>('SELECT id FROM users WHERE telegram_id = ?', CLARA);
    const admin = row<{ id: number }>('SELECT id FROM users WHERE telegram_id = ?', ADMIN);

    const since = telegram.calls.length;
    const bytes = Buffer.from('%PDF-1.7 faux bail - clause 4 : preavis de trois mois');
    telegram.addFile('pdf-clara', bytes);
    telegram.sendDocument(CLARA, 'pdf-clara', 'bail.pdf', 'application/pdf', 'Mon bail');
    await telegram.waitFor(messageTo(CLARA, 'ton bail'), { since });
    const bail = row<{ id: number }>('SELECT id FROM documents WHERE user_id = ?', clara.id);
    const other = row<{ id: number }>('SELECT id FROM documents WHERE user_id = ?', admin.id);

    // Le document de l'admin n'existe pas pour elle : rien n'est demandé à Telegram.
    let asked = telegram.calls.length;
    telegram.sendText(CLARA, `Relis-moi le document #${other.id}`);
    const refused = await telegram.waitFor(messageTo(CLARA, "C'est fait. "), { since: asked });
    expect(String(refused.payload.text)).toContain(`Aucun document #${other.id} ici`);
    expect(fileRequests(asked)).toEqual([]);

    // Le sien est retéléchargé chez Telegram et ne part que dans le tool_result du tour.
    asked = telegram.calls.length;
    telegram.sendText(CLARA, `Relis-moi le document #${bail.id}, la clause 4`);
    const reply = await telegram.waitFor(messageTo(CLARA, "C'est fait. "), { since: asked });
    expect(String(reply.payload.text)).toContain(`Document #${bail.id} rouvert : PDF « bail.pdf »`);
    expect(String(reply.payload.text)).toContain('[document application/pdf]');
    expect(fileRequests(asked)).toEqual(['pdf-clara']);
    const sent = modelCalls().at(-1)!.body.messages as { role: string; content: Record<string, unknown>[] }[];
    const data = bytes.toString('base64');
    expect(sent.at(-1)!.content[0]).toMatchObject({
      type: 'tool_result',
      content: [{ type: 'text' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: 'bail.pdf' }],
    });
    expect(row('SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?', `%${data}%`)).toEqual({ n: 0 });

    // Le file_id n'est plus valable : Koto le dit, avec la fiche, sans planter.
    telegram.removeFile('pdf-clara');
    asked = telegram.calls.length;
    telegram.sendText(CLARA, `Relis-moi le document #${bail.id}`);
    const gone = await telegram.waitFor(messageTo(CLARA, "C'est fait. "), { since: asked });
    expect(String(gone.payload.text)).toContain('Telegram ne donne plus le fichier');
    expect(String(gone.payload.text)).toContain('Sa fiche dit : « Bail du T2 rue Ratsimilaho');
  }, TIMEOUT);

  it('appel en direct : bouton dans Telegram, phrase transcrite, réponse parlée, fin d’appel', async () => {
    const menu = await telegram.waitFor((c) => c.method === 'setChatMenuButton');
    expect(menu.payload.menu_button).toEqual({ type: 'web_app', text: 'Appeler', web_app: { url: `${callUrl}/appel` } });

    const since = telegram.calls.length;
    telegram.sendText(ADMIN, '/appel');
    const card = await telegram.waitFor((c) => c.method === 'sendMessage' && toAdmin(c) && c.payload.reply_markup !== undefined, { since });
    const button = (card.payload.reply_markup as { inline_keyboard: { web_app?: { url: string } }[][] }).inline_keyboard[0]![0]!;
    expect(button.web_app?.url).toBe(`${callUrl}/appel`);

    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ADMIN, first_name: 'Ana' }) }, telegram.token);
    openrouter.transcript = 'Quelle heure est-il ?';
    const response = await fetch(`${callUrl}/appel/tour`, {
      method: 'POST',
      headers: { Authorization: `tma ${initData}`, 'Content-Type': 'audio/wav' },
      body: new Uint8Array(makeWav([{ seconds: 1, voice: true }])),
    });
    expect(response.status).toBe(200);
    const turn = (await response.json()) as { transcript: string; reply: string; audio: string | null };
    expect(turn.transcript).toBe('Quelle heure est-il ?');
    expect(turn.reply).toBe('Bien reçu : [appel] Quelle heure est-il ?');
    expect(Buffer.from(turn.audio ?? '', 'base64').length).toBeGreaterThan(1_000);

    const transcription = openrouter.requests.findLast((r) => r.path === '/api/v1/chat/completions')!;
    expect(JSON.stringify(transcription.body)).toContain('"format":"wav"');
    const model = openrouter.requests.findLast((r) => r.path === '/api/v1/messages')!;
    expect(JSON.stringify(model.body.system)).toContain('[appel]');

    const end = await fetch(`${callUrl}/appel/fin`, { method: 'POST', body: JSON.stringify({ initData, tours: 1, secondes: 40 }) });
    expect(end.status).toBe(204);
    await telegram.waitFor(messageTo(ADMIN, '📞 Appel terminé : 1 échange'));

    const intrus = await fetch(`${callUrl}/appel/tour`, { method: 'POST', headers: { Authorization: 'tma faux' }, body: new Uint8Array(10) });
    expect(intrus.status).toBe(401);
  }, TIMEOUT);

  it('exporte toutes ses données dans un fichier', async () => {
    const since = telegram.calls.length;
    telegram.sendText(ADMIN, '/exporter');
    const doc = await telegram.waitFor((c) => c.method === 'sendDocument' && toAdmin(c), { since });

    const file = doc.files.document!;
    expect(file.name).toMatch(/^koto-mes-donnees-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown[]>;
    // Rien du groupe ici (ni sa liste, ni ses rappels) : seulement son nom, parmi les groupes rattachés.
    expect(data.listes).toEqual([
      expect.objectContaining({ liste: 'courses', element: 'lait', fait: true }),
      expect.objectContaining({ liste: 'courses', element: 'pain', fait: false }),
    ]);
    expect(data.rappels_a_venir).toEqual([expect.objectContaining({ texte: "Boire de l'eau" })]);
    expect(data.groupes_rattaches).toEqual([expect.objectContaining({ nom: GROUP_TITLE })]);
    expect(data.missions).toEqual([expect.objectContaining({ titre: 'Vol Tana → Paris du 4 déc.', statut: 'stopped', passages: 2, notes: 'Prix vu : 580 € chez Air Madagascar. Signalé.' })]);
    // Mémoire longue : les documents reçus (leur fiche) et les archives du ménage.
    expect(data.documents).toEqual([expect.objectContaining({ type: 'pdf', nom: 'devis-toiture.pdf', fiche: expect.stringContaining('Devis de Rado') })]);
    expect(data.memoire_archivee).toHaveLength(3);
    expect(data.historique!.length).toBeGreaterThan(4);
  }, TIMEOUT);

  it('compte chaque appel payant dans le budget du jour', () => {
    const handle = db();
    const usage = handle.prepare('SELECT SUM(requests) AS requests, SUM(cost_usd) AS cost FROM usage').get() as { requests: number; cost: number };
    handle.close();
    // Tours du modèle (0,0003 $ chacun ici), transcription (0,0001 $) et vocaux (voix gratuite : 0 $).
    expect(usage.requests).toBeGreaterThanOrEqual(8);
    expect(usage.cost).toBeGreaterThan(0.001);
  });

  it('s’arrête proprement sur SIGTERM', async () => {
    const code = await koto.stop();
    expect(code).toBe(0);
    expect(koto.output()).toContain('arrêt (SIGTERM)');
  }, TIMEOUT);
});
