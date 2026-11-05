import { describe, expect, it } from 'vitest';
import { cancelAction, confirmAction, ACTION_MAX_AGE_MS } from '../src/integrations/actions.js';
import { INTEGRATION_TOOLS, needsConfirmation, renderActionPreview, toolkitOf } from '../src/integrations/catalog.js';
import { mcpResultToText } from '../src/integrations/composio.js';
import { NOW, fakeIntegrations, makeStore, makeUser } from './helpers.js';

describe('catalogue des intégrations', () => {
  it("n'exécute sans confirmation que les lectures et les brouillons", () => {
    const direct = Object.values(INTEGRATION_TOOLS).flat().filter((tool) => !needsConfirmation(tool));
    expect(direct.sort()).toEqual(
      [
        'GMAIL_CREATE_EMAIL_DRAFT',
        'GMAIL_FETCH_EMAILS',
        'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
        'GMAIL_GET_PROFILE',
        'GOOGLECALENDAR_EVENTS_LIST',
        'GOOGLECALENDAR_FIND_EVENT',
        'GOOGLECALENDAR_FIND_FREE_SLOTS',
      ].sort(),
    );
    for (const tool of ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'GMAIL_SEND_DRAFT', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_DELETE_EVENT']) {
      expect(needsConfirmation(tool)).toBe(true);
    }
    // Un outil inconnu ou ajouté plus tard attend une confirmation par défaut.
    expect(needsConfirmation('GMAIL_DELETE_MESSAGE')).toBe(true);
    expect(toolkitOf('GMAIL_SEND_EMAIL')).toBe('gmail');
    expect(toolkitOf('GOOGLECALENDAR_CREATE_EVENT')).toBe('googlecalendar');
    expect(toolkitOf('GMAIL_DELETE_MESSAGE')).toBeNull();
  });

  it('présente une action à confirmer en français, sans champs techniques', () => {
    const preview = renderActionPreview('GMAIL_SEND_EMAIL', {
      recipient_email: 'rado@exemple.com',
      subject: 'Devis Koto',
      body: 'Bonjour Rado, je valide le devis.',
      user_id: 'me',
      cc: [],
    });
    expect(preview).toContain('**📧 Envoyer un mail** — à confirmer');
    expect(preview).toContain('• À : rado@exemple.com');
    expect(preview).toContain('• Objet : Devis Koto');
    expect(preview).toContain('Bonjour Rado, je valide le devis.');
    expect(preview).not.toContain('user_id');
    expect(preview).not.toContain('Cc');
  });

  it('convertit un résultat MCP et repère les échecs signalés par Composio', () => {
    expect(mcpResultToText({ content: [{ type: 'text', text: '{"successful":true,"data":{}}' }] })).toEqual({
      text: '{"successful":true,"data":{}}',
      isError: false,
    });
    expect(mcpResultToText({ content: [{ type: 'text', text: '{"successful":false,"error":"invalid_grant"}' }] }).isError).toBe(true);
    expect(mcpResultToText({ toolResult: { ok: 1 } }).text).toBe('{"ok":1}');
    expect(mcpResultToText({ content: [{ type: 'text', text: 'x'.repeat(20_000) }] }).text).toContain('résultat tronqué');
  });
});

describe('actions à confirmer', () => {
  function setup() {
    const store = makeStore();
    const alice = makeUser(store, { firstName: 'Alice' });
    const bob = makeUser(store, { firstName: 'Bob' });
    const fake = fakeIntegrations();
    const action = store.addPendingAction(alice.id, 'GMAIL_SEND_EMAIL', { recipient_email: 'rado@exemple.com', subject: 'Devis' }, NOW);
    return { store, alice, bob, fake, action };
  }

  it("exécute une seule fois, même en cas de double clic, et l'inscrit dans l'historique", async () => {
    const { store, alice, fake, action } = setup();

    const [first, second] = await Promise.all([
      confirmAction(store, fake.integrations, alice, action.id, NOW + 1_000),
      confirmAction(store, fake.integrations, alice, action.id, NOW + 1_000),
    ]);

    expect([first.status, second.status].sort()).toEqual(['already_decided', 'done']);
    expect(fake.calls).toEqual([{ userId: alice.id, tool: 'GMAIL_SEND_EMAIL', args: { recipient_email: 'rado@exemple.com', subject: 'Devis' } }]);
    expect(store.getPendingAction(alice.id, action.id)?.status).toBe('done');
    expect(store.listMessagesAfter(alice.id, 0).at(-1)?.content).toBe(
      '✅ Fait après confirmation de la personne : 📧 Envoyer un mail (à rado@exemple.com, objet « Devis »).',
    );
  });

  it("refuse l'action d'un autre utilisateur et les demandes expirées", async () => {
    const { store, alice, bob, fake, action } = setup();
    expect((await confirmAction(store, fake.integrations, bob, action.id, NOW)).status).toBe('missing');
    expect((await confirmAction(store, fake.integrations, alice, action.id, NOW + ACTION_MAX_AGE_MS + 1)).status).toBe('expired');
    expect(fake.calls).toHaveLength(0);
  });

  it("garde une trace des échecs et des annulations", async () => {
    const { store, alice, fake, action } = setup();
    fake.setResult({ text: 'quota dépassé', isError: true });
    const failed = await confirmAction(store, fake.integrations, alice, action.id, NOW);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(store.getPendingAction(alice.id, action.id)).toMatchObject({ status: 'failed', result: 'quota dépassé' });

    const other = store.addPendingAction(alice.id, 'GOOGLECALENDAR_DELETE_EVENT', { event_id: 'evt1' }, NOW);
    expect(cancelAction(store, alice, other.id, NOW)).toBe(true);
    expect(cancelAction(store, alice, other.id, NOW)).toBe(false);
    expect(store.listMessagesAfter(alice.id, 0).at(-1)?.content).toBe('❌ Annulé par la personne : 🗑️ Supprimer un événement (événement evt1).');
  });
});
