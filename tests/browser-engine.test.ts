import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaywrightEngine, launchWithFallback, type BrowserSession } from '../src/browser/engine.js';

// Vrai navigateur (Chrome installé) sur une petite page servie en local. Sauté si Chrome est absent.
const hasChrome = existsSync('/usr/bin/google-chrome') || existsSync('/usr/bin/google-chrome-stable');

const PAGE = `<!doctype html><html><head><title>Vols Tana</title></head><body>
  <h1>Chercher un vol</h1>
  <form action="/resultats">
    <label for="dest">Destination</label><input id="dest" name="dest">
    <select name="classe"><option>Économie</option><option>Affaires</option></select>
    <label><input type="checkbox" name="direct"> Vol direct</label>
    <button type="submit">Rechercher</button>
  </form>
  <a href="/compte">Mon compte</a>
  <button style="display:none">Caché</button>
</body></html>`;

const RESULTS = `<!doctype html><html><head><title>Résultats</title></head><body>
  <p>3 vols trouvés vers Paris</p><button>Payer 650 €</button>
  <form><input type="email" name="email"><input type="password" name="pwd"></form>
</body></html>`;

describe.skipIf(!hasChrome)('moteur de navigation (Chrome réel)', () => {
  let server: Server;
  let base = '';
  let dataDir = '';
  let session: BrowserSession;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url?.startsWith('/resultats') ? RESULTS : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    dataDir = mkdtempSync(join(tmpdir(), 'koto-browser-'));
    const engine = createPlaywrightEngine({ dataDir, headed: false, channel: 'chrome', allowPrivateNetwork: true });
    session = await engine.open('test-profile');
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('décrit la page en éléments numérotés, sans les éléments cachés', async () => {
    const state = await session.navigate(`${base}/`);
    expect(state.title).toBe('Vols Tana');
    expect(state.elements).toContain('[1] champ texte « Destination »');
    expect(state.elements).toContain('[2] liste « classe » = "Économie" (2 options)');
    expect(state.elements).toContain('case à cocher « Vol direct » (non coché)');
    expect(state.elements).toContain('bouton « Rechercher »');
    expect(state.elements).toContain('lien « Mon compte » → /compte');
    expect(state.elements).not.toContain('Caché');
    expect(state.text).toContain('Chercher un vol');
  }, 30_000);

  it('remplit, coche, choisit et soumet un formulaire', async () => {
    await session.navigate(`${base}/`);
    await session.type(1, 'Paris', false);
    const selected = await session.select(2, 'Affaires');
    expect(selected.elements).toContain('= "Affaires"');
    const checked = await session.click(3);
    expect(checked.elements).toContain('« Vol direct » (coché)');
    const results = await session.click(4);
    expect(results.url).toContain('/resultats?dest=Paris');
    expect(results.text).toContain('3 vols trouvés vers Paris');
  }, 30_000);

  it('signale les champs mot de passe et décrit les boutons', async () => {
    await session.navigate(`${base}/resultats`);
    const state = await session.state();
    const pay = state.elements.split('\n').find((line) => line.includes('Payer'))!;
    const ref = Number(/^\[(\d+)\]/.exec(pay)![1]);
    expect(await session.element(ref)).toMatchObject({ name: 'Payer 650 €', password: false });
    const pwdLine = state.elements.split('\n').find((line) => line.includes('mot de passe'))!;
    expect(await session.element(Number(/^\[(\d+)\]/.exec(pwdLine)![1]))).toMatchObject({ password: true });
    expect((await session.screenshot()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
  }, 30_000);

  it('refuse le réseau local quand la protection est active', async () => {
    const guarded = await createPlaywrightEngine({ dataDir, headed: false, channel: 'chrome' }).open('guarded');
    try {
      await expect(guarded.navigate(`${base}/`)).rejects.toThrow(/Navigation refusée/);
    } finally {
      await guarded.close();
    }
  }, 30_000);
});

describe('repli sur le Chromium de Playwright', () => {
  // Messages réels de Playwright quand Chrome n'est pas installé (serveur Linux ARM, par exemple).
  const chromeMissing = new Error(`browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome
Run "npx playwright install chrome"`);
  const chromiumMissing = new Error(`browserType.launchPersistentContext: Executable doesn't exist at /home/koto/.cache/ms-playwright/chromium-1248/chrome-linux/chrome`);

  it('garde Chrome quand il est installé', async () => {
    const tried: (string | null)[] = [];
    const launched = await launchWithFallback('chrome', async (channel) => {
      tried.push(channel);
      return 'navigateur';
    });
    expect(launched).toEqual({ result: 'navigateur', channel: 'chrome' });
    expect(tried).toEqual(['chrome']);
  });

  it('passe au Chromium de Playwright quand Chrome est absent ou non pris en charge', async () => {
    for (const missing of [chromeMissing, new Error("Chromium distribution 'chrome' is not supported on linux")]) {
      const tried: (string | null)[] = [];
      const launched = await launchWithFallback('chrome', async (channel) => {
        tried.push(channel);
        if (channel) throw missing;
        return 'chromium';
      });
      expect(launched).toEqual({ result: 'chromium', channel: null });
      expect(tried).toEqual(['chrome', null]);
    }
  });

  it('ne masque pas une autre panne de Chrome par un repli', async () => {
    const tried: (string | null)[] = [];
    const crash = launchWithFallback('chrome', async (channel) => {
      tried.push(channel);
      throw new Error('Target page, context or browser has been closed');
    });
    await expect(crash).rejects.toThrow(/has been closed/);
    expect(tried).toEqual(['chrome']);
  });

  it("dit comment installer Chromium quand aucun navigateur n'est là", async () => {
    const none = launchWithFallback('chrome', async (channel) => {
      throw channel ? chromeMissing : chromiumMissing;
    });
    await expect(none).rejects.toThrow(/ni chrome, ni le Chromium de Playwright.*npx playwright install --with-deps chromium/);
    await expect(launchWithFallback(null, async () => Promise.reject(chromiumMissing))).rejects.toThrow(
      /^Aucun navigateur installé : lance « npx playwright install --with-deps chromium »$/,
    );
  });
});
