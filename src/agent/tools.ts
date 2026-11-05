import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { applySettings } from '../accounts.js';
import { TOOLKIT_LABELS, actionLabel, needsConfirmation, toolkitOf, type Toolkit } from '../integrations/catalog.js';
import type { IntegrationToolDefinition, Integrations } from '../integrations/types.js';
import { openDocument, type DocumentBlock, type FileFetcher } from '../memory/documents.js';
import { searchPast } from '../memory/search.js';
import { MISSION_LIMITS, formatUsd, rhythmLabel, type MissionSettings } from '../missions/missions.js';
import { formatForecast, type WeatherService } from '../weather.js';
import {
  MEMORY_KINDS,
  VOICE_MODES,
  normalizeListName,
  type BrowserTask,
  type ListItem,
  type PendingAction,
  type Store,
  type User,
  type UserSettingsPatch,
  type VoiceMode,
} from '../store.js';
import {
  REPEATS,
  REPEAT_LABELS,
  formatDateTime,
  formatStamp,
  isValidHHMM,
  isValidTimezone,
  parseLocalDateTime,
} from '../time.js';

type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

export const LIMITS = {
  memories: 300,
  memoryChars: 600,
  pendingJobs: 100,
  jobTextChars: 500,
  scheduleAheadMs: 730 * 24 * 3600_000,
  scheduleMinDelayMs: 30_000,
  newsTopicsChars: 200,
  openListItems: 200,
  listItemChars: 200,
};

const KIND_DOC =
  "about = qui est la personne (métier, ville, situation) ; project = un projet en cours et où il en est ; " +
  'priority = ce qui compte le plus pour elle en ce moment ; goal = un objectif à plus long terme ; ' +
  "person = quelqu'un d'important pour elle (prénom, lien, détails utiles comme un anniversaire) ; " +
  "preference = goûts, habitudes, façon dont elle veut être aidée ; note = autre info durable.";

// Les définitions sont des constantes : le tableau `tools` est identique pour tous les
// utilisateurs, ce qui permet de partager le cache de prompt entre eux.
const CLIENT_TOOLS: BetaTool[] = [
  {
    name: 'remember',
    description:
      "Enregistre dans ta mémoire long terme une info durable et utile sur la personne. Appelle-le dès que tu apprends quelque chose qui t'aidera plus tard : un projet en cours et son état, une priorité, un objectif, une personne importante, une préférence, une info de vie. Une seule info par appel, formulée comme une phrase autonome compréhensible hors contexte. Jamais de secrets (mots de passe, codes, numéros de carte). Si l'info existe déjà, utilise update_memory.",
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: KIND_DOC },
        content: {
          type: 'string',
          description: "L'info en une phrase autonome, ex : « Projet Koto : agent IA perso sur Telegram, v1 en développement ».",
        },
        importance: {
          type: 'integer',
          enum: [1, 2, 3],
          description: '3 = central pour elle en ce moment, 2 = normal, 1 = détail.',
        },
      },
      required: ['kind', 'content', 'importance'],
    },
  },
  {
    name: 'update_memory',
    description:
      "Met à jour un souvenir existant (son id [n] figure dans <memoire>) quand l'info évolue : un projet avance, une priorité change, une date se précise. Préfère-le à remember pour éviter les doublons. Ne renseigne que les champs qui changent. restore=true remet dans <memoire> un souvenir archivé par le ménage (messages « 🧹 »).",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Id du souvenir, tel que [12] dans <memoire>.' },
        content: { type: 'string', description: 'Nouvelle formulation complète.' },
        importance: { type: 'integer', enum: [1, 2, 3] },
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        restore: { type: 'boolean', description: 'true pour remettre un souvenir archivé dans la mémoire active.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forget',
    description: "Supprime définitivement un souvenir (actif ou archivé) devenu faux ou inutile, ou que la personne te demande d'oublier.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Id du souvenir, tel que [12] dans <memoire>.' } },
      required: ['id'],
    },
  },
  {
    name: 'search_history',
    description:
      "Cherche dans tout l'historique de vos échanges, bien au-delà des derniers messages que tu vois : conversations passées, photos et documents reçus (avec leur fiche), messages des missions, ménages de ta mémoire. Renvoie des extraits datés. Gratuit : dès qu'on évoque une chose passée que tu ne vois ni dans <memoire> ni plus haut, cherche avant de dire que tu ne sais pas.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Quelques mots-clés précis (nom, sujet, chiffre), pas une phrase : « devis Rado toiture », « facture Jirama ».',
        },
        from: { type: 'string', description: 'Depuis ce jour inclus (AAAA-MM-JJ), si la période compte.' },
        to: { type: 'string', description: "Jusqu'à ce jour inclus (AAAA-MM-JJ)." },
        documents: { type: 'boolean', description: 'true : seulement les photos et documents reçus ; sans query, liste les derniers reçus.' },
      },
    },
  },
  {
    name: 'list_scheduled',
    description: 'Liste les rappels et relances à venir de la personne, avec leurs id.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_scheduled',
    description: 'Annule un rappel ou une relance à venir (id donné par <a_venir> ou list_scheduled).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
];

/** Options du Koto qui ajoutent des champs aux outils (fixées au démarrage : mêmes outils pour tous). */
export interface ToolFeatures {
  /** Réponses vocales (synthèse vocale configurée). */
  speech: boolean;
  /** Veille d'actualité dans le brief. */
  news: boolean;
  /** Météo et lieu (sources gratuites). */
  weather?: boolean;
  /** Missions de fond ; absent = mission_start et mission_update absents. */
  missions?: MissionSettings | null;
}

