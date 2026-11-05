import { describe, expect, it } from 'vitest';
import { runBrowserTask, type Answer, type TaskQuestion } from '../src/browser/agent.js';
import type { CredentialBroker } from '../src/browser/credentials.js';
import type { BrowserSession, PageState } from '../src/browser/engine.js';
import { NOW, makeStore, makeUser, message, scriptedCreate, text, toolUse } from './helpers.js';

function fakeSession(elements: Record<number, { name: string; password?: boolean }>, startUrl = 'https://www.example.mg/panier') {
  let url = startUrl;
  const actions: string[] = [];
  const state = (): PageState => ({
    url,
    title: 'Page',
    elements: Object.entries(elements).map(([ref, e]) => `[${ref}] bouton « ${e.name} »`).join('\n'),
    text: '',
  });
  const session: BrowserSession = {
    headed: false,
    async navigate(target) {
      actions.push(`navigate ${target}`);
      url = target;
      return state();
    },
    async state() {
      return state();
    },
    async element(ref) {
      const e = elements[ref];
      return e ? { ref, tag: 'button', role: '', name: e.name, password: e.password ?? false } : null;
    },
    async click(ref) {
      actions.push(`click ${ref}`);
      return state();
    },
    async type(ref, value) {
      actions.push(`type ${ref} ${value}`);
      return state();
    },
    async select(ref, option) {
      actions.push(`select ${ref} ${option}`);
      return state();
    },
    async press(key) {
      actions.push(`press ${key}`);
      return state();
    },
    async scroll() {
      return state();
    },
    async back() {
      return state();
    },
    async readText() {
      return 'texte de la page';
    },
    async screenshot() {
      return Buffer.from([0xff, 0xd8, 0xff]);
    },
    currentUrl: () => url,
    async fillLogin(username) {
      actions.push(`fillLogin ${username}`);
      return 'filled';
    },
    async close() {},
  };
  return { session, actions, setUrl: (next: string) => (url = next) };
}

function run(
  responses: Parameters<typeof scriptedCreate>[0],
  options: {
    session: BrowserSession;
    ask?: (q: TaskQuestion) => Promise<Answer>;
    credentials?: CredentialBroker | null;
    canHandOver?: boolean;
    maxCostUsd?: number;
    signal?: AbortSignal;
  },
) {
  const store = makeStore();
  const user = makeUser(store);
  const { create, calls } = scriptedCreate(responses);
  const questions: TaskQuestion[] = [];
  const result = runBrowserTask({
    create,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    effort: 'low',
    session: options.session,
    user,
    goal: 'Réserver le vol',
    ask: async (q) => {
      questions.push(q);
      return options.ask ? options.ask(q) : 'yes';
    },
    credentials: options.credentials ?? null,
    canHandOver: options.canHandOver ?? false,
    maxSteps: 20,
    maxCostUsd: options.maxCostUsd ?? 10,
    signal: options.signal,
    now: () => NOW,
  });
  return { result, calls, questions };
}

/** Résultats d'outils envoyés au modèle lors de l'appel n° index. */
function toolResults(calls: ReturnType<typeof scriptedCreate>['calls'], index: number) {
  return calls[index]!.messages.at(-1)!.content as { content: unknown; is_error?: boolean }[];
}

