import { defineConfig } from 'vitest/config';

// Quatre niveaux de tests, chacun lançable seul (voir les scripts test:* de package.json) :
// - unit : une brique à la fois (fonctions pures, outils sur une base SQLite en mémoire, services
//   externes simulés) ;
// - integration : plusieurs briques réelles ensemble (boucle de l'agent, bot grammY, scheduler, vrai
//   Chrome, vraies sauvegardes sur disque) ;
// - system : le vrai processus Koto (src/index.ts) face à un faux Telegram et un faux OpenRouter locaux ;
// - live : les vrais services avec les clés de .env, à la demande seulement (quelques millièmes de dollar).
const INTEGRATION = [
  'tests/agent.test.ts',
  'tests/bot.test.ts',
  'tests/scheduler.test.ts',
  'tests/integrations.test.ts',
  'tests/browser-*.test.ts',
  'tests/backup.test.ts',
  'tests/group-*.test.ts',
  'tests/mission-*.test.ts',
  'tests/memory-*.test.ts',
  'tests/call-browser.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/*.test.ts'], exclude: INTEGRATION } },
      { test: { name: 'integration', include: INTEGRATION } },
      { test: { name: 'system', include: ['tests/system/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } },
      { test: { name: 'live', include: ['tests/live/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 60_000 } },
    ],
  },
});
