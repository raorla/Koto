# Koto

Agent personnel IA multi-utilisateurs sur Telegram. TypeScript (ESM, Node ≥ 22.13), grammY + @grammyjs/runner, @anthropic-ai/sdk (namespace beta), better-sqlite3, luxon, zod. Textes utilisateur et prompts en français.

## Commandes

- `npm test` : vitest, sans réseau, niveaux unit + integration + system (`vitest.config.ts`). Faux client API dans `tests/helpers.ts`, faux Telegram du bot dans `tests/support/bot.ts`, faux serveurs du test système dans `tests/system/support.ts`.
- `npm run test:unit` / `test:integration` / `test:system` : un niveau à la fois. `npm run test:live` : vrais services avec les clés de `.env` (~0,01 $), jamais dans `npm test`.
- `npm run typecheck` : TypeScript 7 (`tsc --noEmit`).
- `npm run dev` : le bot (il faut `.env`). `npm run cli` : discuter dans le terminal, sans Telegram.

## Invariants à ne pas casser

- **Préfixe de prompt partagé** : `STATIC_SYSTEM_PROMPT` (agent/prompt.ts) et le tableau d'outils (`buildTools`) sont identiques pour tous les utilisateurs et ne contiennent rien de dynamique. Tout ce qui est propre à une personne va dans `renderUserContext`, qui doit rester déterministe (dates absolues, ordre stable, pas de « maintenant »).
- **Ajout seul pendant un tour** : dans la boucle de `agent.ts`, `system`, `tools` et les messages déjà envoyés ne changent jamais. On renvoie `response.content` tel quel (blocs de réflexion compris), et tous les `tool_result` partent dans un seul message. Les tests vérifient que chaque requête est un préfixe de la suivante.
- **Isolation** : chaque méthode de `Store` qui touche aux données d'une personne prend `userId` et le met dans le `WHERE`. Les outils reçoivent `userId` du serveur, jamais du modèle. Un groupe est un compte à part (voir « Groupes ») : en groupe, `userId` est celui du groupe, jamais celui d'un membre.
- **Logs** : jamais de contenu de message ni de mémoire, seulement des ids, des statuts et des coûts.
- **Opus 5.5** : pas de `thinking` disabled ni de `budget_tokens`, pas de `tool_choice` forcé. L'effort se règle par `output_config.effort`. `fallbacks: "default"` reste activé, sous la beta `server-side-fallback-2026-07-01`.
- **Coût** : pour toute nouvelle source de coût, mettre à jour `agent/pricing.ts`, qui alimente le budget quotidien.
- **Deux fournisseurs, un seul SDK** : `llm.ts` branche le SDK Anthropic soit sur l'API Anthropic, soit sur OpenRouter (`https://openrouter.ai/api`, clé en `authToken`, `apiKey: null`). Les outils restent identiques, car OpenRouter accepte `web_search_20260209` et `web_fetch_20260209`. Seuls les paramètres de routage diffèrent (`routingParams` dans agent.ts) : `betas` et `fallbacks: "default"` pour Anthropic ; `session_id` et `provider.order` pour OpenRouter. Les ids de modèles se convertissent avec `models.ts`. Avec OpenRouter, `usage.cost` (le coût réel) prime sur l'estimation.

## Intégrations (Gmail, Google Agenda) et vocaux

- `integrations/types.ts` est la seule interface que le reste de Koto connaît ; `composio.ts` l'implémente. Il y a une session Composio par utilisateur, en preset `DIRECT_TOOLS`, exposée en MCP, et un client MCP officiel (`@modelcontextprotocol/sdk`) par utilisateur.
- **Identité Composio** : toujours `users.composio_user_id` (UUID `koto-…`), jamais l'id SQLite. Sinon l'utilisateur n°1 de `cli.db` et celui de `koto.db` partageraient les comptes Google.
- **Catalogue** : il est chargé une fois au démarrage, et les outils sont identiques pour tous, ce qui garde le cache de prompt. La liste et la politique de confirmation sont dans `integrations/catalog.ts` : tout ce qui n'est pas une lecture ou un brouillon passe par `pending_actions`, puis par le bouton `act:<id>:ok`. Un outil ajouté au catalogue est soumis à confirmation par défaut.
- **Exécution confirmée** : `confirmAction` réclame d'abord l'action en base (`claimPendingAction`, atomique), puis exécute. Le modèle ne déclenche jamais lui-même un envoi.
- **Vocaux** : `voice.ts` transcrit via OpenRouter (`/chat/completions`, `input_audio`). C'est un service de transcription, pas un appel à Claude.