describe('sous-agent de navigation', () => {
  it('refuse de payer sans confirmation, puis accepte un seul clic après le « oui »', async () => {
    const { session, actions } = fakeSession({ 1: { name: 'Rechercher' }, 2: { name: 'Payer 650 €' } });
    const { result, calls, questions } = run(
      [
        message([toolUse('a', 'click', { ref: 2 })], 'tool_use'),
        message([toolUse('b', 'ask_confirmation', { action: 'Payer le vol 650 €', details: 'Air Madagascar, 4 déc.' })], 'tool_use'),
        message([toolUse('c', 'click', { ref: 2 })], 'tool_use'),
        message([toolUse('d', 'click', { ref: 2 })], 'tool_use'),
        message([toolUse('e', 'finish', { summary: 'Vol payé : 650 €, référence ABC123.', success: true })], 'tool_use'),
      ],
      { session },
    );

    expect(await result).toMatchObject({ status: 'done', summary: 'Vol payé : 650 €, référence ABC123.' });
    expect(actions).toEqual(['click 2']);
    expect(toolResults(calls, 1)[0]).toMatchObject({ is_error: true });
    expect(String(toolResults(calls, 1)[0]!.content)).toContain('ask_confirmation');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: 'confirm', text: 'Payer le vol 650 €\nAir Madagascar, 4 déc.' });
    expect(questions[0]!.screenshot).toBeInstanceOf(Buffer);
    expect(toolResults(calls, 4)[0]).toMatchObject({ is_error: true });
  });

  it('ne tape jamais de mot de passe ni de numéro de carte', async () => {
    const { session, actions } = fakeSession({ 1: { name: 'Mot de passe', password: true }, 2: { name: 'Numéro de carte' } });
    const { result, calls } = run(
      [
        message([toolUse('a', 'type', { ref: 1, text: 'motdepasse' }), toolUse('b', 'type', { ref: 2, text: '4111 1111 1111 1111' })], 'tool_use'),
        message([toolUse('c', 'finish', { summary: 'Je dois te laisser saisir ta carte.', success: false })], 'tool_use'),
      ],
      { session },
    );

    expect(await result).toMatchObject({ status: 'failed' });
    expect(actions).toEqual([]);
    const [password, card] = toolResults(calls, 1);
    expect(String(password!.content)).toContain('mot de passe');
    expect(String(card!.content)).toContain('numéro de carte');
  });

  it("ne passe pas la main quand la fenêtre n'est pas visible, et bloque le réseau local", async () => {
    const { session, actions } = fakeSession({});
    const { result, calls, questions } = run(
      [
        message([toolUse('a', 'hand_over', { reason: 'Connexion requise' }), toolUse('b', 'navigate', { url: 'http://192.168.1.1/' })], 'tool_use'),
        message([text('Connecte-toi toi-même sur le site.')], 'end_turn'),
      ],
      { session, canHandOver: false },
    );

    expect(await result).toMatchObject({ status: 'done', summary: 'Connecte-toi toi-même sur le site.' });
    expect(questions).toHaveLength(0);
    expect(actions).toEqual([]);
    const [handover, navigate] = toolResults(calls, 1);
    expect(String(handover!.content)).toContain("pas visible");
    expect(String(navigate!.content)).toContain('Navigation refusée');
  });

  it('se connecte via 1Password après accord, sans que le secret passe par le modèle', async () => {
    const { session, actions } = fakeSession({}, 'https://www.jumia.mg/customer/account/login');
    const credentials: CredentialBroker = {
      async find(host) {
        return host.endsWith('jumia.mg') ? { id: 'i1', vaultId: 'v1', title: 'Jumia', host: 'jumia.mg', exactDomain: false } : null;
      },
      async reveal() {
        return { username: 'ana@example.com', password: 'S3cret!pass' };
      },
    };
    const { result, calls, questions } = run(
      [
        message([toolUse('a', 'use_saved_login', {})], 'tool_use'),
        message([toolUse('b', 'finish', { summary: 'Connecté à ton compte Jumia.', success: true })], 'tool_use'),
      ],
      { session, credentials },
    );

    expect(await result).toMatchObject({ status: 'done' });
    expect(questions[0]).toMatchObject({ kind: 'login' });
    expect(questions[0]!.text).toContain('www.jumia.mg');
    expect(questions[0]!.text).toContain('« Jumia »');
    expect(actions).toEqual(['fillLogin ana@example.com']);
    expect(JSON.stringify(calls)).not.toContain('S3cret!pass');
  });

  it('ne remplit rien si la page a changé de domaine pendant la demande d’accord', async () => {
    const page = fakeSession({}, 'https://www.jumia.mg/login');
    const credentials: CredentialBroker = {
      async find() {
        return { id: 'i1', vaultId: 'v1', title: 'Jumia', host: 'jumia.mg', exactDomain: false };
      },
      async reveal() {
        throw new Error('ne doit pas être appelé');
      },
    };
    const { result, calls } = run(
      [
        message([toolUse('a', 'use_saved_login', {})], 'tool_use'),
        message([toolUse('b', 'finish', { summary: 'Page suspecte, je me suis arrêté.', success: false })], 'tool_use'),
      ],
      {
        session: page.session,
        credentials,
        ask: async () => {
          page.setUrl('https://jumia.mg.connexion-securisee.com/login');
          return 'yes';
        },
      },
    );

    await result;
    expect(page.actions).toEqual([]);
    expect(String(toolResults(calls, 1)[0]!.content)).toContain('La page a changé');
  });

  it("s'arrête à la limite de coût et sur annulation", async () => {
    const costly = run([message([toolUse('a', 'scroll', { direction: 'down' })], 'tool_use')], {
      session: fakeSession({}).session,
      maxCostUsd: 0.000_001,
    });
    expect(await costly.result).toMatchObject({ status: 'stopped' });
    expect((await costly.result).summary).toContain('limite de coût');

    const controller = new AbortController();
    controller.abort();
    const cancelled = run([], { session: fakeSession({}).session, signal: controller.signal });
    expect(await cancelled.result).toMatchObject({ status: 'stopped', summary: 'Tâche annulée à ta demande.' });
    expect(cancelled.calls).toHaveLength(0);
  });
});
