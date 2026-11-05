import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { blockedUrlReason, navigationBlockedReason } from './guards.js';

// Navigateur piloté par Playwright. La page est décrite au modèle comme une liste d'éléments
// interactifs numérotés ([12] bouton « Rechercher »…) : bien moins cher que des captures d'écran,
// et utilisable avec n'importe quel modèle. Les numéros changent à chaque état de page.

export interface PageState {
  url: string;
  title: string;
  /** Liste lisible des éléments interactifs, une ligne par élément. */
  elements: string;
  /** Début du texte visible, pour s'orienter. */
  text: string;
}

export interface ElementInfo {
  ref: number;
  tag: string;
  role: string;
  name: string;
  password: boolean;
}

export interface BrowserSession {
  /** Vrai si la fenêtre est visible : la personne peut alors prendre la main. */
  readonly headed: boolean;
  navigate(url: string): Promise<PageState>;
  state(): Promise<PageState>;
  element(ref: number): Promise<ElementInfo | null>;
  click(ref: number): Promise<PageState>;
  type(ref: number, text: string, submit: boolean): Promise<PageState>;
  select(ref: number, option: string): Promise<PageState>;
  press(key: string): Promise<PageState>;
  scroll(direction: 'up' | 'down'): Promise<PageState>;
  back(): Promise<PageState>;
  readText(maxChars?: number): Promise<string>;
  screenshot(): Promise<Buffer>;
  currentUrl(): string;
  /** Remplit un formulaire de connexion (identifiants venant du gestionnaire de mots de passe). */
  fillLogin(username: string, password: string): Promise<'filled' | 'no_form'>;
  close(): Promise<void>;
}

export interface BrowserEngine {
  readonly headed: boolean;
  /** Ouvre le navigateur sur le profil persistant de la personne (cookies et sessions gardés). */
  open(profileId: string): Promise<BrowserSession>;
}

/** Erreur à renvoyer telle quelle au modèle (élément introuvable, adresse interdite…). */
export class BrowserActionError extends Error {}

const MAX_ELEMENTS = 120;
const STATE_TEXT_CHARS = 1_500;

// Script exécuté dans la page (chaîne : pas de types DOM côté Node). Il numérote les éléments
// interactifs visibles avec un attribut data-koto-ref et renvoie leur description.
const SNAPSHOT_SCRIPT = `(maxElements) => {
  document.querySelectorAll('[data-koto-ref]').forEach((el) => el.removeAttribute('data-koto-ref'));
  const selector = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox], [role=switch], [contenteditable=""], [contenteditable=true], [onclick]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
      if (text.trim()) return text;
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && label.innerText) return label.innerText;
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.innerText && wrapping !== el) return wrapping.innerText;
    // Le texte d'une liste déroulante est celui de toutes ses options : on ne s'en sert pas comme nom.
    const own = el.tagName === 'SELECT' ? '' : el.innerText;
    return own || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (el.tagName === 'SELECT' ? '' : el.value) || el.getAttribute('name') || '';
  };
  const items = [];
  let total = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    total++;
    if (items.length >= maxElements) continue;
    const ref = items.length + 1;
    el.setAttribute('data-koto-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const password = tag === 'input' && type === 'password';
    let value = '';
    if (tag === 'input' || tag === 'textarea') value = password ? (el.value ? '••••' : '') : el.value;
    if (tag === 'select') value = (el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].text) || '';
    items.push({
      ref, tag, type, role: el.getAttribute('role') || '', name: clean(labelOf(el)), value: clean(value), password,
      checked: type === 'checkbox' || type === 'radio' ? el.checked : null,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      href: tag === 'a' ? String(el.getAttribute('href') || '').slice(0, 100) : '',
      options: tag === 'select' ? el.options.length : 0,
    });
  }
  const text = String((document.body && document.body.innerText) || '').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
  return { items, total, text };
}`;

interface SnapshotItem {
  ref: number;
  tag: string;
  type: string;
  role: string;
  name: string;
  value: string;
  password: boolean;
  checked: boolean | null;
  disabled: boolean;
  href: string;
  options: number;
}

function kindOf(item: SnapshotItem): string {
  if (item.tag === 'a' || item.role === 'link') return 'lien';
  if (item.tag === 'select' || item.role === 'combobox') return 'liste';
  if (item.type === 'checkbox' || item.role === 'checkbox' || item.role === 'switch') return 'case à cocher';
  if (item.type === 'radio' || item.role === 'radio') return 'bouton radio';
  if (item.tag === 'textarea') return 'zone de texte';
  if (item.tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(item.type)) return 'bouton';
  if (item.tag === 'input') return item.password ? 'champ mot de passe' : `champ ${item.type || 'texte'}`;
  if (item.role === 'textbox') return 'champ texte';
  return 'bouton';
}