## Réponses vocales et veille

- **Coût d'abord** : chaque fonctionnalité passe d'abord par ce qui est gratuit ou partagé, et ne garde le payant qu'en repli. Toute nouvelle source de coût entre dans le budget du jour via `addUsage` (le tarif vit dans `agent/pricing.ts`).
- `speech.ts` lit à voix haute via OpenRouter (`/audio/speech`, MP3, que Telegram accepte comme vocal). Il essaie la voix gratuite (`:free`, quota par compte), puis la voix de secours ; la gratuite est mise de côté 10 min après un échec. OpenRouter ne renvoie pas le coût : on l'estime au caractère avec le tarif du catalogue (tarif de repli élevé si le catalogue est injoignable).
- **Quand parler** : `voiceForReply`, `voiceForBrief` et `voiceForJob` (speech.ts) sont la seule source de vérité. Le texte part toujours d'abord, et un vocal raté ne fait jamais rejouer une tâche du scheduler (doublon). `toSpeechText` retire liens, émojis et Markdown.
- `news.ts` fournit la veille du brief : flux RSS fixés dans le code (pas d'URL venant du modèle ni de la personne) et cours CoinGecko, mis en cache 2 h et partagés entre utilisateurs. Les titres vont dans la demande de brief entre `<veille>`, comme de l'information, pas des instructions, et jamais dans l'historique. La recherche web ne sert qu'aux sujets sans flux, une seule fois par brief.

## Groupes

- **Un groupe est un compte** : une ligne `users` avec `kind = 'group'` (`telegram_id` = `chat_id` = id du groupe, négatif, `first_name` = titre). Sa mémoire, son historique, ses rappels et ses listes passent par les méthodes habituelles de `Store`, filtrées par son propre id : même isolation que pour une personne. `getUserByTelegramId` ne renvoie jamais un groupe, ni `getGroupByChatId` une personne.
- **Qui paie** : `owner_id` = la personne inscrite qui a ajouté Koto ou lui a parlé en premier. Tout coût d'un compte passe par `recordUsage` / `payerFor` (accounts.ts), qui l'envoie au budget de cette personne ; le contrôle du budget aussi (`guard`, scheduler). Sans payeur, rien de payant ne part ; les rappels, gratuits, si. Koto retiré ou payeur parti : `releaseGroup`, et les rappels à venir sont annulés au retrait.
- **Accès** (`bot/group.ts`) : seulement ce qui s'adresse à Koto (commande pour lui, @mention, réponse à l'un de ses messages, bouton), le reste est ignoré sans frais, même si Telegram le transmet. Jamais `ensureUser` ni `touchUser` avec un chat de groupe : le `chat_id` d'une personne deviendrait celui du groupe. On ne crée pas de compte de personne depuis un groupe.
- **Contexte** : en groupe, l'agent ne charge que le compte du groupe (`renderGroupContext`, déterministe). Chaque message porte le prénom Telegram de qui parle (`frameText`), jamais le nom d'usage réglé en privé. La consigne « Conversations de groupe » fait partie du prompt figé, pour tout le monde.
- **Outils** : les mêmes pour tous (cache). En groupe, `runTool` refuse Gmail, Agenda et `browse_web`, et `update_settings` refuse brief et veille, d'après le `kind` lu en base (pas d'après l'appelant).
- **Commandes** : `GROUP_COMMANDS` (menu `all_group_chats`) ; les commandes personnelles répondent « en privé » (`PRIVATE_ONLY_COMMANDS`). `/oublier_tout` d'un groupe : personne rattachée ou admin Telegram, vérifié aussi au clic du bouton.

## Listes, météo et export

