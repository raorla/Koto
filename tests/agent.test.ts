import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent/agent.js';
import { usageToTotals } from '../src/agent/pricing.js';
import { selectHistoryWindow } from '../src/agent/prompt.js';
import type { StoredMessage } from '../src/store.js';
import { NOW, fakeIntegrations, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';

function agentFor(responses: Parameters<typeof scriptedCreate>[0]) {
  const store = makeStore();
  const { create, calls } = scriptedCreate(responses);
  const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: true, now: () => NOW });
  return { store, agent, calls };
}

describe('boucle de l’agent', () => {
  it("exécute les outils, garde l'historique en ajout seul et enregistre le tour", async () => {
    const { store, agent, calls } = agentFor([
      message(
        [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          toolUse('t1', 'remember', { kind: 'project', content: 'Projet Koto : agent IA perso', importance: 3 }),
          toolUse('t2', 'schedule', { kind: 'checkin', when: '2026-10-17T18:00', text: 'Demander où en est Koto' }),
        ],
        'tool_use',
      ),
      message([text('Top ! Je te relance samedi soir.')], 'end_turn', { cache_read_input_tokens: 3_000 }),
    ]);
    const user = makeUser(store);

    const result = await agent({ userId: user.id, kind: 'chat', text: 'Je lance Koto cette semaine' });

    expect(result).toMatchObject({ status: 'ok', text: 'Top ! Je te relance samedi soir.' });
    expect(store.listMemories(user.id).map((m) => m.content)).toEqual(['Projet Koto : agent IA perso']);
    expect(store.listPendingJobs(user.id)).toHaveLength(1);

    // Préfixe identique d'un appel à l'autre : réflexion et cache restent valides.
    const [first, second] = calls;
    expect(second!.system).toEqual(first!.system);
    expect(second!.tools).toEqual(first!.tools);
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    const [assistant, results] = second!.messages.slice(first!.messages.length);
    expect(assistant).toMatchObject({ role: 'assistant', content: [{ type: 'thinking', signature: 'sig-1' }, {}, {}] });
    expect(results).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1' },
        { type: 'tool_result', tool_use_id: 't2' },
      ],
    });

    const history = store.listMessagesAfter(user.id, 0).map((m) => [m.role, m.content]);
    expect(history).toEqual([
      ['user', 'Je lance Koto cette semaine'],
      ['assistant', 'Top ! Je te relance samedi soir.'],
    ]);
    expect(store.getUsage(user.id, '2026-10-14')).toMatchObject({ requests: 2, cacheReadTokens: 3_000 });
  });

  it('pose les points de cache, l’effort et le repli, avec un préfixe commun à tous', async () => {
    const { store, agent, calls } = agentFor([message([text('Salut Ana')], 'end_turn'), message([text('Salut Bob')], 'end_turn')]);
    const ana = makeUser(store, { firstName: 'Ana' });
    const bob = makeUser(store, { firstName: 'Bob' });

    await agent({ userId: ana.id, kind: 'chat', text: 'salut' });
    await agent({ userId: bob.id, kind: 'chat', text: 'salut' });

    const [a, b] = calls;
    expect(a).toMatchObject({
      model: 'claude-opus-5-5',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(a!.system).toMatchObject([{ cache_control: { type: 'ephemeral', ttl: '1h' } }, { cache_control: { type: 'ephemeral' } }]);
    expect(a!.tools).toEqual(b!.tools);
    expect((a!.system as unknown[])[0]).toEqual((b!.system as unknown[])[0]);
    expect((a!.system as unknown[])[1]).not.toEqual((b!.system as unknown[])[1]);
    expect(JSON.stringify(a!.messages.at(-1))).toContain('[mer. 14 oct. 2026, 19:00] salut');
  });

  it('avec OpenRouter : pas de bêta Anthropic, une session par personne, hébergeur Anthropic en premier', async () => {
    const store = makeStore();
    const { create, calls } = scriptedCreate([message([text('Salut')], 'end_turn')]);
    const agent = createAgent({ create, store, provider: 'openrouter', model: 'anthropic/claude-opus-5.5', effort: 'low', webTools: true, now: () => NOW });
    const anthropic = agentFor([message([text('Salut')], 'end_turn')]);
    const user = makeUser(store);
    const other = makeUser(anthropic.store);

    await agent({ userId: user.id, kind: 'chat', text: 'salut' });
    await anthropic.agent({ userId: other.id, kind: 'chat', text: 'salut' });

    const [request] = calls;
    expect(request).toMatchObject({
      model: 'anthropic/claude-opus-5.5',
      session_id: `koto-user-${user.id}`,
      provider: { order: ['anthropic'], allow_fallbacks: true },
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
    });
    expect(request).not.toHaveProperty('betas');
    expect(request).not.toHaveProperty('fallbacks');
    // Mêmes outils (y compris web natifs) que sur l'API Anthropic : OpenRouter accepte ces types.
    expect(request!.tools).toEqual(anthropic.calls[0]!.tools);
  });

  it("reprend un tour d'outils serveur en pause sans ajouter de message utilisateur", async () => {
    const paused = message(
      [text('Je regarde la météo.'), { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'météo Antananarivo' } }],
      'pause_turn',
    );
    const done = message(
      [
        {
          type: 'text',
          text: 'Il fait 24 °C à Tana.',
          citations: [{ type: 'web_search_result_location', url: 'https://meteo.example/tana', title: 'Météo Tana', cited_text: '24 °C', encrypted_index: 'x' }],
        },
      ],
      'end_turn',
      { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    );
    const { store, agent, calls } = agentFor([paused, done]);
    const user = makeUser(store);

    const result = await agent({ userId: user.id, kind: 'chat', text: 'Il fait quel temps ?' });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.slice(calls[0]!.messages.length)).toEqual([{ role: 'assistant', content: paused.content }]);
    expect(result.text).toBe('Je regarde la météo.\n\nIl fait 24 °C à Tana.\n\nSources : [Météo Tana](https://meteo.example/tana)');
    expect(result.usage.webSearches).toBe(1);
  });

  it("s'arrête sur un refus sans exécuter d'outil", async () => {
    const { store, agent } = agentFor([
      message([toolUse('t1', 'remember', { kind: 'note', content: 'x', importance: 1 })], 'refusal'),
    ]);
    const user = makeUser(store);

    const result = await agent({ userId: user.id, kind: 'chat', text: '…' });

    expect(result.status).toBe('refused');
    expect(store.listMemories(user.id)).toHaveLength(0);
  });

  it('borne le nombre d’étapes', async () => {
    const loop = () => message([toolUse(`t${Math.random()}`, 'list_scheduled', {})], 'tool_use');
    const store = makeStore();
    const { create, calls } = scriptedCreate([loop, loop, loop]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, now: () => NOW, maxSteps: 3 });
    const user = makeUser(store);

    const result = await agent({ userId: user.id, kind: 'chat', text: 'boucle' });

    expect(result.status).toBe('too_many_steps');
    expect(calls).toHaveLength(3);
  });
});