/** Une ligne par élément, ex : « [5] champ texte « Destination » = "Paris" ». */
export function describeItem(item: SnapshotItem): string {
  const kind = kindOf(item);
  let line = `[${item.ref}] ${kind} « ${item.name || '(sans nom)'} »`;
  // La valeur des cases et boutons radio est technique (« on ») : seul l'état coché compte.
  const showsValue = !['bouton', 'lien', 'case à cocher', 'bouton radio'].includes(kind);
  if (item.value && showsValue) line += ` = "${item.value}"`;
  if (item.checked !== null) line += item.checked ? ' (coché)' : ' (non coché)';
  if (item.options) line += ` (${item.options} options)`;
  if (item.href && kind === 'lien') line += ` → ${item.href}`;
  if (item.disabled) line += ' (désactivé)';
  return line;
}

class PlaywrightSession implements BrowserSession {
  private page: Page;

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    readonly headed: boolean,
    private readonly allowPrivateNetwork: boolean,
  ) {
    this.page = page;
    this.watch(page);
    // Un lien qui ouvre un nouvel onglet : on suit l'onglet le plus récent.
    context.on('page', (newPage) => {
      this.page = newPage;
      this.watch(newPage);
    });
  }

  private watch(page: Page): void {
    // Les boîtes de dialogue (alert, confirm) sont refusées : rien ne se valide en douce.
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
    await this.page.waitForTimeout(700);
  }

  private locate(ref: number) {
    return this.page.locator(`[data-koto-ref="${ref}"]`).first();
  }

  private async ensureExists(ref: number): Promise<void> {
    if ((await this.locate(ref).count()) === 0) {
      throw new BrowserActionError(`Élément [${ref}] introuvable : la page a changé, utilise les numéros du dernier état.`);
    }
  }

  async state(): Promise<PageState> {
    const snapshot = (await this.page.evaluate(`(${SNAPSHOT_SCRIPT})(${MAX_ELEMENTS})`)) as {
      items: SnapshotItem[];
      total: number;
      text: string;
    };
    const lines = snapshot.items.map(describeItem);
    if (snapshot.total > snapshot.items.length) {
      lines.push(`… ${snapshot.total - snapshot.items.length} éléments de plus : fais défiler (scroll) ou lis la page (read_page).`);
    }
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      elements: lines.join('\n') || '(aucun élément interactif visible)',
      text: snapshot.text.slice(0, STATE_TEXT_CHARS),
    };
  }

  async navigate(url: string): Promise<PageState> {
    if (!this.allowPrivateNetwork) {
      const reason = await navigationBlockedReason(url);
      if (reason) throw new BrowserActionError(`Navigation refusée (${reason}).`);
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.settle();
    return this.state();
  }

  async element(ref: number): Promise<ElementInfo | null> {
    return (await this.page.evaluate(`(() => {
      const el = document.querySelector('[data-koto-ref="${ref}"]');
      if (!el) return null;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      return { ref: ${ref}, tag, role: el.getAttribute('role') || '', name, password: tag === 'input' && type === 'password' };
    })()`)) as ElementInfo | null;
  }

  async click(ref: number): Promise<PageState> {
    await this.ensureExists(ref);
    await this.locate(ref).click({ timeout: 10_000 });
    await this.settle();
    return this.state();
  }

  async type(ref: number, text: string, submit: boolean): Promise<PageState> {
    await this.ensureExists(ref);
    const field = this.locate(ref);
    await field.fill(text, { timeout: 10_000 });
    if (submit) await field.press('Enter');
    await this.settle();
    return this.state();
  }

  async select(ref: number, option: string): Promise<PageState> {
    await this.ensureExists(ref);
    const list = this.locate(ref);
    await list.selectOption({ label: option }, { timeout: 5_000 }).catch(() => list.selectOption(option, { timeout: 5_000 }));
    await this.settle();
    return this.state();
  }

  async press(key: string): Promise<PageState> {
    await this.page.keyboard.press(key);
    await this.settle();
    return this.state();
  }

  async scroll(direction: 'up' | 'down'): Promise<PageState> {
    await this.page.mouse.wheel(0, direction === 'down' ? 700 : -700);
    await this.page.waitForTimeout(400);
    return this.state();
  }

  async back(): Promise<PageState> {
    await this.page.goBack({ timeout: 10_000 }).catch(() => null);
    await this.settle();
    return this.state();
  }

  async readText(maxChars = 8_000): Promise<string> {
    const text = (await this.page.evaluate(`String((document.body && document.body.innerText) || '')`)) as string;
    const compact = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return compact.length > maxChars ? `${compact.slice(0, maxChars)}\n… [texte tronqué]` : compact;
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'jpeg', quality: 55 });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async fillLogin(username: string, password: string): Promise<'filled' | 'no_form'> {
    const passwordField = () => this.page.locator('input[type="password"]:visible').first();
    const usernameField = this.page
      .locator(
        'input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="user" i]:visible, input[name*="login" i]:visible, input[name*="email" i]:visible, input[id*="user" i]:visible, input[id*="email" i]:visible, input[type="text"]:visible, input[type="tel"]:visible',
      )
      .first();

    // Connexion en deux temps (identifiant, puis mot de passe sur l'écran suivant).
    if ((await passwordField().count()) === 0) {
      if ((await usernameField.count()) === 0) return 'no_form';
      await usernameField.fill(username);
      await usernameField.press('Enter');
      await passwordField().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      if ((await passwordField().count()) === 0) return 'no_form';
    } else if ((await usernameField.count()) > 0 && username) {
      await usernameField.fill(username);
    }
    await passwordField().fill(password);
    await passwordField().press('Enter');
    await this.settle();
    return 'filled';
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}