const WEATHER_TOOLS: BetaTool[] = [
  {
    name: 'weather',
    description:
      "Prévisions météo gratuites (MET Norway), jour par jour : températures, pluie, temps dominant. Préfère-le à la recherche web pour toute question météo. Sans `place`, utilise le lieu de la personne (<personne>).",
    input_schema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Ville ou lieu, si ce n’est pas le sien (ex : « Toamasina », « Paris »).' },
        days: { type: 'integer', description: 'Nombre de jours à partir d’aujourd’hui (1 à 7, 2 par défaut).' },
      },
    },
  },
  {
    name: 'set_location',
    description:
      "Enregistre la ville où vit la personne (pour la météo de son brief) quand elle te la dit. Elle peut aussi partager sa position Telegram (📎 → Position).",
    input_schema: {
      type: 'object',
      properties: { place: { type: 'string', description: 'Ville, avec le pays si ambigu (ex : « Antananarivo », « Saint-Denis, La Réunion »).' } },
      required: ['place'],
    },
  },
];

function scheduleTool(features: ToolFeatures): BetaTool {
  return {
    name: 'schedule',
    description:
      "Programme un message futur. kind=reminder : la personne t'a demandé un rappel ; `text` lui sera envoyé tel quel à l'heure dite, écris-le donc comme le rappel final (ex : « Appeler Rado pour le devis »). kind=checkin : tu reviendras toi-même vers elle sur un sujet qui compte (entretien, rendez-vous, échéance) ; `text` décrit le sujet et ce que tu veux savoir, tu rédigeras le message le moment venu. `when` est l'heure locale de la personne.",
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['reminder', 'checkin'] },
        when: { type: 'string', description: 'Date et heure locales au format AAAA-MM-JJTHH:MM, ex : 2026-10-16T09:00.' },
        text: { type: 'string' },
        repeat: { type: 'string', enum: [...REPEATS], description: 'Répétition ; « none » par défaut.' },
        ...(features.speech
          ? { voice: { type: 'boolean', description: "true pour l'envoyer aussi en message vocal (« rappel vocal »)." } }
          : {}),
      },
      required: ['kind', 'when', 'text'],
    },
  };
}

function settingsTool(features: ToolFeatures): BetaTool {
  const topics = [
    "comment l'appeler, son fuseau horaire, l'activation ou l'heure du brief du matin",
    features.speech ? 'ses réponses vocales et le brief en vocal' : null,
    features.news ? 'les sujets de veille de son brief' : null,
  ].filter(Boolean);
  return {
    name: 'update_settings',
    description: `Change les réglages de la personne quand elle le demande : ${topics.join(', ')}. Ne renseigne que ce qui change.`,
    input_schema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: "Prénom ou surnom à utiliser pour s'adresser à elle." },
        timezone: { type: 'string', description: 'Fuseau IANA, ex : Indian/Antananarivo, Europe/Paris, America/Montreal.' },
        brief_enabled: { type: 'boolean' },
        brief_time: { type: 'string', description: 'Heure locale du brief, format HH:MM.' },
        ...(features.speech
          ? {
              voice_replies: {
                type: 'string',
                enum: [...VOICE_MODES],
                description: "Réponses vocales : off = jamais, mirror = quand elle t'envoie un vocal (par défaut), always = à chaque réponse.",
              },
              brief_voice: { type: 'boolean', description: 'Brief du matin aussi envoyé en vocal.' },
            }
          : {}),
        ...(features.news
          ? {
              news_topics: {
                type: 'string',
                description: "Sujets de veille du brief, ex : « crypto (Bitcoin, Ethereum, RLC), IA ». Chaîne vide pour arrêter la veille.",
              },
            }
          : {}),
      },
    },
  };
}

const LIST_TOOLS: BetaTool[] = [
  {
    name: 'list_add',
    description:
      "Ajoute des éléments à une liste de la personne (courses, tâches, à lire, cadeaux, valise…), créée au besoin. Un élément = une chose courte ; ce qui est déjà dans <listes> n'est pas ajouté deux fois.",
    input_schema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Nom court de la liste, ex : « courses », « tâches », « à lire ».' },
        items: { type: 'array', items: { type: 'string' }, description: 'Éléments à ajouter (20 au plus).' },
      },
      required: ['list', 'items'],
    },
  },
  {
    name: 'list_update',
    description:
      "Met à jour les listes : done = cocher (c'est fait, acheté), undo = décocher, remove = supprimer (erreur, plus besoin), clear_done = vider les éléments cochés d'une liste. Les ids [n] sont dans <listes>.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['done', 'undo', 'remove', 'clear_done'] },
        ids: { type: 'array', items: { type: 'integer' }, description: 'Éléments concernés (sauf pour clear_done).' },
        list: { type: 'string', description: 'Pour clear_done : la liste à vider (toutes si absent).' },
      },
      required: ['action'],
    },
  },
];

const OPEN_DOCUMENT_TOOL: BetaTool = {
  name: 'open_document',
  description:
    "Rouvre une photo ou un PDF reçu plus tôt pour le relire en entier, quand sa fiche ne suffit pas : le texte exact d'une clause, un chiffre, un détail d'une photo. Son id (#n) vient de search_history. Bien plus coûteux qu'une recherche : seulement si la fiche ne répond pas, et un seul document par tour.",
  input_schema: {
    type: 'object',
    properties: { id: { type: 'integer', description: 'Id du document, tel que « document #12 » dans les résultats de search_history.' } },
    required: ['id'],
  },
};

const REPLY_BY_VOICE_TOOL: BetaTool = {
  name: 'reply_by_voice',
  description:
    "Envoie aussi ta réponse de ce tour en message vocal, lu juste après le texte. Pour une demande ponctuelle (« réponds-moi en vocal », « dis-le-moi à l'oral ») ; pour une préférence durable, utilise update_settings. Écris alors ta réponse pour l'oral.",
  input_schema: { type: 'object', properties: {} },
};

function clientTools(features: ToolFeatures): BetaTool[] {
  const [remember, updateMemory, forget, search, list, cancel] = CLIENT_TOOLS;
  return [
    remember!,
    updateMemory!,
    forget!,
    search!,
    OPEN_DOCUMENT_TOOL,
    scheduleTool(features),
    list!,
    cancel!,
    ...LIST_TOOLS,
    settingsTool(features),
    ...(features.weather ? WEATHER_TOOLS : []),
    ...(features.speech ? [REPLY_BY_VOICE_TOOL] : []),
  ];
}