describe('coûts', () => {
  it('additionne les tentatives de repli, chacune au tarif de son modèle', () => {
    const base = { cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const totals = usageToTotals(
      {
        input_tokens: 0,
        output_tokens: 0,
        ...base,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0, ...base },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 0, output_tokens: 1_000_000, ...base },
        ],
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
      } as never,
      'claude-opus-5-5',
    );
    expect(totals.costUsd).toBeCloseTo(4 + 25 + 0.02, 6);
  });

  it('reconnaît les ids OpenRouter et préfère le coût réel renvoyé par OpenRouter', () => {
    const base = { cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null, server_tool_use: null };
    const estimated = usageToTotals({ input_tokens: 1_000_000, output_tokens: 0, ...base } as never, 'anthropic/claude-opus-5.5');
    expect(estimated.costUsd).toBeCloseTo(4, 6);
    const reported = usageToTotals({ input_tokens: 43, output_tokens: 8, ...base, cost: 0.000332 } as never, 'anthropic/claude-opus-5.5');
    expect(reported.costUsd).toBe(0.000332);
  });

  it('distingue les écritures de cache 5 min et 1 h', () => {
    const totals = usageToTotals(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
        iterations: null,
        server_tool_use: null,
      } as never,
      'claude-opus-5-5',
    );
    expect(totals.costUsd).toBeCloseTo(0.2 + 5 + 8, 6);
  });
});

