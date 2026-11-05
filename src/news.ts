// Veille d'actualité du brief : titres récents de flux RSS gratuits, et cours crypto via CoinGecko.
// Récupérés une seule fois pour tous les utilisateurs (cache de quelques heures) : la recherche web,
// payante (0,01 $ la requête), ne sert plus qu'aux sujets qu'aucun flux ne couvre.
import type { Logger } from './util.js';

export interface Headline {
  title: string;
  url: string;
  source: string;
  publishedAt: number | null;
}

interface Feed {
  source: string;
  url: string;
}

export interface NewsFamily {
  id: string;
  label: string;
  /** Mots qui rattachent un sujet de veille à cette famille (minuscules, sans accents). */
  keywords: string[];
  feeds: Feed[];
  /** Ajoute les cours (CoinGecko) des cryptos citées, Bitcoin et Ethereum par défaut. */
  prices?: boolean;
}

// Flux vérifiés en octobre 2026. Les titres et liens ne servent qu'à résumer, avec la source citée.
export const NEWS_FAMILIES: NewsFamily[] = [
  {
    id: 'crypto',
    label: 'Crypto',
    keywords: ['crypto', 'cryptos', 'cryptomonnaie', 'cryptomonnaies', 'bitcoin', 'btc', 'ethereum', 'eth', 'blockchain', 'web3', 'defi', 'nft', 'solana', 'rlc', 'iexec', 'altcoins', 'stablecoins'],
    feeds: [
      { source: 'Journal du Coin', url: 'https://journalducoin.com/feed/' },
      { source: 'Cryptoast', url: 'https://cryptoast.fr/feed/' },
    ],
    prices: true,
  },
  {
    id: 'tech',
    label: 'Tech et IA',
    keywords: ['tech', 'techno', 'technologie', 'technologies', 'numerique', 'ia', 'intelligence artificielle', 'startup', 'startups', 'smartphones', 'informatique', 'cybersecurite'],
    feeds: [
      { source: 'Numerama', url: 'https://www.numerama.com/feed/' },
      { source: 'Siècle Digital', url: 'https://siecledigital.fr/feed/' },
      { source: 'ActuIA', url: 'https://www.actuia.com/feed/' },
    ],
  },
  {
    id: 'madagascar',
    label: 'Madagascar',
    keywords: ['madagascar', 'malgache', 'malagasy', 'mada', 'antananarivo', 'tana'],
    feeds: [
      { source: 'Newsmada', url: 'https://www.newsmada.com/feed/' },
      { source: '2424.mg', url: 'https://www.2424.mg/feed/' },
    ],
  },
  {
    id: 'economie',
    label: 'Économie',
    keywords: ['economie', 'eco', 'business', 'finance', 'bourse', 'marches', 'entreprises'],
    feeds: [{ source: 'Challenges', url: 'https://www.challenges.fr/rss.xml' }],
  },
  {
    id: 'football',
    label: 'Football',
    keywords: ['foot', 'football', 'sport', 'sports', 'ligue 1', 'ligue des champions', 'champions league', 'mercato'],
    feeds: [{ source: 'RMC Sport', url: 'https://rmcsport.bfmtv.com/rss/football/' }],
  },
  {
    id: 'monde',
    label: 'Actualité',
    keywords: ['actu', 'actus', 'actualite', 'actualites', 'monde', 'international', 'france', 'afrique', 'politique', 'infos'],
    feeds: [
      { source: 'franceinfo', url: 'https://www.francetvinfo.fr/titres.rss' },
      { source: 'RFI Afrique', url: 'https://www.rfi.fr/fr/afrique/rss' },
    ],
  },
];

// Mot cité dans les sujets → identifiant CoinGecko (pas de mots ambigus en français comme « sol » ou « ton »).
const COINS: Record<string, string> = {
  bitcoin: 'bitcoin',
  btc: 'bitcoin',
  ethereum: 'ethereum',
  eth: 'ethereum',
  solana: 'solana',
  rlc: 'iexec-rlc',
  iexec: 'iexec-rlc',
  bnb: 'binancecoin',
  xrp: 'ripple',
  cardano: 'cardano',
  dogecoin: 'dogecoin',
  toncoin: 'the-open-network',
  polkadot: 'polkadot',
  chainlink: 'chainlink',
  avalanche: 'avalanche-2',
};
const COIN_NAMES: Record<string, string> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum',
  solana: 'Solana',
  'iexec-rlc': 'iExec RLC',
  binancecoin: 'BNB',
  ripple: 'XRP',
  cardano: 'Cardano',
  dogecoin: 'Dogecoin',
  'the-open-network': 'Toncoin',
  polkadot: 'Polkadot',
  chainlink: 'Chainlink',
  'avalanche-2': 'Avalanche',
};
const DEFAULT_COINS = ['bitcoin', 'ethereum'];