const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, max_content_tokens: 12_000 },
] satisfies BetaToolUnion[];

const CONFIRMATION_NOTE =
  ' IMPORTANT : cet outil ne fait que préparer l’action ; elle ne part qu’après le « ✅ Confirmer » de la personne sous ton message.';

/** Outils d'intégration (Gmail, Agenda) au format de l'API, dans l'ordre fixe du catalogue. */
export function integrationTools(definitions: IntegrationToolDefinition[]): BetaTool[] {
  return definitions.map((d) => ({
    name: d.name,
    description: needsConfirmation(d.name) ? `${d.description}${CONFIRMATION_NOTE}` : d.description,
    input_schema: { ...d.inputSchema, type: 'object' },
  }));
}

const BROWSE_TOOL: BetaTool = {
  name: 'browse_web',
  description:
    "Ouvre un vrai navigateur pour accomplir une tâche sur un site : chercher avec des filtres, comparer des offres, remplir un formulaire, préparer une réservation ou une commande. À utiliser quand la recherche web ne suffit pas (il faut cliquer, remplir, naviguer). La tâche tourne en arrière-plan pendant quelques minutes : dis à la personne que tu t'en occupes, le résultat lui sera envoyé automatiquement. Tout paiement, envoi ou réservation lui sera soumis pour confirmation.",
  input_schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: "Objectif précis et complet : quoi, où, quand, budget, préférences tirées de la mémoire, ce qu'il faut rapporter.",
      },
      start_url: { type: 'string', description: 'Site de départ si tu le connais (https://…).' },
    },
    required: ['task'],
  },
};

/** Outils des missions : leurs textes ne dépendent que de la configuration, jamais de la personne. */
function missionTools(settings: MissionSettings): BetaTool[] {
  const minHours = String(settings.minHours).replace('.', ',');
  return [
    {
      name: 'mission_start',
      description:
        "Lance une mission : un suivi de fond que tu mènes en arrière-plan, passage après passage, pendant plusieurs jours (surveiller un prix ou un sujet, préparer un dossier pour une date, vérifier qu'une réponse arrive). Chaque passage cherche, sources gratuites d'abord, tient ses notes et ne prévient la personne que s'il y a un résultat (seuil franchi, rapport prêt, question à poser). Un passage ne voit que ce que tu écris ici : ni la conversation, ni ta mémoire.",
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Nom court, ex : « Vol Tana → Paris du 4 déc. ».' },
          goal: {
            type: 'string',
            description:
              "Objectif complet et autonome : quoi suivre ou préparer, où chercher, critères, préférences utiles tirées de ta mémoire, ce qu'il faut rapporter.",
          },
          done_when: { type: 'string', description: 'Condition de fin vérifiable, ex : « prix sous 600 € », « dossier prêt », « Rado a répondu au devis ».' },
          every_hours: {
            type: 'number',
            description: `Heures entre deux passages (${minHours} au minimum, 24 par défaut) : la plus lente qui suffit, chaque passage coûte (6 pour un prix, 24 pour un dossier).`,
          },
          deadline: {
            type: 'string',
            description: 'Date et heure locales du dernier passage, qui conclut la mission (rapport, bilan ou proposition), au format AAAA-MM-JJTHH:MM.',
          },
          max_cost_usd: {
            type: 'number',
            description: `Plafond de coût de toute la mission, en dollars (${formatUsd(settings.defaultMaxCostUsd)} par défaut, ${formatUsd(MISSION_LIMITS.maxCostUsd)} au plus).`,
          },
        },
        required: ['title', 'goal', 'done_when', 'deadline'],
      },
    },
    {
      name: 'mission_update',
      description:
        "Modifie une mission en cours (ids dans <missions>) : note = lui transmettre une consigne, ou la réponse de la personne à sa question ; every_hours ou deadline = changer son rythme ou sa date limite ; stop = l'arrêter.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Id de la mission, tel que #3 dans <missions>.' },
          note: { type: 'string', description: 'Consigne ou réponse à transmettre, en une ou deux phrases autonomes.' },
          every_hours: { type: 'number', description: `Nouveau rythme, en heures (${minHours} au minimum).` },
          deadline: { type: 'string', description: 'Nouvelle date limite, heure locale, AAAA-MM-JJTHH:MM.' },
          stop: { type: 'boolean', description: 'true pour arrêter la mission.' },
        },
        required: ['id'],
      },
    },
  ];
}

export function buildTools(
  webTools: boolean,
  integrations: IntegrationToolDefinition[] = [],
  browser = false,
  features: ToolFeatures = { speech: false, news: false },
): BetaToolUnion[] {
  return [
    ...clientTools(features),
    ...(features.missions ? missionTools(features.missions) : []),
    ...integrationTools(integrations),
    ...(browser ? [BROWSE_TOOL] : []),
    ...(webTools ? WEB_TOOLS : []),
  ];
}

/** Lance les tâches dans le navigateur (implémenté par BrowserTasks). */
export interface BrowserLauncher {
  start(user: User, goal: string, startUrl: string | null): { ok: true; task: BrowserTask } | { ok: false; reason: 'busy'; task: BrowserTask };
}

// ------------------------------------------------------------------ exécution

export interface ToolContext {
  store: Store;
  userId: number;
  now: number;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Photo ou PDF rouvert (open_document), joint au tool_result après le texte. */
  block?: DocumentBlock;
}

class ToolInputError extends Error {}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const fail = (content: string): ToolOutcome => ({ content, isError: true });

const memoryId = z.number().int().positive();
const importance = z.number().int().min(1).max(3);

