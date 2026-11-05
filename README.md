# Koto

**Ton agent personnel IA sur Telegram : il comprend sur quoi tu travailles et ce qui compte pour toi, et t'aide à avancer au quotidien.**

Comme Instinct, Koto n'a pas d'application à lui : on lui parle sur Telegram, comme à quelqu'un de confiance. La v1 reste volontairement simple : peu de fonctions, mais utiles.

| | |
|---|---|
| 🧠 **Mémoire** | Il retient tes projets et où ils en sont, tes priorités, tes objectifs, les gens importants pour toi et tes préférences. Il la met à jour quand les choses changent. Tu la consultes avec `/memoire` et tu la corriges en lui parlant. |
| 🔎 **Mémoire longue** | Il se souvient aussi de tout le reste : vos conversations et les photos ou PDF que tu lui as envoyés se retrouvent des mois après (« tu te souviens de ce que Rado avait dit pour le devis ? »), et il peut rouvrir un document pour le relire (« relis-moi la clause 4 du bail que je t'ai envoyé en septembre »). De temps en temps, il range sa mémoire : doublons fusionnés, faits périmés archivés, sans jamais rien effacer. |
| ⏰ **Rappels** | « Rappelle-moi d'appeler Rado demain à 10h » : le rappel tombe à l'heure dite, dans ton fuseau. Il gère aussi les répétitions (tous les jours, en semaine, etc.). |
| 💬 **Relances** | « J'ai un entretien jeudi » : Koto peut revenir de lui-même vers toi après, pour prendre des nouvelles. |
| ☀️ **Brief du matin** | Chaque jour à l'heure choisie : les 1 à 3 choses qui comptent aujourd'hui, la météo, ton agenda (avec un rappel 15 min avant chaque rendez-vous important), les mails qui demandent une action, tes rappels et tâches du jour, l'actu des sujets que tu suis (« ajoute l'actu crypto à mon brief ») et une suggestion pour avancer. Il peut aussi arriver en vocal. |
| 📝 **Listes** | « Ajoute lait et pain à ma liste de courses », « note dans mes tâches : appeler Rado » : des listes que tu coches d'un geste avec `/listes`, ou en le disant (« c'est acheté »). |
| 🌦️ **Météo et lieu** | « Il va pleuvoir demain ? » : prévisions gratuites (MET Norway), sans recherche web. Partage ta position (📎 → Position) ou dis-lui ta ville, et ton brief donne la météo du jour. |
| 📅 **Google Agenda** | « Qu'est-ce que j'ai demain ? », « Trouve-moi un créneau jeudi » : il lit ton agenda, repère les conflits, prépare les rendez-vous. |
| 📧 **Gmail** | « J'ai des mails importants ? », « Réponds à Rado que je valide le devis » : il trie, résume et prépare tes réponses. |
| ✅ **Rien ne part sans toi** | Envoyer un mail, créer, déplacer ou supprimer un événement : Koto prépare l'action et te montre une carte avec **✅ Confirmer / ❌ Annuler**. |
| 🎙️ **Vocaux** | Envoie un message vocal : il l'écoute et te répond en vocal. Il peut aussi parler quand tu le lui demandes (« réponds-moi en vocal », « rappel vocal à 9h », « envoie-moi le brief en vocal »). |
| 📞 **Appels** | Le bouton « Appeler » à côté du champ de saisie (ou `/appel`) : tu parles à Koto de vive voix, dans Telegram, sans numéro de téléphone ni frais d'appel. Il répond à voix haute ; un mail ou un rendez-vous à confirmer arrive en carte dans la conversation. |
| 🌐 **Tâches web** | « Trouve-moi le vol le moins cher Tana → Paris début décembre » : Koto ouvre un vrai navigateur, cherche, compare, remplit les formulaires, en arrière-plan, et t'envoie le résultat. Avant tout paiement, réservation ou envoi, il te montre une capture et attend ton **✅**. |
| 🎯 **Missions** | « Surveille le vol Tana → Paris du 4 décembre et préviens-moi s'il passe sous 600 € », « prépare-moi un dossier sur les subventions pour startups à Madagascar pour vendredi » : Koto y travaille en arrière-plan pendant des jours, passage après passage, et ne t'écrit que pour un résultat. `/missions` les montre, avec un bouton pour les arrêter. |
| 🔐 **1Password** | Pour se connecter à tes comptes, ton mot de passe est rempli par 1Password, jamais vu par l'IA, après ton accord (propriétaire du bot uniquement). |
| 🌐 **Web** | Il cherche l'actualité, les prix et les horaires, et lit le lien que tu lui envoies, avec ses sources. |
| 📎 **Photos et PDF** | Une facture, une capture, un contrat : « explique-moi ça ». |
| 🫂 **Groupes** | Ajoute Koto à un groupe Telegram (une sortie, un projet à plusieurs) : il répond quand on le mentionne ou qu'on répond à l'un de ses messages. Le groupe a sa propre mémoire, ses rappels (« rappelez-nous samedi à 18 h ») et ses listes partagées, et `/resume` résume ce qu'on lui a dit. Rien de ce que chacun lui confie en privé n'y apparaît. |
| 👥 **Multi-utilisateurs** | Inscription sur invitation (liens à usage unique), données isolées par personne, budget API quotidien par utilisateur. |
| 📦 **Tes données** | `/exporter` t'envoie tout ce que Koto garde sur toi dans un fichier, et `/oublier_tout` l'efface. |

## Démarrage

Il te faut Node 22.13 ou plus, un bot Telegram et une clé de modèle : OpenRouter ou Anthropic.