describe("fenêtre d'historique", () => {
  const history = (n: number): StoredMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      userId: 1,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i + 1}`,
      kind: 'chat',
      createdAt: NOW,
    }));

  it("ne bouge pas tant que l'historique tient dans les limites", () => {
    expect(selectHistoryWindow(history(60))).toMatchObject({ newStartId: null });
  });

  it('coupe par paliers en commençant par un message de la personne', () => {
    const { messages, newStartId } = selectHistoryWindow(history(61));
    expect(messages.length).toBeLessThanOrEqual(30);
    expect(messages[0]!.role).toBe('user');
    expect(newStartId).toBe(messages[0]!.id - 1);
  });
});

describe('agent avec Gmail et Google Agenda', () => {
  function setup(connected: Parameters<typeof fakeIntegrations>[0], responses: Parameters<typeof scriptedCreate>[0]) {
    const store = makeStore();
    const fake = fakeIntegrations(connected);
    const { create, calls } = scriptedCreate(responses);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, integrations: fake.integrations, now: () => NOW });
    const user = makeUser(store);
    return { store, fake, calls, agent, user };
  }

  it("lit les mails directement mais prépare l'envoi sans l'exécuter", async () => {
    const { store, fake, calls, agent, user } = setup({ gmail: true }, [
      message(
        [
          toolUse('t1', 'GMAIL_FETCH_EMAILS', { query: 'from:rado is:unread' }),
          toolUse('t2', 'GMAIL_SEND_EMAIL', { recipient_email: 'rado@exemple.com', subject: 'Devis', body: 'Ok pour moi' }),
        ],
        'tool_use',
      ),
      message([text("J'ai préparé ta réponse à Rado : appuie sur Confirmer pour l'envoyer.")], 'end_turn'),
    ]);
    store.setConnection(user.id, 'gmail', true, NOW);

    const result = await agent({ userId: user.id, kind: 'chat', text: 'Réponds à Rado que je valide le devis' });

    expect(fake.calls.map((c) => c.tool)).toEqual(['GMAIL_FETCH_EMAILS']);
    expect(result.pendingActions).toMatchObject([{ tool: 'GMAIL_SEND_EMAIL', status: 'pending', args: { recipient_email: 'rado@exemple.com' } }]);
    const toolResults = calls[1]!.messages.at(-1)!.content as { content: string }[];
    expect(toolResults[1]!.content).toContain("n'est PAS encore faite");

    const sendTool = (calls[0]!.tools as { name: string; description?: string }[]).find((t) => t.name === 'GMAIL_SEND_EMAIL');
    expect(sendTool?.description).toContain('Confirmer');
    const system = JSON.stringify(calls[0]!.system);
    expect(system).toContain('# Agenda et mails');
    expect(system).toContain('Gmail (connecté)');
    expect(system).toContain('Google Agenda (non connecté — commande /connecter)');
  });

  it("propose /connecter quand le service n'est pas relié, après une seule vérification", async () => {
    const { fake, calls, agent, user } = setup({ gmail: false, googlecalendar: false }, [
      message([toolUse('t1', 'GOOGLECALENDAR_EVENTS_LIST', {}), toolUse('t2', 'GOOGLECALENDAR_EVENTS_LIST', {})], 'tool_use'),
      message([text('Relie ton agenda avec /connecter et je regarde.')], 'end_turn'),
    ]);
    let checks = 0;
    const status = fake.integrations.connectionStatus.bind(fake.integrations);
    fake.integrations.connectionStatus = async (u) => {
      checks++;
      return status(u);
    };

    await agent({ userId: user.id, kind: 'chat', text: "Qu'est-ce que j'ai demain ?" });

    expect(checks).toBe(1);
    expect(fake.calls).toHaveLength(0);
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain('/connecter');
  });

  it('tient compte d’un compte connecté entre-temps', async () => {
    const { store, fake, agent, user } = setup({ googlecalendar: true }, [
      message([toolUse('t1', 'GOOGLECALENDAR_EVENTS_LIST', {})], 'tool_use'),
      message([text('Demain tu as un rendez-vous à 10h.')], 'end_turn'),
    ]);

    await agent({ userId: user.id, kind: 'chat', text: "Qu'est-ce que j'ai demain ?" });

    expect(fake.calls.map((c) => c.tool)).toEqual(['GOOGLECALENDAR_EVENTS_LIST']);
    expect(store.getConnections(user.id)).toMatchObject({ googlecalendar: true });
  });

  it("n'annonce ni Gmail ni l'agenda quand les intégrations sont désactivées", async () => {
    const { store, agent: _unused } = setup({}, []);
    const { create, calls } = scriptedCreate([message([text('ok')], 'end_turn')]);
    const plain = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: false, now: () => NOW });
    const user = makeUser(store);

    await plain({ userId: user.id, kind: 'chat', text: 'salut' });

    const system = JSON.stringify(calls[0]!.system);
    expect(system).not.toContain('# Agenda et mails');
    expect(system).not.toContain('Connexions');
    expect((calls[0]!.tools as { name: string }[]).some((t) => t.name.startsWith('GMAIL_'))).toBe(false);
  });
});

describe('agent avec réponses vocales et veille', () => {
  it('propose reply_by_voice et les réglages vocaux, et signale la demande de vocal', async () => {
    const store = makeStore();
    const { create, calls } = scriptedCreate([
      message([toolUse('t1', 'reply_by_voice', {})], 'tool_use'),
      message([text('Voilà, je te le dis à voix haute.')], 'end_turn'),
    ]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: true, speech: true, news: true, now: () => NOW });
    const user = makeUser(store);

    const result = await agent({ userId: user.id, kind: 'chat', text: 'Réponds-moi en vocal' });

    expect(result).toMatchObject({ status: 'ok', voice: true });
    const tools = calls[0]!.tools as { name: string; input_schema: { properties: Record<string, unknown> } }[];
    expect(tools.map((t) => t.name)).toContain('reply_by_voice');
    expect(Object.keys(tools.find((t) => t.name === 'update_settings')!.input_schema.properties)).toEqual(
      expect.arrayContaining(['voice_replies', 'brief_voice', 'news_topics']),
    );
    expect(Object.keys(tools.find((t) => t.name === 'schedule')!.input_schema.properties)).toContain('voice');
    const [staticBlock, context] = (calls[0]!.system as { text: string }[]).map((b) => b.text);
    expect(staticBlock).toContain('# Vocal');
    expect(staticBlock).toContain('news_topics');
    expect(context).toContain("Réponses vocales : quand elle t'envoie un vocal");
    expect(context).toContain('Veille du brief : aucune');
  });

  it('sans synthèse vocale, ne propose pas de parler et refuse reply_by_voice', async () => {
    const store = makeStore();
    const { create, calls } = scriptedCreate([
      message([toolUse('t1', 'reply_by_voice', {})], 'tool_use'),
      message([text('Je ne peux répondre qu’à l’écrit ici.')], 'end_turn'),
    ]);
    const agent = createAgent({ create, store, model: 'claude-opus-5-5', effort: 'low', webTools: true, now: () => NOW });

    const result = await agent({ userId: makeUser(store).id, kind: 'chat', text: 'Réponds-moi en vocal' });

    expect(result.voice).toBe(false);
    expect((calls[0]!.tools as { name: string }[]).map((t) => t.name)).not.toContain('reply_by_voice');
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain('pas activées');
  });
});