- **Listes** (`list_items`) : comme le reste, toujours filtrées par `user_id`, y compris le bouton `li:<id>` (l'id d'une autre personne est ignoré). Les éléments ouverts sont rendus dans `<listes>` (renderUserContext), dans un ordre stable (liste, puis id).
- **Météo et lieux** (`weather.ts`) : MET Norway pour les prévisions (gratuit, même en usage commercial, en citant la source) et Nominatim d'OpenStreetMap pour les lieux (une requête par seconde au plus). Les deux exigent un User-Agent qui identifie Koto : on utilise le lien du bot. Les prévisions sont en cache 1 h par position arrondie à 2 décimales, et une position partagée est arrondie à ~1 km avant d'être enregistrée. Une question météo ne doit jamais passer par la recherche web.
- **Export** (`export.ts`) : il ne lit que par les méthodes de `Store` filtrées par `user_id`. `/oublier_tout` efface aussi les listes, la veille, le lieu, les missions et les tâches web terminées. Des groupes, l'export d'une personne ne donne que le nom de ceux qu'elle paie : leur contenu appartient au groupe.

## Appels en direct (mini-app Telegram)

- `src/call/` : page (`page.ts`, un seul fichier HTML sans dépendance), serveur (`server.ts`) et signature (`auth.ts`). Toute route sauf la page et `/sante` exige l'initData signée par Telegram (HMAC avec le token du bot, moins de 24 h), puis une personne inscrite. On vérifie ensuite son budget du jour et sa limite de débit.
- Le serveur écoute sur `127.0.0.1` : on l'expose par un tunnel ou un proxy HTTPS (`KOTO_PUBLIC_URL`). Les phrases arrivent en WAV 16 kHz (transcription au format `wav`) et sont limitées à 2 Mo. Les tours passent par l'agent avec le préfixe `[appel]` (consigne de réponse courte dans le prompt figé), et les coûts (transcription, voix) entrent dans `addUsage`.
- Le script de `page.ts` vit dans un gabarit TypeScript : ni accent grave ni `${`. On parle chacun son tour : la page n'écoute pas pendant que Koto parle.
- Une action à confirmer créée pendant un appel part en carte dans la conversation Telegram, jamais dans la page.

## Tests

- Quatre niveaux : unit (une brique), integration (briques réelles ensemble), system (le vrai `src/index.ts` dans un processus à part, face aux faux Telegram et OpenRouter de `tests/system/support.ts`) et live (vrais services). Toute nouvelle commande ou intégration ajoute un scénario au test système. Les groupes ont leurs aides de test : `groupTextUpdate` & co (`tests/support/bot.ts`), `addBotToGroup` / `sendGroupText` (faux Telegram du test système), `makeGroup` (`tests/helpers.ts`). Les missions ont les leurs : `missions` dans `setupBot` (`tests/support/bot.ts`) et les tests `tests/mission-*.test.ts` (niveau integration, motif de `vitest.config.ts`). La mémoire longue aussi : `tests/memory.test.ts` (unit), `tests/memory-*.test.ts` (integration), `makePdf` (`tests/support/pdf.ts`) et `sendDocument` / `addFile` / `removeFile` (faux Telegram du test système, dont `getFile` refuse un fichier inconnu comme un `file_id` expiré). Le test système limite chaque personne à 8 messages par minute (limite de débit du bot) : un nouveau scénario qui écrit beaucoup invite une autre personne (`/inviter`, voir le scénario `open_document`).
- Le test système lance Koto dans un dossier vide : aucun `.env` n'est lu, et l'environnement est reconstruit de zéro (aucune vraie clé). Les adresses des services passent par `TELEGRAM_API_ROOT`, `OPENROUTER_BASE_URL` et `KOTO_SCHEDULER_INTERVAL_MS`.
- Les scripts envoyés dans une page Playwright sont des chaînes, pas des fonctions : le transpileur y glisserait ses helpers (`__name`).

## Missions (suivis de fond)