1. **Crée le bot** : sur Telegram, écris à [@BotFather](https://t.me/BotFather), puis `/newbot`. Garde le token.
2. **Récupère une clé** : sur [OpenRouter](https://openrouter.ai/settings/keys) (avec des crédits), ou une clé API sur [platform.claude.com](https://platform.claude.com). Un abonnement Claude (Pro, Max…) ne peut pas servir : ses identifiants sont réservés à Claude Code et claude.ai.
3. **Configure** :
   ```bash
   cp .env.example .env
   ```
   Renseigne `TELEGRAM_BOT_TOKEN`, puis `OPENROUTER_API_KEY` ou `ANTHROPIC_API_KEY`.
4. **Vérifie la configuration** (sans afficher les secrets, et sans frais) :
   ```bash
   npm install
   ```
   ```bash
   npm run doctor
   ```
   Puis **lance-le** :
   ```bash
   npm run dev
   ```
5. **Deviens admin** : écris au bot. Comme tu n'as pas d'invitation, il te répond avec ton identifiant Telegram. Mets-le dans `ADMIN_TELEGRAM_IDS` dans `.env`, relance, puis envoie `/start`.
6. **Invite du monde** avec `/inviter`. Chaque lien ne sert qu'une fois, et chaque nouvel utilisateur reçoit `INVITES_PER_USER` invitations à son tour.

### Avec OpenRouter

Il suffit que `OPENROUTER_API_KEY` soit rempli : Koto garde le SDK Anthropic et le même format de messages, mais envoie ses appels à `https://openrouter.ai/api`. Le modèle est converti tout seul (`claude-opus-5-5` devient `anthropic/claude-opus-5.5`), au même prix qu'en direct.

Ce qui change :
- **Hébergeur** : Koto demande à OpenRouter de servir Claude par Anthropic en priorité, pour garder la recherche web native et un cache stable.
- **Session** : chaque utilisateur a sa propre session (`session_id`), ce qui permet de suivre les requêtes par personne dans OpenRouter.
- **Budget** : il est compté avec le coût réel renvoyé par OpenRouter.
- **Repli en cas de refus** : le repli propre à Anthropic n'existe pas chez OpenRouter ; un refus reçoit simplement une réponse polie.
- **Vérification** : `npm run doctor` contrôle la clé, tes crédits restants et la disponibilité du modèle.

### Gmail et Google Agenda (via Composio)

1. Crée un compte sur [Composio](https://dashboard.composio.dev) et copie une clé API (Settings, puis API Keys) dans `COMPOSIO_API_KEY`.
2. Relance Koto, puis vérifie avec `npm run doctor`, qui doit annoncer les outils Gmail et Agenda disponibles.
3. Sur Telegram, envoie `/connecter` et choisis le service : tu autorises l'accès sur la page de Google, et Koto te prévient dès que c'est fait.

Comment ça marche :
- **Une session par personne.** Composio ouvre une session limitée à 14 outils Gmail et Agenda, exposée en **MCP**. Koto s'y connecte comme client MCP.
- **Pas d'application Google à créer.** Composio s'occupe de l'OAuth avec ses propres applications Google, déjà validées.
- **Ce qui s'exécute tout de suite** : les lectures (chercher ou lire des mails, lister des événements, trouver des créneaux) et les brouillons. **Tout le reste attend ton « ✅ Confirmer »** : envoyer, répondre, créer, modifier ou supprimer un événement. Le bouton exécute l'action une seule fois, même en cas de double clic, et expire au bout de 24 h.
- **Ce qui est exclu** : la suppression de mails, les filtres et le transfert automatique.
- **Sécurité** : le contenu des mails est traité comme de l'information, jamais comme des instructions. Supprimer ton compte avec `/oublier_tout` retire aussi l'accès donné à Google.
- **Confidentialité** : les jetons d'accès sont gardés par Composio, pas par Koto. Le contenu des mails lus passe par Composio et par le modèle.

### Messages vocaux

Activés par défaut si `OPENROUTER_API_KEY` est rempli (`KOTO_VOICE`). Le vocal est transcrit par un modèle audio d'OpenRouter (`KOTO_TRANSCRIBE_MODEL`, Gemini 2.5 Flash Lite par défaut, environ 0,0006 $ la minute), puis traité comme un message écrit. La limite est de 5 minutes par vocal, et le coût entre dans le budget du jour.

### Appels en direct

Le bouton « Appeler » ouvre dans Telegram une page d'appel (une mini-app). Tu parles normalement : la page repère la fin de chaque phrase, l'envoie à Koto, puis joue sa réponse avant de réécouter. On parle chacun son tour, ce qui évite que Koto s'entende lui-même. L'appel passe par Internet et non par un opérateur : il n'y a donc ni numéro ni frais d'appel. Seule l'intelligence coûte, soit environ 0,004 $ par minute (estimation, pas encore mesurée sur un vrai appel).

- **Adresse publique HTTPS.** Telegram n'ouvre une mini-app qu'en HTTPS. Koto sert la page sur `127.0.0.1:8787` (`KOTO_CALL_HOST`, `KOTO_CALL_PORT`), et un tunnel ou un proxy HTTPS la rend publique. Mets son adresse dans `KOTO_PUBLIC_URL` (par exemple `https://koto.ton-domaine.com`). Sans cette adresse, les appels sont désactivés et `/appel` propose les messages vocaux.
- **Tunnel gratuit.** Le plus simple est [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) : `cloudflared tunnel --url http://localhost:8787` donne une adresse `https://….trycloudflare.com` sans compte, mais elle change à chaque relance. Avec ton propre domaine, un tunnel nommé garde la même adresse.
- **Sécurité.** Chaque phrase porte la signature de Telegram (initData) : seule une personne inscrite sur Koto peut appeler, et chaque appel compte dans son budget du jour.
- **Limites.**
  - Comptent 2 à 4 secondes pour chaque réponse.
  - Une phrase dure une minute au plus.
  - Le micro dans une mini-app dépend du téléphone : teste-le sur le tien ; sur iPhone, il n'est pas garanti.

### Réponses vocales

Koto répond aussi en vocal (`KOTO_TTS`, activé par défaut avec une clé OpenRouter). Chaque personne règle ça en lui parlant :
- **Réponses vocales** : jamais, quand elle envoie un vocal (par défaut) ou à chaque réponse.
- **Brief du matin en vocal** : oui ou non.
- **Rappel vocal** : au cas par cas.
- **Demande ponctuelle** : « réponds-moi en vocal ».

Le texte part toujours en premier, puis le vocal : liens, émojis et mise en forme ne sont pas lus.

La synthèse passe par l'endpoint `/audio/speech` d'OpenRouter, avec deux voix :
- **Voix principale** (`KOTO_TTS_MODEL`) : Fish Audio S2.1 Pro, gratuite. Le quota des modèles gratuits vaut pour tout le compte OpenRouter : 50 requêtes par jour, ou 1 000 si le compte a acheté au moins 10 $ de crédits.
- **Voix de secours** (`KOTO_TTS_FALLBACK_MODEL`) : Kokoro, voix française `ff_siwis`, environ 0,0006 $ les 1 000 caractères. Elle prend le relais quand le quota gratuit est atteint ou que le modèle gratuit ne répond pas.

Un brief lu de 55 secondes coûte donc 0 $, ou 0,0006 $ avec Kokoro. Pour une voix plus naturelle mais payante : `microsoft/mai-voice-2.1-flash` avec `fr-FR-Soleil:MAI-Voice-2.1-Flash`, environ 0,015 $ les 1 000 caractères.

### Veille du brief

« Ajoute l'actu crypto (Bitcoin, RLC) à mon brief » : chaque matin, le brief résume les 2 à 4 infos importantes des dernières 24 h sur ces sujets. Elles ne viennent pas de la recherche web, payante (0,01 $ par recherche) : Koto lit des flux RSS gratuits et, pour la crypto, les cours de CoinGecko.
- **Sujets couverts** : crypto, tech et IA, Madagascar, économie, football, actualité générale.
- **Partage** : chaque flux est téléchargé une seule fois par période de 2 h pour tous les utilisateurs.
- **Repli** : un sujet sans flux, ou dont les flux ne répondent pas, a droit à une seule recherche web par brief.

Le catalogue des flux est dans `src/news.ts`. Un essai réel (brief crypto avec cours et titres de Cryptoast et du Journal du Coin) a coûté 0,0007 $, sans aucune recherche web.

### Tâches web (navigateur)

Activées par défaut (`KOTO_BROWSER=on`). Koto pilote **ton Chrome** via Playwright, en mode invisible, avec un profil séparé par personne : les cookies et les connexions restent, sans se mélanger entre utilisateurs. Si Chrome n'est pas installé (sur un serveur ARM, par exemple), il prend tout seul le Chromium de Playwright. La tâche tourne en arrière-plan, et la conversation continue pendant ce temps.

Comment le sous-agent voit la page : une liste d'éléments numérotés (`[12] bouton « Rechercher »`), ce qui coûte bien moins cher que des captures et fonctionne avec Haiku via OpenRouter. Un essai réel (trouver une information sur Wikipédia) a pris 3 étapes, 7 secondes et 0,0025 $.

**Garde-fous appliqués par le code, pas seulement par le prompt :**
- **Engagement** : un bouton « Payer », « Réserver », « Commander », « Envoyer », « Valider » ou « Supprimer » ne peut être cliqué qu'après ton « ✅ Oui » sur Telegram (capture à l'appui), et pour un seul clic.
- **Secrets** : l'IA ne tape jamais dans un champ mot de passe ni un numéro de carte (contrôle de Luhn). CAPTCHA, code SMS ou carte : elle te passe la main ou s'arrête.
- **Réseau** : pas d'accès à la machine ni au réseau local (protection SSRF, y compris pour les sous-requêtes et les domaines qui pointent vers une IP privée). Pas de téléchargements, les boîtes de dialogue sont refusées.
- **Limites** : nombre d'étapes et coût plafonnés par tâche (`KOTO_BROWSER_MAX_STEPS`, `KOTO_BROWSER_MAX_COST_USD`), et coût compté dans le budget du jour.
- **Contenu des pages** : traité comme de l'information, jamais comme des instructions.

**Prendre la main** : avec `KOTO_BROWSER_HEADED=on`, la fenêtre s'affiche sur l'écran du PC qui fait tourner Koto. Pour une connexion ou un CAPTCHA, Koto te demande de le faire toi-même dans la fenêtre, puis reprend quand tu appuies sur « C'est fait ». Ça ne sert qu'au propriétaire, devant l'écran.

**1Password** (facultatif, propriétaire uniquement) :
1. Dans l'appli de bureau 1Password, active Réglages, puis Développeur, puis « Intégrer avec d'autres applications ».
2. Mets le nom de ton compte dans `OP_ACCOUNT` (ou un jeton de compte de service dans `OP_SERVICE_ACCOUNT_TOKEN`), et ton identifiant Telegram dans `OP_OWNER_TELEGRAM_ID`.
3. Quand une tâche arrive sur une page de connexion, Koto te demande sur Telegram : « Se connecter à jumia.mg avec ton identifiant « Jumia » ? ». Si tu acceptes, le code récupère l'identifiant et remplit le formulaire lui-même : **le modèle ne voit jamais le mot de passe**. L'appli 1Password te demande aussi son accord.
4. L'identifiant n'est rempli que si le domaine de la page correspond à celui enregistré, comme le ferait 1Password (`jumia.mg.faux-site.com` ne reçoit rien). Le domaine est revérifié juste avant de remplir.

### Missions (suivis de fond)

Activées par défaut (`KOTO_MISSIONS=on`). Une mission, c'est un objectif que Koto suit pendant plusieurs jours, sans que tu aies à le relancer :
- « Surveille le vol Tana → Paris du 4 décembre et préviens-moi s'il passe sous 600 € » ;
- « Prépare-moi un dossier sur les subventions pour startups à Madagascar pour vendredi » ;
- « Si Rado n'a pas répondu au devis d'ici jeudi, propose-moi une relance » (avec Gmail connecté).

Comment ça marche :
- **Lancement** : Koto crée la mission avec un outil (objectif, condition de fin, rythme, date limite, plafond de coût) et te le dit en une phrase. C'est toujours le même Koto, avec une seule mémoire : la mission n'est qu'un travail de fond qui lui rapporte.
- **Passages** : le scheduler lance chaque passage à son rythme, une fois par heure au plus (`KOTO_MISSION_MIN_HOURS`). Un passage a son propre contexte : l'objectif, les consignes que tu as ajoutées, ses notes des passages précédents et un profil minimal (nom, fuseau, lieu, services connectés). Il ne voit jamais ta mémoire ni vos conversations.
- **Gratuit d'abord** : flux RSS et cours CoinGecko, météo, Gmail et Agenda s'ils sont connectés ; puis la recherche web (deux par requête au plus) ; le navigateur seulement en dernier recours, sans jamais payer, réserver ni envoyer.
- **Silence** : chaque passage met ses notes à jour et ne te prévient que si c'est utile (seuil franchi, rapport prêt, question à poser). Tu réponds à sa question dans la conversation, et Koto la lui transmet. Un mail ou un rendez-vous préparé arrive en carte **✅ Confirmer / ❌ Annuler**, comme d'habitude.
- **Fin** : objectif atteint, date limite (le dernier passage conclut toujours, avec un rapport ou un bilan), plafond de coût atteint, trois erreurs de suite, ou arrêt de ta part (`/missions`, ou « arrête de surveiller le vol »).
- **Mémoire** : à la fin, Koto te propose de garder sa conclusion (« 🧠 Garder en mémoire »). Les notes de travail de la mission n'entrent jamais dans ta mémoire.
- **Coût** : un plafond par passage (`KOTO_MISSION_RUN_MAX_COST_USD`, 0,05 $) et un par mission (0,25 $ par défaut avec `KOTO_MISSION_MAX_COST_USD`, 2 $ au plus si tu le demandes). Chaque passage compte dans ton budget du jour ; budget épuisé, il attend le lendemain sans rien dépenser.
- **En groupe** : une mission lancée dans un groupe appartient au groupe, y rapporte et est payée par la personne rattachée ; Gmail, l'agenda et le navigateur n'y servent pas. Retirer Koto du groupe arrête ses missions.

Essais réels avec Claude Haiku 5.5 via OpenRouter, sans recherche web : un passage qui surveille un cours crypto et se tait coûte environ 0,0003 $ ; un point d'actualité remis en une fois, environ 0,0013 $.

### Mémoire longue

Toujours active, sans réglage. Koto n'envoie au modèle que la mémoire (`<memoire>`) et les échanges récents ; pour le reste :
- **Recherche dans le passé** : l'outil `search_history` cherche dans tout l'historique (conversations, photos et documents reçus, messages des missions, comptes rendus du ménage), avec un index plein texte SQLite FTS5 tenu à jour par la base. C'est local et gratuit : seule la réponse de Koto passe par le modèle. Les extraits reviennent datés, avec la réponse de Koto qui suivait. Accents et pluriels ne gênent pas (« reunion » trouve « Réunion », « facture » trouve « factures »), et l'on peut limiter à une période ou aux seuls documents.
- **Documents** : une photo ou un PDF n'est vu que pendant le tour où il arrive. Le modèle écrit donc sa fiche (type, émetteur, dates, montants, sujet) à la fin de la même réponse, sans requête de plus. Koto la retire du message envoyé, l'ajoute au message de l'historique et la range avec le nom et la date (table `documents`, avec l'identifiant Telegram du fichier). Le fichier lui-même n'est pas gardé.
- **Relire un document** : quand la fiche ne suffit pas (le texte exact d'une clause, un chiffre, un détail d'une photo), l'outil `open_document` rouvre le fichier à partir de son id (donné par `search_history`). Il est resté chez Telegram, qui le garde pour le bot : Koto le retélécharge (5 Mo au plus pour une image, 20 Mo pour un PDF) et l'envoie au modèle dans le seul résultat de l'outil, jamais dans l'historique. Un seul document par tour, et seulement ceux du compte (en groupe, ceux du groupe). Si Telegram ne le donne plus (identifiant expiré), Koto le dit, cite la fiche et propose de le renvoyer. Sans Telegram (`npm run cli`), l'outil répond qu'il n'est pas disponible.
- **Ménage de la mémoire** (`KOTO_MEMORY_CONSOLIDATION=on`) : dès 60 souvenirs ou 9 000 caractères (une fois par jour au plus), sinon une fois par semaine si elle a changé, le scheduler fait relire la mémoire au modèle le moins cher (Claude Haiku 5.5, `KOTO_MEMORY_MODEL`). Il propose des fusions, des réécritures (une date relative devenue absolue, un projet terminé) et des archives. Le code valide chaque opération :
  - rien n'est effacé : un souvenir fusionné ou périmé passe aux archives, l'ancienne version d'un souvenir réécrit aussi ;
  - un souvenir ★★★ n'est jamais archivé, une fusion garde l'importance la plus haute, et au plus 30 % de la mémoire part aux archives en une fois ;
  - un souvenir modifié par la conversation pendant le ménage n'est pas touché ;
  - tu reçois le compte rendu (« 🧹 J'ai rangé ma mémoire… »), gardé dans l'historique. `/memoire` montre les archives, et « remets le souvenir 12 » en reprend un.
  
  Le coût compte dans le budget du jour de qui paie ; s'il ne le couvre pas, le ménage attend.

Essais réels avec Claude Haiku 5.5 via OpenRouter : un tour qui retrouve une facture envoyée plus tôt coûte environ 0,0004 $ (deux requêtes, la recherche est gratuite) ; lire un PDF et écrire sa fiche, environ 0,0004 $ ; retrouver un bail puis le rouvrir pour en relire une clause, environ 0,0007 $ (trois requêtes) ; un ménage de 12 souvenirs, environ 0,0007 $.

### Groupes Telegram

Dans BotFather, rien à changer : l'ajout aux groupes est autorisé par défaut (`/setjoingroups`), et le **mode privé reste activé** (`/setprivacy`, Enable). Telegram ne transmet alors à Koto que les commandes, les réponses à ses messages et les messages qui le mentionnent. Koto refait ce tri dans son code : s'il est admin du groupe ou si le mode privé est coupé, il reçoit tout, mais ignore le reste sans rien dépenser.

Comment ça marche :
- **Pour lui parler** : `@ton_bot rappelez-nous samedi à 18 h`, une réponse à l'un de ses messages, ou une commande. Il répond en citant le message de la personne, et sait qui parle (prénom Telegram) et à quel message elle répond.
- **Qui paie** : le groupe est rattaché à la personne inscrite qui y a ajouté Koto, ou à défaut à la première qui lui parle. Les tours du groupe, vocaux compris, comptent dans son budget du jour. Les autres membres, inscrits ou non, peuvent lui parler. Sans personne inscrite, Koto explique comment l'activer (une fois toutes les 10 minutes) et n'appelle jamais le modèle.
- **Détacher** : si cette personne quitte le groupe ou si Koto en est retiré, le groupe n'est plus rattaché à personne et ses rappels à venir sont annulés. La prochaine personne inscrite qui lui parle, ou qui le rajoute, prend le relais.
- **Données à part** : le groupe a son propre compte, avec sa mémoire, son historique, ses rappels et ses listes. En groupe, le modèle ne voit que ces données-là : ni la mémoire, ni les listes, ni l'historique, ni le nom d'usage d'un membre. Koto n'y connaît chacun que par son prénom Telegram.
- **Ce qui reste personnel** : le brief, la veille, Gmail, l'agenda et les tâches web. En groupe, ces outils refusent, et les commandes personnelles (`/brief`, `/connecter`, `/inviter`…) renvoient en privé.
- **Effacer** : `/oublier_tout` dans le groupe efface sa mémoire, son historique, ses listes et ses rappels. C'est réservé à la personne rattachée et aux admins du groupe ; les mémoires personnelles ne sont pas touchées.
- **Passage en supergroupe** : Telegram change alors l'identifiant du groupe, et Koto le suit sans rien perdre.

Coût : rien de plus qu'une conversation privée. La consigne propre aux groupes (environ 400 tokens) fait partie du prompt figé, commun à tous et lu depuis le cache. Une mention seule, `/resume` sans échange récent, `/memoire`, `/rappels`, `/listes` (et ses cases à cocher) et l'envoi des rappels du groupe ne passent pas par le modèle : ils ne coûtent rien.

### Essayer sans Telegram

```bash
npm run cli
```

Ce mode discute avec Koto dans le terminal. Il utilise sa propre base (`data/cli.db`) et seulement la clé API. Les commandes locales sont `/memoire`, `/rappels`, `/listes`, `/brief`, `/usage`, `/exporter` (dans `data/mes-donnees.json`), `/fuseau Europe/Paris`, `/reset` et `/quit`. Avec Composio, s'ajoutent `/connecter gmail`, `/confirmer <id>` et `/annuler <id>`. Avec le navigateur : `/taches`, `/oui <id>`, `/non <id>`, `/fait <id>` et `/arreter <id>` (la dernière capture est enregistrée dans `data/derniere-capture.jpg`). Pour les missions : `/missions`, `/arreter_mission <id>` et `/retenir <id>` (garder la conclusion en mémoire). `/ranger` lance tout de suite le ménage de la mémoire.

## Commandes du bot

| Commande | Effet |
|---|---|
| `/memoire` | Ce que Koto sait de toi, et les derniers souvenirs archivés par le ménage |
| `/rappels` | Rappels et relances à venir, et tes réglages (brief, veille, réponses vocales) |
| `/listes` | Tes listes (courses, tâches…), un bouton par élément pour le cocher |
| `/brief` | Recevoir le brief tout de suite |
| `/appel` | Appeler Koto pour lui parler de vive voix (si les appels sont activés) |
| `/connecter` | Relier ou délier Gmail et Google Agenda |
| `/taches` | Tes tâches web en cours, avec un bouton pour les arrêter |
| `/missions` | Tes missions (en cours et récentes), avec un bouton pour les arrêter |
| `/inviter` | Créer un lien d'invitation |
| `/usage` | Ta consommation du jour et ton budget |
| `/exporter` | Tout ce que Koto garde sur toi (archives de la mémoire et fiches des documents comprises), dans un fichier JSON |
| `/oublier_tout` | Effacer mémoire (archives comprises), historique et documents, ou supprimer ton compte |
| `/aide` | Exemples de ce que tu peux lui demander |
| `/stats` | (admin) Utilisateurs et coût des dernières 24 h |

Tout le reste se fait en langage naturel : « appelle-moi Orlando », « mon fuseau c'est Europe/Paris », « envoie le brief à 7h », « j'habite à Toamasina », « oublie le 12 ». Une position partagée (📎 → Position) règle ton lieu ; elle est arrondie à environ 1 km.

Dans un groupe, le menu ne montre que les commandes du groupe :

| Commande | Effet |
|---|---|
| `/memoire` | Ce que Koto sait du groupe |
| `/rappels` | Les rappels du groupe et son fuseau |
| `/listes` | Les listes partagées du groupe, que chacun coche d'un geste |
| `/missions` | Les missions du groupe, avec un bouton pour les arrêter |
| `/resume` | Résumé de ce qu'on a dit à Koto ici en 24 h (`/resume 3` pour 3 jours) ; marche aussi en privé |
| `/aide` | Exemples pour le groupe |
| `/oublier_tout` | Effacer la mémoire du groupe (personne rattachée ou admins) |

Le reste se dit en le mentionnant : « @ton_bot on part à Andasibe samedi à 6 h, retiens-le », « @ton_bot ajoute charbon et brochettes à la liste de la sortie ».

## Comment c'est construit

```
src/
├── index.ts            démarrage : bot Telegram + scheduler
├── cli.ts              mode terminal
├── config.ts           variables d'environnement (validées)
├── db.ts / store.ts    SQLite : chaque requête est filtrée par user_id
├── backup.ts           sauvegarde quotidienne de la base (API backup de SQLite)
├── accounts.ts         inscription sur invitation, réglages, budget
├── scheduler.ts        rappels, relances, briefs, passages de mission et ménage de la mémoire (toutes les 20 s)
├── news.ts             veille du brief : flux RSS et cours CoinGecko, gratuits et partagés
├── weather.ts          météo (MET Norway) et lieux (OpenStreetMap), gratuits
├── call/               appels en direct : page de la mini-app, serveur, signature Telegram
├── export.ts           /exporter : toutes les données d'une personne
├── missions/           missions de fond : limites et textes, passage (sous-agent), lancement par le scheduler
├── memory/             mémoire longue : search_history (FTS5), fiches et relecture des documents, ménage de la mémoire
├── speech.ts           réponses vocales : synthèse OpenRouter, voix gratuite puis de secours
├── voice.ts            transcription des vocaux reçus
├── time.ts             fuseaux, répétitions, dates en français
├── agent/
│   ├── agent.ts        boucle Claude : outils, pause, refus, coûts
│   ├── tools.ts        mémoire, recherche dans le passé, rappels, listes, réglages, météo, voix, missions + web
│   ├── prompt.ts       prompt système, contexte de la personne, historique
│   └── pricing.ts      coût de chaque appel (pour le budget)
└── bot/
    ├── bot.ts          grammY : accès, commandes, photos/PDF
    ├── group.ts        groupes : à qui s'adresse un message, qui parle, qui paie
    └── format.ts       Markdown → HTML Telegram, découpage
```

Pour un message, voici ce qui se passe :
1. grammY reçoit le message. L'utilisateur est retrouvé ou inscrit, puis on vérifie sa limite de débit et son budget. Dans un groupe, seuls les messages adressés à Koto passent, au nom du compte du groupe, et c'est le budget de la personne rattachée qui compte.
2. L'agent appelle Claude avec trois blocs : le prompt système figé (le même pour tous), le contexte de la personne ou du groupe (profil, mémoire, rappels à venir, listes) et l'historique récent.
3. Claude appelle des outils (`remember`, `schedule`, `update_settings`, `web_search`…) jusqu'à avoir sa réponse.
4. La réponse est envoyée sur Telegram. Le tour (ton message, sa réponse, son coût) est enregistré.

### Choix techniques

- **Modèle** : Claude Opus 5.5 (`KOTO_MODEL`), avec un effort `low` pour garder des réponses rapides en chat (`KOTO_EFFORT`).
- **Cache de prompt** : le prompt système et les outils sont identiques pour tous les utilisateurs. Ils forment un préfixe mis en cache une heure et partagé. Le contexte de chaque personne et son historique sont mis en cache à la suite. Une lecture en cache coûte 0,20 $ par million de tokens, contre 4 $ sans cache.
- **Repli en cas de refus** : l'option `fallbacks: "default"` est activée. Si un filtre de sécurité refuse une demande à tort, l'API la rejoue côté serveur sur le modèle recommandé, au lieu de laisser Koto muet. Tu peux la retirer dans `src/agent/agent.ts` si tu n'en veux pas.
- **Historique** : pendant un tour, les messages ne font que s'ajouter, ce qui garde la réflexion et le cache valides. Entre deux tours, Koto relit le texte des échanges récents. Quand l'historique devient trop long, il est coupé par paliers (60 messages ou 60 000 caractères), pas à chaque message : son début reste stable et le cache continue de servir. Le long terme, c'est la mémoire, et tout l'historique reste retrouvable avec `search_history` (index FTS5, gratuit).
- **Vie privée** : les logs ne contiennent ni messages ni souvenirs, seulement des identifiants, des statuts et des coûts. Les données de chaque personne ne sont accessibles qu'avec son `user_id`, et un id fourni par le modèle ne peut pas toucher les données d'un autre. Un groupe est un compte à part, isolé de la même façon : en groupe, rien de la mémoire, des listes ou de l'historique d'un membre n'entre dans le contexte. Les secrets évidents (mots de passe, numéros de carte) sont refusés en mémoire.

## Coûts

Chaque appel est chiffré à partir de l'usage renvoyé par l'API (tokens, cache, recherches web à 10 $ les 1 000), puis ajouté au budget du jour de la personne (`DAILY_BUDGET_USD`, 0,50 $ par défaut ; illimité pour les admins). Une fois la limite atteinte, Koto le dit et reprend le lendemain. Les briefs et les relances s'arrêtent aussi.

Chiffres mesurés avec Claude Haiku 5.5 via OpenRouter (octobre 2026) :

| Poste | Coût |
|---|---|
| Message simple (avec cache), en privé ou dans un groupe | 0,0005 à 0,002 $ |
| Brief du matin avec veille crypto (flux gratuits) | environ 0,0007 $ |
| Vocal envoyé par Koto | 0 $ (voix gratuite), 0,0006 $ les 1 000 caractères avec Kokoro |
| Vocal reçu (transcription) | environ 0,0006 $ la minute |
| Recherche web | 0,01 $ la recherche, plus les pages lues : le poste le plus cher, à éviter quand une source gratuite existe |
| Tâche web (navigateur) | de 0,003 $ à 0,30 $ (plafond par tâche) |
| Passage de mission | environ 0,0003 $ (cours crypto) à 0,0013 $ (point d'actualité) avec les sources gratuites ; 0,01 $ de plus par recherche web ; plafonds par passage et par mission |
| Recherche dans le passé (`search_history`) | 0 $ (SQLite local) ; le tour qui s'en sert fait une requête de plus : environ 0,0004 $ en tout |
| Photo ou PDF reçu | la lecture seule ; sa fiche est écrite dans la même réponse (environ 0,0004 $ pour une facture d'une page) |
| Document rouvert (`open_document`) | le téléchargement chez Telegram est gratuit ; le modèle relit le document : environ 0,0007 $ le tour pour une page, davantage pour un long PDF ; un seul par tour |
| Ménage de la mémoire | environ 0,0007 $ pour 12 souvenirs, avec Haiku ; une fois par semaine au plus, ou par jour au-delà de 60 souvenirs |
| Météo, lieux, listes, export | 0 $ (sources gratuites, rien ne passe par le modèle sauf la réponse) |
| Dans un groupe : messages qui ne s'adressent pas à Koto, mention seule, `/memoire`, `/listes`, rappels | 0 $ (rien ne passe par le modèle) |

Suis les vrais chiffres avec `/usage` et `/stats`. Pour réduire encore la facture :
- baisse `DAILY_BUDGET_USD` ;
- coupe le web avec `KOTO_WEB=off` ;
- plafonne les tâches web avec `KOTO_BROWSER_MAX_COST_USD` ;
- plafonne les missions avec `KOTO_MISSION_MAX_COST_USD` et `KOTO_MISSION_RUN_MAX_COST_USD`, ou coupe-les avec `KOTO_MISSIONS=off` ;
- coupe le ménage de la mémoire avec `KOTO_MEMORY_CONSOLIDATION=off` (la recherche dans le passé, gratuite, reste).

Les modèles de chat gratuits d'OpenRouter (`:free`) ne conviennent pas comme cerveau de Koto, pour deux raisons :
- le quota de 50 ou 1 000 requêtes par jour vaut pour tout le compte, pas par utilisateur ;
- ils peuvent ralentir ou disparaître sans prévenir.

Koto ne s'en sert que là où une panne ne coûte rien : la voix, qui a une voix de secours. Pas pour le ménage de la mémoire non plus : il enverrait la mémoire de chacun à un hébergeur gratuit qui peut garder les requêtes, voire s'en servir pour s'entraîner, pour économiser moins d'un millième de dollar par semaine.

## Déployer 24/7

Sur ton PC, Koto s'arrête quand le PC s'éteint : le brief du matin, les rappels et les vocaux ne partent plus. Sur un petit serveur toujours allumé, ils partent à l'heure. Pas besoin de domaine, de webhook ni de port ouvert : Koto va lui-même chercher ses messages chez Telegram (long polling).

Il faut une machine allumée en permanence (pas d'offre qui « s'endort »), un disque qui garde la base SQLite, et 1 à 2 Go de RAM libres pour Chromium pendant une tâche web.

### Quel serveur ?

Relevé du 14 octobre 2026 :

| Offre | Machine | Prix par mois | Pour Koto |
|---|---|---|---|
| [Oracle Cloud Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm), ARM Ampere A1 | jusqu'à 2 OCPU, 12 Go de RAM, 200 Go de disque | **0 €** | ✅ Recommandé |
| [OVHcloud VPS-1](https://www.ovhcloud.com/fr/vps/), x86 | 2 vCores, 4 Go, 40 Go, sauvegarde quotidienne incluse | 4,49 € HT, ou 3,81 € HT en payant un an d'avance | ✅ Le repli payant |
| [Contabo Cloud VPS 4](https://contabo.com/en/vps/), x86 | 4 vCPU, 8 Go, 100 Go | 4,40 € HT avec un engagement de 24 mois, 5,50 € HT sans ; pas de TVA pour Madagascar | ✅ Si l'engagement ne te gêne pas |
| [Netcup VPS Lite 1](https://www.netcup.com/en/server/vps-lite), x86 | 2 vCPU, 4 Go, 80 Go | 4,92 € HT, 6 mois minimum | ✅ |
| [Hetzner](https://www.hetzner.com/cloud/) CX23 ou CAX11 | 2 vCPU, 4 Go, 40 Go | 5,49 ou 5,99 € HT, plus 0,50 € pour l'IPv4 | ❌ En rupture depuis fin juin 2026 |
| [Google Cloud e2-micro](https://docs.cloud.google.com/free/docs/free-cloud-features) | 1 Go, aux États-Unis seulement | 0 € | ❌ Trop peu de RAM pour Chromium |
| [AWS](https://aws.amazon.com/free/), [Azure](https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account) | | gratuits 6 ou 12 mois seulement | ❌ |
| [Fly.io](https://docs.fly.io/about/pricing), [Railway](https://railway.com/pricing) | | de 5 à 13 $ | ⚠️ Possible, mais plus cher qu'un VPS |
| [Render](https://render.com/pricing), [Koyeb](https://www.koyeb.com/pricing) | | les offres gratuites s'endorment ; un worker coûte 25 $ ou plus | ❌ |

**Recommandation : Oracle Cloud Always Free, à 0 € par mois.** Une machine ARM de 1 OCPU et 6 Go suffit largement à Koto et à Chromium. Il y a deux risques :
- **Récupération des instances inactives** : Oracle peut récupérer une instance gratuite qu'il juge inactive, c'est-à-dire dont le processeur, le réseau et la mémoire restent sous 20 % pendant 7 jours. C'est le cas d'un bot qui attend ses messages.
- **Changements sans préavis** : en juin 2026, Oracle a réduit son offre gratuite sans prévenir ([InfoQ](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)).

Trois précautions s'imposent donc :
- Passe le compte en Pay As You Go : c'est toujours 0 € dans les limites gratuites, et en 2023 Oracle annonçait que ces comptes échappaient à la récupération (la doc actuelle ne le dit plus).
- Rapatrie les sauvegardes sur ton PC.
- Garde OVH VPS-1 en repli, à 4,49 € HT par mois : les mêmes commandes y fonctionnent.

Les coûts d'API (modèle, voix) ne changent pas.

### 1. Créer le serveur (Oracle Cloud)

1. Inscris-toi sur [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). La carte bancaire et le téléphone servent à vérifier ton identité. La carte n'est pas débitée tant que tu restes dans l'offre gratuite.
2. **Région d'origine** : ce choix est définitif, et c'est la seule région où tu pourras créer les machines gratuites. Prends Francfort, où il y a trois domaines de disponibilité (donc plus de chances de trouver de la place), ou Amsterdam. Toutes deux sont tout près de l'API des bots Telegram. Paris et Marseille marchent aussi.
3. **Passe le compte en Pay As You Go** (Billing, puis Upgrade). Ajoute ensuite une alerte de budget à 1 € pour être prévenu au moindre centime.
4. **Crée une instance** :
   - image **Ubuntu 24.04** ;
   - forme **VM.Standard.A1.Flex** avec 1 OCPU et 6 Go ;
   - ta clé SSH publique : `cat ~/.ssh/id_ed25519.pub`, ou `ssh-keygen -t ed25519` pour en créer une.

   En cas d'« Out of capacity », réessaie plus tard ou dans un autre domaine de disponibilité.
5. Note l'adresse IP publique. Il n'y a aucun port à ouvrir : SSH suffit.

Ailleurs (OVH, Contabo…), choisis aussi Ubuntu 24.04 et ta clé SSH. La suite est la même : remplace seulement `ubuntu@IP` par le compte du serveur (`root@IP` chez Contabo).

### 2. Préparer le serveur (une seule fois)

Connecte-toi avec `ssh ubuntu@IP`. Installe ensuite Node 24 depuis le dépôt NodeSource, puis crée un utilisateur `koto` sans droits d'administration : c'est lui qui fera tourner le bot.
```bash
sudo apt-get update && sudo apt-get -y upgrade
```
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh && sudo -E bash nodesource_setup.sh
```
```bash
sudo apt-get install -y nodejs rsync
```
```bash
sudo useradd --create-home --shell /bin/bash koto
```
Il n'y a rien à compiler : better-sqlite3 arrive précompilé pour ARM comme pour x86. Si la machine a 2 Go de RAM ou moins, ajoute 2 Go de swap pour Chromium :
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3. Installer Koto (depuis ton PC)

Lance ces commandes sur ton PC, dans le dossier de Koto, en remplaçant `ubuntu@IP` par ton serveur.

1. **Envoie `.env`** avec trois réglages propres à un serveur. Ton `.env` local ne change pas.
   - `KOTO_BROWSER_HEADED=off` : il n'y a pas d'écran pour une fenêtre visible.
   - `KOTO_BROWSER_CHANNEL=chromium` : Playwright n'installe pas Chrome sur Linux ARM.
   - `OP_ACCOUNT` vide : l'appli de bureau 1Password n'y existe pas.
   ```bash
   sed -E 's/^(KOTO_BROWSER_HEADED)=.*/\1=off/; s/^(KOTO_BROWSER_CHANNEL)=.*/\1=chromium/; s/^(OP_ACCOUNT)=.*/\1=/' .env | ssh ubuntu@IP "sudo -u koto bash -c 'umask 077 && mkdir -p /home/koto/koto && cat > /home/koto/koto/.env'"
   ```
2. **Arrête le Koto de ton PC** (Ctrl+C dans son terminal). À partir de maintenant, seul le serveur doit tourner : deux Koto avec le même token se disputent les messages (erreur 409 de Telegram). Les messages envoyés entre-temps ne sont pas perdus : Telegram les garde jusqu'à 24 h.
3. **Envoie la base**, sauvegardée proprement :
   ```bash
   npm run backup -- data/migration.db
   ```
   ```bash
   rsync -a --mkpath --chmod=F600 --rsync-path='sudo -u koto rsync' data/migration.db ubuntu@IP:/home/koto/koto/data/koto.db
   ```
4. **Installe et démarre Koto sur le serveur** :
   ```bash
   deploy/deploy.sh ubuntu@IP
   ```
   Le script :
   - copie le code, jamais `.env` ni `data/` ;
   - installe les dépendances, compile et télécharge Chromium ;
   - installe le service systemd `koto` ([deploy/koto.service](deploy/koto.service)), puis le démarre.

   Il refuse de démarrer si un Koto tourne encore sur ton PC.
5. **Vérifie** : écris au bot sur Telegram, puis lance le diagnostic sur le serveur.
   ```bash
   ssh ubuntu@IP "sudo -u koto -H bash -lc 'cd ~/koto && npm run doctor'"
   ```

Pour continuer à développer sur ton PC pendant que le serveur tourne, crée un second bot avec @BotFather. Mets son token dans le `.env` de ton PC, avec une autre base (`DATABASE_PATH=./data/dev.db`).

### Au quotidien

| Pour… | Commande |
|---|---|
| Mettre à jour Koto après une modification | `deploy/deploy.sh ubuntu@IP` (depuis ton PC) |
| Suivre les logs | `ssh -t ubuntu@IP sudo journalctl -u koto -f` |
| Redémarrer | `ssh ubuntu@IP sudo systemctl restart koto` |
| Modifier la configuration | `ssh -t ubuntu@IP sudo -u koto nano /home/koto/koto/.env`, puis redémarrer |
| Rapatrier les sauvegardes sur ton PC | `rsync -a --rsync-path='sudo rsync' ubuntu@IP:/home/koto/koto/data/backups/ ~/koto-sauvegardes/` |

Le service redémarre tout seul après un plantage, une coupure réseau ou un redémarrage du serveur. Il tourne sous l'utilisateur `koto`, sans droits d'administration, et seul cet utilisateur peut lire la base.

### Sauvegardes

**Quand** : Koto sauvegarde sa base une fois par jour, au démarrage puis peu après minuit UTC, vers 3 h à Madagascar.

**Où** : dans `data/backups/koto-AAAA-MM-JJ.db`. Il garde les 14 dernières (`KOTO_BACKUP_KEEP`, 0 pour désactiver).

**Comment** : il passe par l'API backup de SQLite. La copie reste cohérente même pendant que le bot écrit, contrairement à un simple `cp` de `koto.db`. `npm run backup` en fait une tout de suite, même bot allumé.

**Où les garder** : ces sauvegardes restent sur le serveur. Si la machine disparaît, elles disparaissent avec elle : rapatrie-les régulièrement sur ton PC (commande ci-dessus). Elles contiennent les mémoires et les messages de tous les utilisateurs : ne les partage pas.

Pour restaurer une sauvegarde, lance sur le serveur :
```bash
sudo systemctl stop koto
```
```bash
sudo -u koto cp /home/koto/koto/data/backups/koto-2026-10-13.db /home/koto/koto/data/koto.db && sudo -u koto rm -f /home/koto/koto/data/koto.db-wal /home/koto/koto/data/koto.db-shm
```
```bash
sudo systemctl start koto
```

### Si ça coince

- **« Out of capacity » chez Oracle** : la région n'a plus de machine ARM libre pour le moment. Réessaie plus tard ou dans un autre domaine de disponibilité.
- **`apt` signale un verrou** : juste après sa création, le serveur installe ses mises à jour. Attends quelques minutes.
- **Erreurs 409 dans les logs** : un autre Koto tourne avec le même token, sans doute celui de ton PC. Arrête-le.
- **Tâches web en échec (« error while loading shared libraries »)** : il manque des bibliothèques à Chromium. Pour les installer :
  ```bash
  ssh ubuntu@IP "sudo /home/koto/koto/node_modules/.bin/playwright install-deps chromium && sudo systemctl restart koto"
  ```
- **Revenir sur ton PC** : arrête le serveur et rapatrie sa base.
  ```bash
  ssh ubuntu@IP "sudo systemctl disable --now koto && sudo -u koto -H bash -lc 'cd ~/koto && npm run backup -- data/retour.db'"
  ```
  ```bash
  rm -f data/koto.db-wal data/koto.db-shm && rsync -a --rsync-path='sudo rsync' ubuntu@IP:/home/koto/koto/data/retour.db data/koto.db
  ```
  Relance ensuite `npm run dev`.

## Tests

```bash
npm test
```

Cette commande lance les trois premiers niveaux, sans réseau ni vraie clé, en une dizaine de secondes. Chaque niveau se lance aussi seul :

| Niveau | Commande | Ce qui est testé |
|---|---|---|
| Unitaires | `npm run test:unit` | Une brique à la fois : outils (mémoire, rappels, listes, réglages, météo), mémoire longue (migration et index plein texte, isolation de la recherche, fiches, relecture d'un document et ses refus, archives, garde-fous et rythme du ménage), groupes (isolation entre groupe et membres, mentions, budget), missions (lancement, limites, isolation, contexte d'un passage, export), voix, veille, météo, export, configuration, garde-fous du navigateur, mise en forme. Les services externes sont simulés. |
| Intégration | `npm run test:integration` | Plusieurs briques réelles ensemble : boucle de l'agent avec SQLite (historique en ajout seul, cache, refus, étapes bornées), bot grammY, groupes (à qui Koto répond, rattachement, budget, contexte sans donnée personnelle, outils refusés, rappels et relances du groupe), missions (passages silencieux ou qui préviennent, plafonds, date limite, erreurs, groupe, mail préparé, `/missions` et ses boutons), mémoire longue (fiche d'un document dans la boucle de l'agent, `search_history` en ajout seul et isolé, `open_document` : un seul par tour, isolé, `file_id` expiré, ménage lancé par le scheduler : modèle, coût, payeur d'un groupe, budget, refus), scheduler, sous-agent web dans un vrai Chrome, page d'appel dans un vrai Chrome avec un micro simulé (détection de la voix, envoi de la phrase, réponse jouée, raccrochage), sauvegardes. |
| Système | `npm run test:system` | Le vrai Koto (`src/index.ts`) tourne dans un processus à part, face à un faux Telegram et un faux OpenRouter locaux. Le test joue un parcours complet : invitation refusée, accueil, liste cochée d'un geste, vocal transcrit puis réponse vocale, rappel vocal à l'heure, brief, groupe (ajout, message ignoré, mention, liste et rappel du groupe, résumé), mission (lancée dans la conversation, premier passage silencieux, passage qui prévient, `/missions` et Arrêter), mémoire longue (PDF et sa fiche, recherche dans le passé, ménage de 61 souvenirs et `/memoire`, PDF rouvert par une personne invitée, celui d'un autre refusé, fichier expiré chez Telegram), appel en direct (bouton, phrase transcrite, réponse parlée, intrus refusé), export, budget, arrêt propre. |
| Réels | `npm run test:live` | Les vrais services, avec les clés de `.env` : Telegram, Haiku via OpenRouter, deux passages de mission (l'un se tait, l'autre prévient), fiche d'un vrai PDF puis recherche dans le passé, un vrai PDF rouvert avec `open_document`, un vrai ménage de la mémoire, voix gratuite et Kokoro, un vrai vocal Telegram (OGG/Opus, fabriqué avec Chrome) transcrit, flux RSS, CoinGecko, MET Norway, OpenStreetMap. À lancer à la main, pour environ 0,01 $. |

Pour le test système, les adresses des services se changent par variables d'environnement (`TELEGRAM_API_ROOT`, `OPENROUTER_BASE_URL`, `KOTO_SCHEDULER_INTERVAL_MS`) ; en production, on ne les touche pas.

## Dépannage

`npm test` échoue avec « Cannot find native binding » (module `rolldown` de vitest) : c'est un bug connu de npm avec les dépendances optionnelles, qui revient parfois après un `npm install <paquet>`. Pour le réparer :
```bash
npm install --no-save @rolldown/binding-linux-x64-gnu@$(node -p "require('./node_modules/rolldown/package.json').optionalDependencies['@rolldown/binding-linux-x64-gnu']")
```

## Pour la suite

Ce que la v1 ne fait pas encore, à ajouter plus tard :
- **WhatsApp**, avec ses appels entrants gratuits (API Calling de Meta) : il faut un compte Meta Business vérifié et un numéro dédié.
- **Vrais appels téléphoniques** (numéro classique) : payants à la minute chez un opérateur, donc pour une future offre payante.
- **Sources de contexte** : GitHub pour suivre tes projets de code, Notion ou Todoist (n'importe quel serveur MCP).
- **Navigateur hébergé** (Browserbase…) avec un lien « vue en direct », pour que chaque utilisateur puisse prendre la main depuis son téléphone, même quand Koto tourne sur un serveur.
- **Appels téléphoniques** (agent vocal) et **paiements MVola**, avec plafonds et confirmation.
- **Données** : chiffrement au repos.
