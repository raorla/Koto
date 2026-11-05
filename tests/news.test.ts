import { describe, expect, it, vi } from 'vitest';
import { createNewsService, formatPrices, matchTopics, parseFeed, selectHeadlines } from '../src/news.js';
import { silentLogger } from '../src/util.js';
import { NOW } from './helpers.js';

const HOUR = 3_600_000;
const rssDate = (t: number) => new Date(t).toUTCString();

const RSS = `<?xml version="1.0"?><rss><channel><title>Journal du Coin</title>
<item><title><![CDATA[Le Bitcoin repasse les 80 000 $]]></title><link>https://journalducoin.com/a</link><pubDate>${rssDate(NOW - 2 * HOUR)}</pubDate></item>
<item><title>La SEC valide l&#8217;ETF Solana &amp; plus</title><link>https://journalducoin.com/b</link><pubDate>${rssDate(NOW - 5 * HOUR)}</pubDate></item>
<item><title>Vieille info</title><link>https://journalducoin.com/c</link><pubDate>${rssDate(NOW - 72 * HOUR)}</pubDate></item>
</channel></rss>`;

const ATOM = `<feed><title>Blog</title><entry><title>Nouvelle IA open source</title><link rel="alternate" href="https://exemple.com/ia"/><updated>${new Date(NOW - HOUR).toISOString()}</updated></entry></feed>`;

describe('sujets de veille', () => {
  it('rattache les sujets aux flux gratuits et repère les cryptos citées', () => {
    const { families, uncovered, coins } = matchTopics('crypto (Bitcoin, Ethereum, RLC), IA et pêche sous-marine');
    expect(families.map((f) => f.id)).toEqual(['crypto', 'tech']);
    expect(uncovered).toEqual(['pêche sous-marine']);
    expect(coins).toEqual(['bitcoin', 'ethereum', 'iexec-rlc']);
  });

  it('ne confond pas un mot qui contient un mot-clé', () => {
    expect(matchTopics('cryptographie quantique').families).toEqual([]);
    expect(matchTopics('économie malgache').families.map((f) => f.id)).toEqual(['madagascar', 'economie']);
  });
});

describe('lecture des flux', () => {
  it('lit le RSS 2.0 (CDATA, entités) et l’Atom', () => {
    expect(parseFeed(RSS, 'Journal du Coin').slice(0, 2)).toEqual([
      { title: 'Le Bitcoin repasse les 80 000 $', url: 'https://journalducoin.com/a', source: 'Journal du Coin', publishedAt: NOW - 2 * HOUR },
      { title: 'La SEC valide l’ETF Solana & plus', url: 'https://journalducoin.com/b', source: 'Journal du Coin', publishedAt: NOW - 5 * HOUR },
    ]);
    expect(parseFeed(ATOM, 'Blog')).toEqual([{ title: 'Nouvelle IA open source', url: 'https://exemple.com/ia', source: 'Blog', publishedAt: NOW - HOUR }]);
  });

  it('garde les titres récents, du plus frais au plus ancien, sans doublons', () => {
    const items = [...parseFeed(RSS, 'A'), { title: 'Le Bitcoin repasse les 80 000 $ !', url: 'https://autre.com/x', source: 'B', publishedAt: NOW - HOUR }];
    expect(selectHeadlines(items, NOW, 5).map((h) => h.url)).toEqual(['https://autre.com/x', 'https://journalducoin.com/b']);
  });

  it('formate les cours à la française', () => {
    const text = formatPrices([{ id: 'bitcoin', usd: 81811.4, change24h: -1.708 }, { id: 'iexec-rlc', usd: 0.821251, change24h: 6.04 }]);
    // Séparateur de milliers français : espace fine insécable.
    expect(text.replace(/ /g, ' ')).toBe('Bitcoin 81 811 $ (−1,7 % en 24 h) · iExec RLC 0,8213 $ (+6 % en 24 h)');
  });
});

describe('service de veille', () => {
  function fakeFetch() {
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('coingecko')) {
        return new Response(JSON.stringify({ bitcoin: { usd: 81811, usd_24h_change: -1.7 }, ethereum: { usd: 2430, usd_24h_change: 0.4 } }));
      }
      if (u.includes('journalducoin')) return new Response(RSS);
      return new Response('indisponible', { status: 503 });
    });
  }

  it('assemble cours et titres, et signale ce qu’aucun flux ne couvre', async () => {
    const fetchImpl = fakeFetch();
    const news = createNewsService({ log: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const digest = await news.digest('crypto, pêche sous-marine', NOW);

    expect(digest.text).toContain('## Crypto');
    expect(digest.text).toMatch(/Cours \(CoinGecko\) : Bitcoin .*\$ \(−1,7 % en 24 h\) · Ethereum/);
    expect(digest.text).toContain('- [il y a 2 h] Le Bitcoin repasse les 80 000 $ (Journal du Coin) https://journalducoin.com/a');
    expect(digest.text).not.toContain('Vieille info');
    expect(digest.uncovered).toEqual(['pêche sous-marine']);
  });

  it('télécharge une seule fois pour tous les utilisateurs pendant la durée du cache', async () => {
    const fetchImpl = fakeFetch();
    const news = createNewsService({ log: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await Promise.all([news.digest('crypto', NOW), news.digest('Bitcoin', NOW), news.digest('crypto', NOW + HOUR)]);

    // 2 flux crypto + 1 appel CoinGecko, quel que soit le nombre de briefs.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('se rabat sur la recherche web quand les flux d’un sujet ne répondent pas', async () => {
    const fetchImpl = vi.fn(async () => new Response('panne', { status: 500 }));
    const news = createNewsService({ log: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const digest = await news.digest('football', NOW);

    expect(digest).toEqual({ text: '', uncovered: ['Football'] });
  });
});
