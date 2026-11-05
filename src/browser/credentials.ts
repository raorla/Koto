import { AutofillBehavior, DesktopAuth, ItemCategory, createClient } from '@1password/sdk';
import { hostMatches } from './guards.js';

// Pont vers 1Password : le modèle ne voit JAMAIS un secret. Il demande « connecte-toi avec
// l'identifiant enregistré » ; le code cherche l'identifiant du domaine affiché, la personne
// approuve sur Telegram, puis le code remplit le formulaire lui-même.

export interface SavedLogin {
  id: string;
  vaultId: string;
  title: string;
  /** Domaine enregistré dans 1Password pour cet identifiant. */
  host: string;
  exactDomain: boolean;
}

export interface CredentialBroker {
  /** Identifiant enregistré pour ce domaine : métadonnées seulement. */
  find(pageHost: string): Promise<SavedLogin | null>;
  /** Le secret, pour le remplissage par le code uniquement : jamais transmis au modèle ni journalisé. */
  reveal(login: SavedLogin): Promise<{ username: string; password: string }>;
}

function siteHost(url: string): string | null {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
}

/** Même règle que les gestionnaires de mots de passe : domaine exact ou sous-domaine, jamais un sosie. */
export function loginMatchesPage(login: Pick<SavedLogin, 'host' | 'exactDomain'>, pageHost: string): boolean {
  if (login.exactDomain) return pageHost.toLowerCase().replace(/^www\./, '') === login.host.toLowerCase().replace(/^www\./, '');
  return hostMatches(pageHost, login.host);
}

export interface OnePasswordOptions {
  /** Jeton de compte de service (offres Teams/Business). */
  serviceAccountToken?: string;
  /** Nom du compte dans l'appli de bureau 1Password : chaque accès y est approuvé. */
  desktopAccount?: string;
}

export async function createOnePasswordBroker(options: OnePasswordOptions): Promise<CredentialBroker> {
  const auth = options.serviceAccountToken || (options.desktopAccount ? new DesktopAuth(options.desktopAccount) : undefined);
  if (!auth) throw new Error('1Password : ni jeton de compte de service ni compte de bureau configuré');
  const client = await createClient({ auth, integrationName: 'Koto', integrationVersion: '0.3.0' });

  return {
    async find(pageHost) {
      for (const vault of await client.vaults.list()) {
        for (const item of await client.items.list(vault.id)) {
          if (item.category !== ItemCategory.Login) continue;
          for (const website of item.websites) {
            if (website.autofillBehavior === AutofillBehavior.Never) continue;
            const host = siteHost(website.url);
            if (!host) continue;
            const login = {
              id: item.id,
              vaultId: vault.id,
              title: item.title,
              host,
              exactDomain: website.autofillBehavior === AutofillBehavior.ExactDomain,
            };
            if (loginMatchesPage(login, pageHost)) return login;
          }
        }
      }
      return null;
    },
    async reveal(login) {
      const item = await client.items.get(login.vaultId, login.id);
      const field = (id: string) => item.fields.find((f) => f.id === id)?.value;
      const username = field('username') ?? item.fields.find((f) => f.fieldType === 'Email' || f.fieldType === 'Text')?.value ?? '';
      const password = field('password') ?? item.fields.find((f) => f.fieldType === 'Concealed')?.value ?? '';
      if (!password) throw new Error('Cet identifiant 1Password ne contient pas de mot de passe');
      return { username, password };
    },
  };
}
