import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml, splitForTelegram } from '../src/bot/format.js';

describe('markdownToTelegramHtml', () => {
  it('convertit le Markdown léger que Koto écrit', () => {
    expect(markdownToTelegramHtml('**Gras** et _italique_ et `code`')).toBe('<b>Gras</b> et <i>italique</i> et <code>code</code>');
  });

  it('échappe le HTML et laisse les noms_en_snake_case intacts', () => {
    expect(markdownToTelegramHtml('a < b && c > d, mon_fichier_test.ts')).toBe('a &lt; b &amp;&amp; c &gt; d, mon_fichier_test.ts');
  });

  it('gère liens, listes et blocs de code', () => {
    const html = markdownToTelegramHtml('- [Doc](https://ex.com/a?b=1&c=2)\n* point\n```ts\nconst a = 1 < 2;\n```');
    expect(html).toContain('• <a href="https://ex.com/a?b=1&amp;c=2">Doc</a>');
    expect(html).toContain('• point');
    expect(html).toContain('<pre>const a = 1 &lt; 2;</pre>');
  });
});

describe('splitForTelegram', () => {
  it('découpe entre les paragraphes', () => {
    const paragraph = 'x'.repeat(2000);
    const chunks = splitForTelegram(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 3500);
    expect(chunks).toEqual([paragraph, paragraph, paragraph]);
  });

  it('coupe net un bloc sans espace', () => {
    const chunks = splitForTelegram('y'.repeat(8000), 3500);
    expect(chunks.map((c) => c.length)).toEqual([3500, 3500, 1000]);
  });
});