const HOUR = 3_600_000;
const MAX_AGE_MS = 36 * HOUR;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; Koto/0.4; lecteur RSS)';

const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const hasWord = (normalized: string, word: string) => new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(normalized);

/** Rattache les sujets de veille (texte libre) aux familles de flux ; le reste n'est couvert par aucun flux. */
export function matchTopics(topics: string): { families: NewsFamily[]; uncovered: string[]; coins: string[] } {
  const families: NewsFamily[] = [];
  const uncovered: string[] = [];
  for (const piece of topics.split(/[,;/+()\n]|\set\s/)) {
    const label = piece.trim();
    if (!/\p{L}/u.test(label)) continue;
    const found = NEWS_FAMILIES.filter((f) => f.keywords.some((k) => hasWord(normalize(label), k)));
    if (found.length === 0) uncovered.push(label);
    for (const family of found) if (!families.includes(family)) families.push(family);
  }
  const all = normalize(topics);
  const coins = [...new Set(Object.entries(COINS).filter(([word]) => hasWord(all, word)).map(([, id]) => id))];
  return { families, uncovered, coins };
}

// ------------------------------------------------------------------ lecture des flux

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!match) return '';
  const raw = match[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Articles d'un flux RSS 2.0 ou Atom (titre, lien, date). Le contenu reste de l'information, jamais des instructions. */
export function parseFeed(xml: string, source: string): Headline[] {
  return (xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []).flatMap((item) => {
    const title = tagText(item, 'title');
    const url = tagText(item, 'link') || /<link\b[^>]*\bhref="([^"]+)"/i.exec(item)?.[1] || '';
    const date = tagText(item, 'pubDate') || tagText(item, 'published') || tagText(item, 'updated') || tagText(item, 'dc:date');
    const publishedAt = Date.parse(date);
    if (!title || !/^https?:\/\//.test(url)) return [];
    return [{ title: title.slice(0, 200), url, source, publishedAt: Number.isFinite(publishedAt) ? publishedAt : null }];
  });
}