const schemas = {
  remember: z.object({
    kind: z.enum(MEMORY_KINDS),
    content: z.string().trim().min(1).max(LIMITS.memoryChars),
    importance: importance.default(2),
  }),
  update_memory: z.object({
    id: memoryId,
    content: z.string().trim().min(1).max(LIMITS.memoryChars).optional(),
    importance: importance.optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    restore: z.boolean().default(false),
  }),
  forget: z.object({ id: memoryId }),
  open_document: z.object({ id: z.number().int().positive() }),
  search_history: z.object({
    query: z.string().trim().max(200).optional(),
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
    documents: z.boolean().default(false),
  }),
  schedule: z.object({
    kind: z.enum(['reminder', 'checkin']),
    when: z.string().trim(),
    text: z.string().trim().min(1).max(LIMITS.jobTextChars),
    repeat: z.enum(REPEATS).default('none'),
    voice: z.boolean().default(false),
  }),
  list_scheduled: z.object({}),
  cancel_scheduled: z.object({ id: z.number().int().positive() }),
  update_settings: z.object({
    display_name: z.string().trim().max(60).optional(),
    timezone: z.string().trim().optional(),
    brief_enabled: z.boolean().optional(),
    brief_time: z.string().trim().optional(),
    voice_replies: z.enum(VOICE_MODES).optional(),
    brief_voice: z.boolean().optional(),
    news_topics: z.string().trim().max(LIMITS.newsTopicsChars).optional(),
  }),
  browse_web: z.object({
    task: z.string().trim().min(5).max(2_000),
    start_url: z.string().trim().url().optional(),
  }),
  list_add: z.object({
    list: z.string().trim().min(1).max(40),
    items: z.array(z.string().trim().min(1).max(LIMITS.listItemChars)).min(1).max(20),
  }),
  list_update: z.object({
    action: z.enum(['done', 'undo', 'remove', 'clear_done']),
    ids: z.array(z.number().int().positive()).max(50).default([]),
    list: z.string().trim().min(1).max(40).optional(),
  }),
  weather: z.object({
    place: z.string().trim().min(2).max(100).optional(),
    days: z.number().int().min(1).max(7).default(2),
  }),
  set_location: z.object({ place: z.string().trim().min(2).max(100) }),
  mission_start: z.object({
    title: z
      .string()
      .trim()
      .min(2)
      .transform((title) => title.slice(0, MISSION_LIMITS.titleChars)),
    goal: z.string().trim().min(10).max(MISSION_LIMITS.goalChars),
    done_when: z.string().trim().min(2).max(MISSION_LIMITS.doneWhenChars),
    every_hours: z.number().positive().max(24 * 30).default(24),
    deadline: z.string().trim(),
    max_cost_usd: z.number().positive().optional(),
  }),
  mission_update: z.object({
    id: z.number().int().positive(),
    note: z.string().trim().min(1).max(MISSION_LIMITS.noteChars).optional(),
    every_hours: z.number().positive().max(24 * 30).optional(),
    deadline: z.string().trim().optional(),
    stop: z.boolean().default(false),
  }),
};

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || 'entrée'} : ${i.message}`).join(' ; ');
    throw new ToolInputError(`Entrée invalide — ${details}`);
  }
  return result.data;
}

// Garde-fou en plus de la consigne du prompt : on ne stocke pas ce qui ressemble à un secret.
// `\b` ignore les lettres accentuées en JS : on délimite les mots avec des classes Unicode.
const SECRET_PATTERNS = [
  /\b(?:\d[ -]?){13,19}\b/, // numéro de carte ou IBAN
  // « mot de passe [Gmail] est … », « clé privée : … », « PIN code = … »
  /(?<![\p{L}\p{N}_])(?:mot de passe|password|passwd|mdp|code pin|pin code|code secret|cvv|cvc|clé privée|private key|seed phrase|phrase de récupération|api key|clé api)(?![\p{L}\p{N}_])(?:\s+\S+){0,3}?\s*(?:[:=]|(?<![\p{L}\p{N}_])(?:est|is)(?![\p{L}\p{N}_]))\s*\S+/iu,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

const SECRET_REFUSAL =
  "Refusé : ce contenu ressemble à un secret (mot de passe, code, numéro de carte). Ne le garde pas et explique gentiment à la personne que tu ne stockes pas ce genre d'info.";

const JOB_LABELS = { reminder: 'rappel', checkin: 'relance', brief: 'brief' } as const;

export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolOutcome {
  try {
    switch (name) {
      case 'remember':
        return remember(parse(schemas.remember, input), ctx);
      case 'update_memory':
        return updateMemory(parse(schemas.update_memory, input), ctx);
      case 'forget': {
        const { id } = parse(schemas.forget, input);
        return ctx.store.deleteMemory(ctx.userId, id) ? ok(`Souvenir [${id}] supprimé.`) : fail(`Aucun souvenir [${id}] pour cette personne.`);
      }
      case 'search_history':
        return searchPast(ctx.store, ctx.store.getUserById(ctx.userId)!, parse(schemas.search_history, input ?? {}));
      case 'schedule':
        return schedule(parse(schemas.schedule, input), ctx);
      case 'list_scheduled':
        parse(schemas.list_scheduled, input ?? {});
        return listScheduled(ctx);
      case 'cancel_scheduled': {
        const { id } = parse(schemas.cancel_scheduled, input);
        return ctx.store.cancelJob(ctx.userId, id) ? ok(`#${id} annulé.`) : fail(`Aucun rappel ni relance #${id} à venir pour cette personne.`);
      }
      case 'update_settings':
        return updateSettings(parse(schemas.update_settings, input), ctx);
      case 'list_add':
        return listAdd(parse(schemas.list_add, input), ctx);
      case 'list_update':
        return listUpdate(parse(schemas.list_update, input), ctx);
      default:
        return fail(`Outil inconnu : ${name}`);
    }
  } catch (err) {
    if (err instanceof ToolInputError) return fail(err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ intégrations (Gmail, Agenda)

export interface TurnToolContext extends ToolContext {
  integrations: Integrations | null;
  /** Navigateur ; absent = browse_web désactivé. */
  browser?: BrowserLauncher | null;
  /** Actions créées pendant le tour, à présenter avec leurs boutons Confirmer / Annuler. */
  pending: PendingAction[];
  /** Toolkits dont l'état a déjà été revérifié chez le fournisseur pendant ce tour. */
  checked: Set<Toolkit>;
  /** Réponse vocale demandée pendant ce tour (reply_by_voice) ; absent = réponses vocales désactivées. */
  voice?: { requested: boolean } | null;
  /** Météo et lieux ; absent = outils météo désactivés. */
  weather?: WeatherService | null;
  /** Réglages des missions ; absent = missions désactivées. */
  missions?: MissionSettings | null;
  /** Fichiers reçus à rouvrir (open_document), un seul par tour ; absent = pas de téléchargeur (CLI). */
  files?: { fetch: FileFetcher; opened: boolean } | null;
}

const ACCESS_LOST = /no (active )?connected account|not connected|invalid_grant|unauthori[sz]ed|token (has been )?(expired|revoked)/i;

const PRIVATE_ONLY_IN_GROUP =
  "Pas dans un groupe : Gmail, l'agenda et les tâches web sont personnels. Propose à la personne de te le demander en privé.";

/** Le compte du tour est-il un groupe ? Lu en base : ce garde-fou ne dépend pas de l'appelant. */
function isGroupAccount(ctx: ToolContext): boolean {
  return ctx.store.getUserById(ctx.userId)?.kind === 'group';
}

/** Exécute n'importe quel outil client : outils locaux de Koto ou outils d'intégration. */
export async function runTool(name: string, input: unknown, ctx: TurnToolContext): Promise<ToolOutcome> {
  // Mêmes outils pour tous (cache de prompt) : en groupe, les outils personnels refusent ici.
  if ((name === 'browse_web' || toolkitOf(name)) && isGroupAccount(ctx)) return fail(PRIVATE_ONLY_IN_GROUP);
  if (name === 'browse_web') return startBrowse(input, ctx);
  if (name === 'reply_by_voice') {
    if (!ctx.voice) return fail("Les réponses vocales ne sont pas activées sur ce Koto : réponds par écrit et dis-le simplement.");
    ctx.voice.requested = true;
    return ok('Ta réponse partira aussi en vocal, juste après le texte : écris-la pour être écoutée (phrases courtes, pas de tableau ni de liste longue).');
  }
  if (name === 'weather' || name === 'set_location') return runWeatherTool(name, input, ctx);
  if (name === 'mission_start' || name === 'mission_update') return runMissionTool(name, input, ctx);
  if (name === 'open_document') return reopenDocument(input, ctx);
  const toolkit = toolkitOf(name);
  if (!toolkit) return executeTool(name, input, ctx);
  if (!ctx.integrations) return fail('Les intégrations ne sont pas activées sur ce Koto.');

  const label = TOOLKIT_LABELS[toolkit];
  if (!(await ensureConnected(ctx, toolkit))) {
    return fail(`${label} n'est pas connecté pour cette personne. Propose-lui d'envoyer /connecter (ça prend 30 secondes).`);
  }

  const args = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (needsConfirmation(name)) {
    const action = ctx.store.addPendingAction(ctx.userId, name, args, ctx.now);
    ctx.pending.push(action);
    return ok(
      `Action préparée (#${action.id}) : ${actionLabel(name)}. Elle n'est PAS encore faite : la personne doit appuyer sur « ✅ Confirmer » sous ton message. Dis-lui en une phrase ce que tu as préparé.`,
    );
  }

  const user = ctx.store.getUserById(ctx.userId)!;
  const result = await ctx.integrations.execute(user, name, args);
  if (result.isError && ACCESS_LOST.test(result.text)) ctx.store.setConnection(ctx.userId, toolkit, false, ctx.now);
  return { content: result.text, isError: result.isError };
}

/** Météo et lieu ; sert aussi aux passages de mission (météo seulement : une mission ne change aucun réglage). */
export async function runWeatherTool(
  name: 'weather' | 'set_location',
  input: unknown,
  ctx: Pick<TurnToolContext, 'store' | 'userId' | 'now' | 'weather'>,
): Promise<ToolOutcome> {
  if (!ctx.weather) return fail("La météo n'est pas activée sur ce Koto.");
  try {
    const user = ctx.store.getUserById(ctx.userId)!;
    if (name === 'set_location') {
      const { place } = parse(schemas.set_location, input);
      const found = await ctx.weather.geocode(place);
      if (!found) return fail(`Lieu introuvable : « ${place} ». Demande une précision (ville et pays).`);
      applySettings(ctx.store, ctx.userId, { place: found }, ctx.now);
      return ok(`Lieu enregistré : ${found.name}. Si son fuseau horaire n'est plus ${user.timezone}, change-le aussi (update_settings).`);
    }
    const { place, days } = parse(schemas.weather, input ?? {});
    const where = place ? await ctx.weather.geocode(place) : user.place;
    if (!where) {
      return fail(
        place
          ? `Lieu introuvable : « ${place} ».`
          : "Je ne connais pas son lieu : demande-lui sa ville (set_location) ou propose-lui de partager sa position (📎 → Position).",
      );
    }
    const forecast = await ctx.weather.forecast(where, days, user.timezone, ctx.now);
    if (forecast.length === 0) return fail('Pas de prévision disponible pour ce lieu.');
    return ok(`Météo à ${where.name} (source : MET Norway) :\n${formatForecast(forecast, user.timezone)}`);
  } catch (err) {
    if (err instanceof ToolInputError) return fail(err.message);
    return fail(`Service météo indisponible pour le moment (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** open_document : un seul document par tour (le relire coûte des tokens), toujours parmi ceux du compte. */
async function reopenDocument(input: unknown, ctx: TurnToolContext): Promise<ToolOutcome> {
  if (!ctx.files) return fail("Rouvrir un document n'est pas possible ici : appuie-toi sur sa fiche (search_history), ou propose à la personne de te le renvoyer.");
  try {
    const { id } = parse(schemas.open_document, input);
    if (ctx.files.opened) return fail('Un seul document rouvert par tour : réponds avec celui que tu as déjà ; la personne pourra te redemander le suivant.');
    const outcome = await openDocument(ctx.store, ctx.store.getUserById(ctx.userId)!, id, ctx.files.fetch);
    if (!outcome.isError) ctx.files.opened = true;
    return outcome;
  } catch (err) {
    if (err instanceof ToolInputError) return fail(err.message);
    throw err;
  }
}

function startBrowse(input: unknown, ctx: TurnToolContext): ToolOutcome {
  if (!ctx.browser) return fail("Le navigateur n'est pas activé sur ce Koto.");
  try {
    const { task, start_url } = parse(schemas.browse_web, input);
    const user = ctx.store.getUserById(ctx.userId)!;
    const started = ctx.browser.start(user, task, start_url ?? null);
    if (!started.ok) {
      return fail(
        `Une tâche web est déjà en cours (#${started.task.id} : « ${started.task.goal.slice(0, 80)} »). Propose d'attendre qu'elle finisse, ou /taches pour l'annuler.`,
      );
    }
    return ok(
      `Tâche web #${started.task.id} lancée en arrière-plan. Dis à la personne en une phrase que tu t'en occupes et que le résultat arrivera ici ; n'invente aucun résultat.`,
    );
  } catch (err) {
    if (err instanceof ToolInputError) return fail(err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ missions

const HOUR_MS = 3_600_000;
/** Une date limite doit laisser le temps d'au moins un passage. */
const MISSION_MIN_LEAD_MS = 10 * 60_000;

function runMissionTool(name: 'mission_start' | 'mission_update', input: unknown, ctx: TurnToolContext): ToolOutcome {
  if (!ctx.missions) return fail("Les missions ne sont pas activées sur ce Koto : propose plutôt une relance (schedule, checkin).");
  try {
    return name === 'mission_start'
      ? missionStart(parse(schemas.mission_start, input), ctx.missions, ctx)
      : missionUpdate(parse(schemas.mission_update, input), ctx.missions, ctx);
  } catch (err) {
    if (err instanceof ToolInputError) return fail(err.message);
    throw err;
  }
}

/** Date limite au format local, entre maintenant (+10 min) et la durée maximale d'une mission. */
function missionDeadline(value: string, user: User, now: number): number | string {
  const deadlineAt = parseLocalDateTime(value, user.timezone);
  if (deadlineAt === null) return `Date limite invalide « ${value} » : utilise AAAA-MM-JJTHH:MM, à l'heure locale (${user.timezone}).`;
  if (deadlineAt < now + MISSION_MIN_LEAD_MS) return `Cette date limite est trop proche ou déjà passée : il est ${formatDateTime(now, user.timezone)} (${user.timezone}).`;
  if (deadlineAt > now + MISSION_LIMITS.maxDays * 24 * HOUR_MS) return `Date limite trop lointaine : ${MISSION_LIMITS.maxDays} jours au plus.`;
  return deadlineAt;
}

function missionStart(input: z.infer<typeof schemas.mission_start>, settings: MissionSettings, ctx: ToolContext): ToolOutcome {
  if ([input.title, input.goal, input.done_when].some(looksSecret)) return fail(SECRET_REFUSAL);
  if (ctx.store.countActiveMissions(ctx.userId) >= MISSION_LIMITS.active) {
    return fail(`Déjà ${MISSION_LIMITS.active} missions en cours : propose d'en arrêter une (/missions) avant d'en lancer une autre.`);
  }
  const user = ctx.store.getUserById(ctx.userId)!;
  const deadlineAt = missionDeadline(input.deadline, user, ctx.now);
  if (typeof deadlineAt === 'string') return fail(deadlineAt);
  const adjusted: string[] = [];
  const hours = Math.max(input.every_hours, settings.minHours);
  const intervalMinutes = Math.round(hours * 60);
  if (hours > input.every_hours) adjusted.push(`rythme ramené au minimum : ${rhythmLabel(intervalMinutes)}`);
  const requested = input.max_cost_usd ?? settings.defaultMaxCostUsd;
  const maxCostUsd = Math.min(Math.max(requested, 0.01), MISSION_LIMITS.maxCostUsd);
  if (maxCostUsd < requested) adjusted.push(`plafond ramené au maximum : ${formatUsd(maxCostUsd)}`);

  // Premier passage tout de suite : il fait le point (et prévient déjà si le seuil est atteint).
  const mission = ctx.store.addMission(
    ctx.userId,
    { title: input.title, goal: input.goal, doneWhen: input.done_when, intervalMinutes, deadlineAt, maxCostUsd, nextRunAt: ctx.now },
    ctx.now,
  );
  return ok(
    `Mission #${mission.id} lancée : « ${mission.title} », ${rhythmLabel(intervalMinutes)} jusqu'au ${formatDateTime(deadlineAt, user.timezone)} (${user.timezone}), plafond ${formatUsd(maxCostUsd)}${
      adjusted.length > 0 ? ` (${adjusted.join(' ; ')})` : ''
    }. Le premier passage part dans la minute. Dis-le à la personne en une phrase : elle ne sera prévenue que s'il y a un résultat, et /missions permet de suivre ou d'arrêter.`,
  );
}

function missionUpdate(input: z.infer<typeof schemas.mission_update>, settings: MissionSettings, ctx: ToolContext): ToolOutcome {
  const mission = ctx.store.getMission(ctx.userId, input.id);
  if (!mission || mission.status !== 'active') return fail(`Aucune mission #${input.id} en cours ici (voir <missions>).`);
  if (input.stop) {
    ctx.store.endMission(ctx.userId, mission.id, { status: 'stopped', reason: 'person' }, ctx.now);
    return ok(`Mission #${mission.id} arrêtée.`);
  }
  if (input.note === undefined && input.every_hours === undefined && input.deadline === undefined) {
    return fail('Rien à changer : précise note, every_hours, deadline ou stop.');
  }
  const user = ctx.store.getUserById(ctx.userId)!;
  const changes: string[] = [];
  let { intervalMinutes, deadlineAt, nextRunAt } = mission;
  if (input.deadline !== undefined) {
    const parsed = missionDeadline(input.deadline, user, ctx.now);
    if (typeof parsed === 'string') return fail(parsed);
    deadlineAt = parsed;
    changes.push(`date limite : ${formatDateTime(parsed, user.timezone)}`);
  }
  if (input.every_hours !== undefined) {
    intervalMinutes = Math.round(Math.max(input.every_hours, settings.minHours) * 60);
    // Le premier passage, pas encore parti, reste à sa place ; sinon le suivant se cale sur le nouveau rythme.
    if (mission.lastRunAt !== null) nextRunAt = Math.max(ctx.now + 60_000, mission.lastRunAt + intervalMinutes * 60_000);
    changes.push(`rythme : ${rhythmLabel(intervalMinutes)}`);
  }
  if (input.note !== undefined) {
    if (looksSecret(input.note)) return fail(SECRET_REFUSAL);
    // Une réponse à sa question doit servir vite : prochain passage dès que le rythme minimum le permet.
    nextRunAt = Math.min(nextRunAt, Math.max(ctx.now + 60_000, (mission.lastRunAt ?? 0) + settings.minHours * HOUR_MS));
    changes.push('consigne transmise');
  }
  if (deadlineAt !== null) nextRunAt = Math.min(nextRunAt, deadlineAt);
  const schedule = { intervalMinutes, deadlineAt, nextRunAt };
  ctx.store.transaction(() => {
    if (input.note !== undefined) {
      ctx.store.addMissionInstruction(ctx.userId, mission.id, `[${formatStamp(ctx.now, user.timezone)}] ${input.note}`, MISSION_LIMITS.instructionsChars, ctx.now);
    }
    ctx.store.updateMissionSchedule(ctx.userId, mission.id, schedule, ctx.now);
  });
  return ok(`Mission #${mission.id} mise à jour — ${changes.join(' · ')}. Prochain passage : ${formatDateTime(nextRunAt, user.timezone)}.`);
}

/** Connecté d'après le cache ; sinon on revérifie une fois par tour chez le fournisseur. */
async function ensureConnected(ctx: TurnToolContext, toolkit: Toolkit): Promise<boolean> {
  if (ctx.store.getConnections(ctx.userId)[toolkit]) return true;
  if (ctx.checked.has(toolkit) || !ctx.integrations) return false;
  ctx.checked.add(toolkit);
  try {
    const status = await ctx.integrations.connectionStatus(ctx.store.getUserById(ctx.userId)!);
    for (const [key, connected] of Object.entries(status)) ctx.store.setConnection(ctx.userId, key, connected, ctx.now);
    return status[toolkit];
  } catch {
    return false;
  }
}

function remember(input: z.infer<typeof schemas.remember>, ctx: ToolContext): ToolOutcome {
  if (looksSecret(input.content)) return fail(SECRET_REFUSAL);
  const existing = ctx.store.listMemories(ctx.userId);
  const duplicate = existing.find((m) => m.content.toLowerCase() === input.content.toLowerCase());
  if (duplicate) return ok(`Déjà en mémoire [${duplicate.id}].`);
  if (existing.length >= LIMITS.memories) {
    return fail(`Mémoire pleine (${LIMITS.memories} souvenirs). Fusionne ou supprime des souvenirs peu utiles avec update_memory / forget avant d'en ajouter.`);
  }
  const memory = ctx.store.addMemory(ctx.userId, input, ctx.now);
  return ok(`Mémorisé [${memory.id}] (${memory.kind}, importance ${memory.importance}).`);
}

function updateMemory(input: z.infer<typeof schemas.update_memory>, ctx: ToolContext): ToolOutcome {
  const { id, restore, ...patch } = input;
  const changes = patch.content !== undefined || patch.importance !== undefined || patch.kind !== undefined;
  if (!changes && !restore) return fail('Rien à mettre à jour : précise content, importance, kind ou restore.');
  if (patch.content !== undefined && looksSecret(patch.content)) return fail(SECRET_REFUSAL);
  const current = ctx.store.getMemory(ctx.userId, id);
  if (!current) return fail(`Aucun souvenir [${id}] pour cette personne.`);
  if (current.archivedAt !== null && !restore) {
    return fail(`Le souvenir [${id}] est aux archives : ajoute restore=true pour le remettre dans la mémoire active.`);
  }
  if (current.archivedAt !== null) {
    if (ctx.store.countMemories(ctx.userId) >= LIMITS.memories) {
      return fail(`Mémoire pleine (${LIMITS.memories} souvenirs) : fusionne ou supprime d'abord des souvenirs peu utiles.`);
    }
    ctx.store.restoreMemory(ctx.userId, id, ctx.now);
  }
  if (changes) ctx.store.updateMemory(ctx.userId, id, patch, ctx.now);
  return ok(current.archivedAt !== null ? `Souvenir [${id}] restauré${changes ? ' et mis à jour' : ''}.` : `Souvenir [${id}] mis à jour.`);
}

function schedule(input: z.infer<typeof schemas.schedule>, ctx: ToolContext): ToolOutcome {
  const user = ctx.store.getUserById(ctx.userId)!;
  const dueAt = parseLocalDateTime(input.when, user.timezone);
  if (dueAt === null) return fail(`Date invalide « ${input.when} » : utilise AAAA-MM-JJTHH:MM, à l'heure locale de la personne (${user.timezone}).`);
  if (dueAt < ctx.now + LIMITS.scheduleMinDelayMs) {
    return fail(`Cette date est déjà passée : il est ${formatDateTime(ctx.now, user.timezone)} (${user.timezone}).`);
  }
  if (dueAt > ctx.now + LIMITS.scheduleAheadMs) return fail('Trop loin dans le futur (2 ans maximum).');
  if (ctx.store.countPendingJobs(ctx.userId) >= LIMITS.pendingJobs) {
    return fail(`Trop de rappels en attente (${LIMITS.pendingJobs}). Propose d'en annuler.`);
  }
  const job = ctx.store.addJob(ctx.userId, { kind: input.kind, text: input.text, dueAt, repeat: input.repeat, voice: input.voice }, ctx.now);
  return ok(
    `Programmé #${job.id} : ${JOB_LABELS[job.kind]}${job.voice ? ' vocal' : ''} le ${formatDateTime(dueAt, user.timezone)} (${user.timezone}), ${REPEAT_LABELS[job.repeat]}.`,
  );
}

function listScheduled(ctx: ToolContext): ToolOutcome {
  const user = ctx.store.getUserById(ctx.userId)!;
  const jobs = ctx.store.listPendingJobs(ctx.userId, 50);
  if (jobs.length === 0) return ok('Aucun rappel ni relance à venir.');
  const lines = jobs.map(
    (j) => `#${j.id} · ${JOB_LABELS[j.kind]} · ${formatDateTime(j.dueAt, user.timezone)} · ${REPEAT_LABELS[j.repeat]} · « ${j.text} »`,
  );
  return ok(lines.join('\n'));
}

function updateSettings(input: z.infer<typeof schemas.update_settings>, ctx: ToolContext): ToolOutcome {
  const group = isGroupAccount(ctx);
  if (group && [input.brief_enabled, input.brief_time, input.brief_voice, input.news_topics].some((v) => v !== undefined)) {
    return fail(
      "Un groupe n'a ni brief du matin ni veille : ces réglages sont personnels et se font en privé. Pour le groupe, seuls le nom, le fuseau et les réponses vocales se règlent.",
    );
  }
  const patch: UserSettingsPatch = {};
  if (input.display_name !== undefined) patch.displayName = input.display_name || null;
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) {
      return fail(`Fuseau inconnu « ${input.timezone} » : utilise un nom IANA comme Europe/Paris ou Indian/Antananarivo.`);
    }
    patch.timezone = input.timezone;
  }
  if (input.brief_time !== undefined) {
    if (!isValidHHMM(input.brief_time)) return fail(`Heure invalide « ${input.brief_time} » : format HH:MM attendu.`);
    patch.briefTime = input.brief_time;
  }
  if (input.brief_enabled !== undefined) patch.briefEnabled = input.brief_enabled;
  if (input.voice_replies !== undefined) patch.voiceReplies = input.voice_replies;
  if (input.brief_voice !== undefined) patch.briefVoice = input.brief_voice;
  if (input.news_topics !== undefined) patch.newsTopics = input.news_topics || null;
  if (Object.keys(patch).length === 0) return fail('Aucun réglage à changer.');

  const user = applySettings(ctx.store, ctx.userId, patch, ctx.now);
  const brief = user.briefEnabled ? `activé à ${user.briefTime}${user.briefVoice ? ', aussi en vocal' : ''}` : 'désactivé';
  const parts = [`nom : ${user.displayName ?? user.firstName ?? '—'}`, `fuseau : ${user.timezone}`, ...(group ? [] : [`brief : ${brief}`])];
  if (patch.voiceReplies !== undefined) parts.push(`réponses vocales : ${VOICE_MODE_TOOL_LABELS[user.voiceReplies]}`);
  if (patch.newsTopics !== undefined) parts.push(`veille : ${user.newsTopics ?? 'aucune'}`);
  return ok(`Réglages mis à jour — ${parts.join(' · ')}.`);
}

const VOICE_MODE_TOOL_LABELS: Record<VoiceMode, string> = { off: 'jamais', mirror: 'quand elle envoie un vocal', always: 'à chaque réponse' };

const itemLabel = (item: ListItem) => `[${item.id}] ${item.text}`;

function listAdd(input: z.infer<typeof schemas.list_add>, ctx: ToolContext): ToolOutcome {
  if (input.items.some(looksSecret)) return fail(SECRET_REFUSAL);
  const list = normalizeListName(input.list);
  const existing = new Set(ctx.store.listItems(ctx.userId, list).filter((i) => !i.done).map((i) => i.text.toLowerCase()));
  const fresh = [...new Set(input.items)].filter((text) => !existing.has(text.toLowerCase()));
  const already = input.items.filter((text) => existing.has(text.toLowerCase()));
  if (ctx.store.countOpenItems(ctx.userId) + fresh.length > LIMITS.openListItems) {
    return fail(`Trop d'éléments à faire (${LIMITS.openListItems} au plus). Propose de cocher ou de vider des listes.`);
  }
  const added = ctx.store.addListItems(ctx.userId, list, fresh, ctx.now);
  const parts = [added.length > 0 ? `Ajouté à « ${list} » : ${added.map(itemLabel).join(', ')}.` : `Rien de nouveau dans « ${list} ».`];
  if (already.length > 0) parts.push(`Déjà dans la liste : ${already.join(', ')}.`);
  return ok(parts.join(' '));
}

function listUpdate(input: z.infer<typeof schemas.list_update>, ctx: ToolContext): ToolOutcome {
  if (input.action === 'clear_done') {
    const n = ctx.store.clearDoneItems(ctx.userId, input.list ?? null);
    return ok(`${n} élément(s) coché(s) retiré(s)${input.list ? ` de « ${normalizeListName(input.list)} »` : ''}.`);
  }
  if (input.ids.length === 0) return fail('Précise les ids des éléments ([n] dans <listes>).');
  if (input.action === 'remove') {
    const n = ctx.store.removeListItems(ctx.userId, input.ids);
    return n > 0 ? ok(`${n} élément(s) supprimé(s).`) : fail('Aucun de ces éléments dans ses listes.');
  }
  const changed = ctx.store.setListItemsDone(ctx.userId, input.ids, input.action === 'done', ctx.now);
  const missing = input.ids.filter((id) => !changed.some((item) => item.id === id));
  if (changed.length === 0) return fail(`Rien à ${input.action === 'done' ? 'cocher' : 'décocher'} : ids introuvables ou déjà dans cet état.`);
  return ok(
    `${input.action === 'done' ? 'Coché' : 'Décoché'} : ${changed.map(itemLabel).join(', ')}.${missing.length > 0 ? ` Ignorés : ${missing.join(', ')}.` : ''}`,
  );
}