export interface PlaywrightEngineOptions {
  /** Dossier des profils (un sous-dossier par personne). */
  dataDir: string;
  headed: boolean;
  /** « chrome » = le Chrome installé ; null = le Chromium de Playwright, qui sert aussi de repli. */
  channel: string | null;
  /** Prévenu une seule fois quand le canal demandé n'est pas installé et que Chromium prend le relais. */
  onFallback?: (channel: string) => void;
  /** Tests uniquement : autorise localhost et le réseau privé. */
  allowPrivateNetwork?: boolean;
}

// Messages de Playwright : canal absent (Chrome n'existe pas sur Linux ARM, par exemple)
// ou Chromium de Playwright pas encore téléchargé.
const CHANNEL_MISSING = /Chromium distribution '[^']*' is not (found|supported)/;
const CHROMIUM_MISSING = /Executable doesn't exist/;

/**
 * Lance le navigateur du canal demandé ; s'il n'est pas installé, le Chromium de Playwright.
 * Renvoie aussi le canal réellement utilisé (null = Chromium).
 */
export async function launchWithFallback<T>(
  channel: string | null,
  launch: (channel: string | null) => Promise<T>,
): Promise<{ result: T; channel: string | null }> {
  if (channel) {
    try {
      return { result: await launch(channel), channel };
    } catch (err) {
      if (!CHANNEL_MISSING.test(errorMessage(err))) throw err;
    }
  }
  try {
    return { result: await launch(null), channel: null };
  } catch (err) {
    if (!CHROMIUM_MISSING.test(errorMessage(err))) throw err;
    throw new Error(
      `Aucun navigateur installé${channel ? ` (ni ${channel}, ni le Chromium de Playwright)` : ''} : lance « npx playwright install --with-deps chromium »`,
      { cause: err },
    );
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createPlaywrightEngine(options: PlaywrightEngineOptions): BrowserEngine {
  const allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  // Une fois le repli constaté, on ne réessaie plus le canal absent.
  let channel = options.channel;
  return {
    headed: options.headed,
    async open(profileId) {
      const dir = join(options.dataDir, profileId.replace(/[^a-zA-Z0-9_-]/g, '_'));
      mkdirSync(dir, { recursive: true });
      const launched = await launchWithFallback(channel, (candidate) =>
        chromium.launchPersistentContext(dir, {
          headless: !options.headed,
          ...(candidate ? { channel: candidate } : {}),
          viewport: { width: 1280, height: 860 },
          locale: 'fr-FR',
          acceptDownloads: false,
        }),
      );
      if (channel && launched.channel === null) {
        options.onFallback?.(channel);
        channel = null;
      }
      const context = launched.result;
      if (!allowPrivateNetwork) {
        // Aussi pour les sous-requêtes (images, scripts, formulaires) : jamais le réseau local.
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (/^file:/i.test(url) || (/^https?:/i.test(url) && blockedUrlReason(url))) return route.abort('blockedbyclient');
          return route.continue();
        });
      }
      const page = context.pages()[0] ?? (await context.newPage());
      return new PlaywrightSession(context, page, options.headed, allowPrivateNetwork);
    },
  };
}