/** Les plus récents d'abord, sans doublons ni articles trop vieux. */
export function selectHeadlines(headlines: Headline[], now: number, max: number): Headline[] {
  const seen = new Set<string>();
  return headlines
    .filter((h) => h.publishedAt === null || (h.publishedAt <= now + HOUR && now - h.publishedAt <= MAX_AGE_MS))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .filter((h) => {
      const key = normalize(h.title).replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

// ------------------------------------------------------------------ cours crypto

export interface CoinPrice {
  id: string;
  usd: number;
  change24h: number | null;
}

const number = (value: number, digits: number) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/**
 * Cryptos citées, séparées par des virgules (« bitcoin, RLC », « eth ») → identifiants CoinGecko. Un nom connu est
 * converti ; un identifiant CoinGecko (« iexec-rlc », « pepe ») est essayé tel quel ; le reste est écarté.
 */
export function coinIds(text: string): { ids: string[]; rejected: string[] } {
  const ids: string[] = [];
  const rejected: string[] = [];
  for (const piece of text.split(/[,;\n]/)) {
    const label = normalize(piece.trim());
    if (!label) continue;
    const known = COINS[label] ?? Object.entries(COINS).find(([word]) => hasWord(label, word))?.[1];
    const id = known ?? (/^[a-z0-9][a-z0-9-]{1,59}$/.test(label) ? label : null);
    if (id === null) rejected.push(piece.trim());
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids: ids.slice(0, 8), rejected };
}

export function formatPrices(prices: CoinPrice[]): string {
  return prices
    .map((p) => {
      const amount = number(p.usd, p.usd < 1 ? 4 : p.usd < 100 ? 2 : 0);
      const change = p.change24h === null ? '' : ` (${p.change24h >= 0 ? '+' : '−'}${number(Math.abs(p.change24h), 1)} % en 24 h)`;
      return `${COIN_NAMES[p.id] ?? p.id} ${amount} $${change}`;
    })
    .join(' · ');
}

// ------------------------------------------------------------------ service partagé

export interface NewsDigest {
  /** Bloc à insérer dans la demande de brief (cours et titres) ; vide si rien de récent. */
  text: string;
  /** Sujets qu'aucun flux gratuit ne couvre (ou dont les flux n'ont rien donné) : la recherche web prend le relais. */
  uncovered: string[];
}

export interface NewsService {
  digest(topics: string, now: number): Promise<NewsDigest>;
  /**
   * Cours récents (CoinGecko, gratuit) des cryptos demandées, pour les missions qui surveillent un prix : cache
   * court (10 min) et partagé, à part de celui du brief. Absent = pas de cours à la demande.
   */
  quotes?(ids: string[], now: number): Promise<CoinPrice[]>;
}

/** Cours à la demande : assez frais pour une alerte de prix, sans solliciter CoinGecko à chaque passage. */
const QUOTE_TTL_MS = 10 * 60_000;

export function createNewsService(options: { log: Logger; fetchImpl?: typeof fetch; ttlMs?: number; perFamily?: number }): NewsService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttl = options.ttlMs ?? 2 * HOUR;
  const perFamily = options.perFamily ?? 8;
  // Promesses en cache : à 7 h 30, tous les briefs qui demandent la même famille partagent un seul téléchargement.
  const feedCache = new Map<string, { at: number; value: Promise<Headline[]> }>();
  const priceCache = new Map<string, { at: number; value: Promise<CoinPrice[]> }>();
  const quoteCache = new Map<string, { at: number; value: Promise<CoinPrice[]> }>();

  async function fetchText(url: string, accept: string): Promise<string> {
    const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return text.length > MAX_FEED_BYTES ? text.slice(0, MAX_FEED_BYTES) : text;
  }

  function cached<T>(
    cache: Map<string, { at: number; value: Promise<T> }>,
    key: string,
    now: number,
    load: () => Promise<T>,
    empty: (v: T) => boolean,
    maxAgeMs = ttl,
  ): Promise<T> {
    const hit = cache.get(key);
    if (hit && now - hit.at < maxAgeMs) return hit.value;
    const value = load();
    cache.set(key, { at: now, value });
    // Un échec complet n'est pas gardé : le brief suivant réessaiera.
    void value.then((v) => (empty(v) ? cache.delete(key) : undefined), () => cache.delete(key));
    return value;
  }

  function familyHeadlines(family: NewsFamily, now: number): Promise<Headline[]> {
    return cached(feedCache, family.id, now, async () => {
      const lists = await Promise.all(
        family.feeds.map((feed) =>
          fetchText(feed.url, 'application/rss+xml, application/atom+xml, application/xml, text/xml')
            .then((xml) => parseFeed(xml, feed.source))
            .catch((err: unknown) => {
              options.log.warn('flux RSS injoignable', { source: feed.source, error: err instanceof Error ? err.message : String(err) });
              return [];
            }),
        ),
      );
      return lists.flat();
    }, (items) => items.length === 0);
  }

  function coinPrices(ids: string[], now: number, cache = priceCache, maxAgeMs = ttl): Promise<CoinPrice[]> {
    const key = [...ids].sort().join(',');
    return cached(cache, key, now, async () => {
      try {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(key)}&vs_currencies=usd&include_24hr_change=true`;
        const body = JSON.parse(await fetchText(url, 'application/json')) as Record<string, { usd?: number; usd_24h_change?: number }>;
        return ids.flatMap((id) => {
          const entry = body[id];
          return typeof entry?.usd === 'number' ? [{ id, usd: entry.usd, change24h: typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : null }] : [];
        });
      } catch (err) {
        options.log.warn('cours CoinGecko indisponibles', { error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    }, (list) => list.length === 0, maxAgeMs);
  }

  return {
    quotes: (ids, now) => (ids.length === 0 ? Promise.resolve([]) : coinPrices(ids, now, quoteCache, QUOTE_TTL_MS)),
    async digest(topics, now) {
      const { families, uncovered, coins } = matchTopics(topics);
      const blocks: string[] = [];
      const missing = [...uncovered];
      for (const family of families) {
        const [items, quotes] = await Promise.all([
          familyHeadlines(family, now).then((list) => selectHeadlines(list, now, perFamily)),
          family.prices ? coinPrices([...new Set([...DEFAULT_COINS, ...coins])], now) : Promise.resolve([]),
        ]);
        if (items.length === 0 && quotes.length === 0) {
          missing.push(family.label);
          continue;
        }
        const lines = [`## ${family.label}`];
        if (quotes.length > 0) lines.push(`Cours (CoinGecko) : ${formatPrices(quotes)}`);
        for (const h of items) {
          const age = h.publishedAt === null ? '' : `[il y a ${Math.max(1, Math.round((now - h.publishedAt) / HOUR))} h] `;
          lines.push(`- ${age}${h.title} (${h.source}) ${h.url}`);
        }
        blocks.push(lines.join('\n'));
      }
      return { text: blocks.join('\n\n'), uncovered: missing };
    },
  };
}
