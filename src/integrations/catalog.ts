// Ce que Koto peut faire dans Gmail et Google Agenda, et ce qui exige le « ✅ Confirmer » de la personne.
// Liste courte et volontaire : pas de suppression de mails, de filtres ni de transfert automatique.

export const TOOLKITS = ['googlecalendar', 'gmail'] as const;
export type Toolkit = (typeof TOOLKITS)[number];

export const TOOLKIT_LABELS: Record<Toolkit, string> = {
  googlecalendar: 'Google Agenda',
  gmail: 'Gmail',
};

export const INTEGRATION_TOOLS: Record<Toolkit, readonly string[]> = {
  googlecalendar: [
    'GOOGLECALENDAR_EVENTS_LIST',
    'GOOGLECALENDAR_FIND_EVENT',
    'GOOGLECALENDAR_FIND_FREE_SLOTS',
    'GOOGLECALENDAR_CREATE_EVENT',
    'GOOGLECALENDAR_PATCH_EVENT',
    'GOOGLECALENDAR_DELETE_EVENT',
  ],
  gmail: [
    'GMAIL_FETCH_EMAILS',
    'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
    'GMAIL_GET_PROFILE',
    'GMAIL_CREATE_EMAIL_DRAFT',
    'GMAIL_SEND_EMAIL',
    'GMAIL_REPLY_TO_THREAD',
    'GMAIL_SEND_DRAFT',
  ],
};

// Lectures, et brouillon (il ne part nulle part). Tout le reste attend une confirmation :
// par défaut, un outil inconnu ou ajouté plus tard est donc soumis à confirmation.
const RUNS_WITHOUT_CONFIRMATION = new Set([
  'GOOGLECALENDAR_EVENTS_LIST',
  'GOOGLECALENDAR_FIND_EVENT',
  'GOOGLECALENDAR_FIND_FREE_SLOTS',
  'GMAIL_FETCH_EMAILS',
  'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  'GMAIL_GET_PROFILE',
  'GMAIL_CREATE_EMAIL_DRAFT',
]);

export function needsConfirmation(tool: string): boolean {
  return !RUNS_WITHOUT_CONFIRMATION.has(tool);
}

export function toolkitOf(tool: string): Toolkit | null {
  return TOOLKITS.find((toolkit) => INTEGRATION_TOOLS[toolkit].includes(tool)) ?? null;
}

export function isIntegrationTool(tool: string): boolean {
  return toolkitOf(tool) !== null;
}

const ACTION_LABELS: Record<string, string> = {
  GMAIL_SEND_EMAIL: '📧 Envoyer un mail',
  GMAIL_REPLY_TO_THREAD: '↩️ Répondre à un mail',
  GMAIL_SEND_DRAFT: '📧 Envoyer un brouillon',
  GOOGLECALENDAR_CREATE_EVENT: '📅 Créer un événement',
  GOOGLECALENDAR_PATCH_EVENT: '✏️ Modifier un événement',
  GOOGLECALENDAR_DELETE_EVENT: '🗑️ Supprimer un événement',
};

export function actionLabel(tool: string): string {
  return ACTION_LABELS[tool] ?? `⚙️ ${tool}`;
}

const FIELD_LABELS: Record<string, string> = {
  recipient_email: 'À',
  to: 'À',
  extra_recipients: 'Autres destinataires',
  cc: 'Cc',
  bcc: 'Cci',
  subject: 'Objet',
  summary: 'Titre',
  start_datetime: 'Début',
  end_datetime: 'Fin',
  event_duration_hour: 'Durée (heures)',
  event_duration_minutes: 'Durée (minutes)',
  timezone: 'Fuseau',
  attendees: 'Invités',
  location: 'Lieu',
  description: 'Description',
  event_id: 'Événement',
  thread_id: 'Conversation',
  draft_id: 'Brouillon',
  calendar_id: 'Agenda',
  send_updates: 'Prévenir les invités',
  body: 'Message',
  message_body: 'Message',
};

// Champs techniques sans intérêt pour la personne.
const HIDDEN_FIELDS = new Set(['user_id', 'is_html', 'attachment']);
const LONG_FIELDS = new Set(['body', 'message_body', 'description']);

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Aperçu (Markdown léger) affiché au-dessus des boutons Confirmer / Annuler. */
export function renderActionPreview(tool: string, args: Record<string, unknown>): string {
  const lines: string[] = [];
  let longText: string | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (HIDDEN_FIELDS.has(key) || value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const label = FIELD_LABELS[key] ?? key;
    if (LONG_FIELDS.has(key)) {
      longText = `**${label} :**\n${clip(formatValue(value), 1500)}`;
      continue;
    }
    lines.push(`• ${label} : ${clip(formatValue(value), 300)}`);
  }
  const parts = [`**${actionLabel(tool)}** — à confirmer`, lines.join('\n')];
  if (longText) parts.push(longText);
  return parts.filter(Boolean).join('\n\n');
}