- `src/missions/` : `missions.ts` (limites, textes communs, bloc `<missions>`), `pass.ts` (sous-agent d'un passage : prompt et outils figés, identiques pour toutes les missions) et `runner.ts` (`MissionRunner` : lancement, fin, messages). Un seul Koto : l'agent principal lance et modifie les missions (`mission_start`, `mission_update`) ; elles ne lui rapportent que des messages « 🎯 Mission #… », écrits dans l'historique (kind `mission`).
- **Contexte d'un passage** : l'objectif, les consignes (`instructions`), ses notes et un profil minimal (`renderPassContext`). Jamais la mémoire, les listes ni l'historique de la personne. Le bloc `<missions>` du contexte principal ne montre que l'id, le titre, le rythme et la date limite : ni coût ni notes, sinon le cache sauterait à chaque passage.
- **Lancement** : `scheduler.tick` appelle `missions.dispatch(at)` sans l'attendre (un passage ne retarde jamais un rappel). `claimMissionRun` est atomique ; au plus 2 passages à la fois. Sans payeur ou au-delà du budget du jour, le passage est repoussé d'une heure, sans appel au modèle. Les messages partent sous `locks.run(account.id)`.
- **Outils d'un passage**, gratuits d'abord : `news` et `crypto_price` (`NewsService.quotes`, cache de 10 min à part de celui du brief), `weather` (`runWeatherTool`), Gmail/Agenda par `runTool` (mêmes refus en groupe, envois en `pending_actions`), `browse_web` par `BrowserTasks.runForMission` (même file, aucune question donc aucun clic engageant, ni 1Password ni prise en main), web avec `max_uses: 2`, et `finish`. Un passage n'exécute que ses propres outils.
- **Coût** : plafond par passage (`KOTO_MISSION_RUN_MAX_COST_USD`, réduit au reste du plafond de la mission et du budget du jour) et par mission (`max_cost_usd`). Au plafond du passage, une seule requête de plus pour conclure (consigne ajoutée au message des résultats, en ajout seul). Tout le coût, navigateur compris, passe une fois par `recordUsage`. Pas de nouveau tarif : `pricing.ts` chiffre déjà modèle, recherche web et navigateur.
- **Fin** : `done`, dernier passage à la date limite (il conclut toujours), plafond atteint, 3 échecs de suite, arrêt par la personne, Koto retiré du groupe (`stopActiveMissions`). Seule la `conclusion` est proposée à la mémoire (boutons `ms:<id>:keep|drop`), jamais les notes.
- **Données** : table `missions` (v7), toujours filtrée par `user_id`, y compris le bouton `ms:<id>:stop`. Un groupe a ses missions (payées par la personne rattachée, sans Gmail, Agenda ni navigateur). Elles sont dans `/exporter` (notes comprises) et `/oublier_tout` les supprime.

## Mémoire longue

- `src/memory/` : `search.ts` (outil `search_history`), `documents.ts` (fiche d'une photo ou d'un PDF, et sa relecture par `open_document`) et `consolidate.ts` (`MemoryKeeper`, le ménage de la mémoire).
- **Index plein texte** (v8) : `messages_fts` (FTS5, contenu externe sur `messages`), tenu à jour par des déclencheurs, suppressions en cascade comprises. Il couvre tous les comptes : toute requête dessus passe par une jointure sur `messages` avec `m.user_id = ?` (`Store.searchHistory`). Jamais le texte du modèle dans un `MATCH` : la requête se construit avec `ftsQuery` (mots entre guillemets, aucun opérateur).
- **Documents** : le modèle écrit la fiche à la fin de la même réponse, entre `<fiche>` et `</fiche>` (aucun appel de plus). `agent.ts` la retire du texte envoyé (`extractFiche`), l'ajoute au message de l'historique (`withFiche`) et l'enregistre dans `documents` (nom, date, `file_id` Telegram ; jamais le fichier). Le rappel `FICHE_HINT` ne part que dans le message du tour, jamais dans l'historique.
- **Relecture** (`open_document`) : l'agent ne connaît pas Telegram ; il reçoit un `FileFetcher` (`fetchFile` de `createAgent`, branché dans `index.ts` sur `telegramDownloader` de bot.ts, qui sert aussi au bot ; le serveur d'appel partage cet agent). Sans lui (CLI), l'outil reste dans le tableau (cache) et répond qu'il n'est pas disponible. Le document est cherché par `getDocument(userId, id)` avant tout téléchargement (en groupe, ceux du groupe), avec les limites `DOCUMENT_MAX_BYTES` (5 Mo image, 20 Mo PDF, les mêmes qu'à la réception). Il part dans le seul `tool_result` (texte puis bloc image ou document, `ToolOutcome.block`), jamais dans l'historique. Un seul par tour (`files.opened`, un échec ne compte pas). Un `file_id` refusé par Telegram (400) devient `FileGone`, et l'outil répond avec la fiche, sans faire échouer le tour. Le coût passe par `recordUsage` comme le reste du tour (aucun nouveau tarif).
- **Ménage** : lancé par `scheduler.tick` (`memory.dispatch`, sans l'attendre, un à la fois), avec le modèle le moins cher (`cheapestModel` dans `pricing.ts`, ou `KOTO_MEMORY_MODEL`), prompt et outil `consolidate` figés pour tous, coût via `recordUsage` (payeur d'un groupe compris). Sans payeur ou sans budget pour l'estimation (`estimateUsd`), il attend sans appeler le modèle. Quand : `MEMORY_RULES` et `accountsDueForMemoryCheck` ; `claimMemoryCheck` est atomique.
- **Rien n'est supprimé en silence** : le ménage n'efface jamais. Un souvenir fusionné ou périmé est archivé (`archived_at`, raison, `merged_into`), l'ancienne version d'un souvenir réécrit est copiée aux archives (`archiveCopy`). Garde-fous dans le code (`planConsolidation`) : ids lus seulement, un usage par id, importance gardée dans une fusion, jamais d'archive d'un ★★★, au plus 30 % archivés. Un souvenir modifié pendant le ménage n'est pas touché (`updated_at` comparé). Le compte rendu part à la personne et entre dans l'historique (kind `memory`).
- `listMemories` et `countMemories` ne voient que la mémoire active : le bloc `<memoire>` reste déterministe. `update_memory` avec `restore` remet un souvenir archivé ; `forget` supprime pour de bon (actif ou archivé), à la demande de la personne. `/memoire` montre les dernières archives ; `/exporter` donne `memoire_archivee` et `documents` ; `/oublier_tout` efface archives, documents et index.

## Navigateur (tâches web)

- `browser/engine.ts` contient Playwright (Chrome installé par défaut), un profil persistant par `ensureExternalId` et des numéros `data-koto-ref` recalculés à chaque état. Les scripts de page sont des chaînes : pas de types DOM côté Node.
- `browser/agent.ts` est le sous-agent avec ses propres outils. **Les garde-fous sont dans le code** (`guards.ts`) : clic « engageant » seulement après `ask_confirmation` accepté (une seule fois), jamais de saisie dans un champ mot de passe ni de numéro de carte, pas de réseau privé (route Playwright et DNS). Toute nouvelle action passe par ces contrôles.
- **1Password** (`credentials.ts`) : `find` ne renvoie que des métadonnées et `reveal` n'est appelé que par le code de remplissage, juste avant `fillLogin`, après accord et nouvelle vérification du domaine. Un secret ne doit jamais apparaître dans un message au modèle ni dans un log (un test le vérifie). Réservé à `OP_OWNER_TELEGRAM_ID`.
- `browser/tasks.ts` gère la file en arrière-plan, une tâche à la fois par personne. Les questions attendent un bouton `bt:<id>:yes|no|done` et expirent au bout de 30 min. Les tâches coupées par un redémarrage passent en échec au démarrage.

## Déploiement et sauvegardes

- `deploy/koto.service` (systemd, utilisateur `koto`, dossier `/home/koto/koto`, `node dist/index.js`) et `deploy/deploy.sh`. Le script attend la ligne « Koto est en ligne » dans le journal : ne reformule pas ce message de `src/index.ts` sans adapter le script.
- Sauvegardes : `src/backup.ts` (quotidiennes, `KOTO_BACKUP_KEEP`) et `npm run backup`, uniquement via l'API backup de SQLite, jamais en copiant le fichier pendant que le bot tourne.

## Schéma

Les migrations SQL vivent dans `db.ts` (tableau `MIGRATIONS`, suivi par `PRAGMA user_version`). On ajoute une entrée, on ne modifie jamais une migration existante.
