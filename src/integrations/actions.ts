import type { ClaimResult, PendingAction, Store, User } from '../store.js';
import { actionLabel } from './catalog.js';
import type { Integrations } from './types.js';

/** Au-delà, un bouton « Confirmer » oublié ne déclenche plus rien. */
export const ACTION_MAX_AGE_MS = 24 * 3_600_000;

export type ConfirmOutcome = { status: 'done' | 'failed' | Exclude<ClaimResult, 'claimed'>; message: string };

const CLAIM_MESSAGES: Record<Exclude<ClaimResult, 'claimed'>, string> = {
  missing: 'Je ne retrouve pas cette action.',
  expired: 'Cette demande a expiré (plus de 24 h) : redemande-la-moi si besoin.',
  already_decided: 'Cette action a déjà été traitée.',
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Résumé court pour l'historique, ex : « (à rado@exemple.com, objet « Devis ») ». */
function describe(action: PendingAction): string {
  const a = action.args;
  const bits = [
    a.recipient_email ?? a.to ? `à ${String(a.recipient_email ?? a.to)}` : null,
    a.subject ? `objet « ${clip(String(a.subject), 80)} »` : null,
    a.summary ? `« ${clip(String(a.summary), 80)} »` : null,
    a.start_datetime ? `début ${String(a.start_datetime)}` : null,
    a.event_id ? `événement ${String(a.event_id)}` : null,
  ].filter(Boolean);
  return bits.length > 0 ? ` (${bits.join(', ')})` : '';
}

/** Exécute une action après le « ✅ Confirmer » de la personne. Un double clic ne l'exécute qu'une fois. */
export async function confirmAction(
  store: Store,
  integrations: Integrations,
  user: User,
  actionId: number,
  now: number,
): Promise<ConfirmOutcome> {
  const claim = store.claimPendingAction(user.id, actionId, now, ACTION_MAX_AGE_MS);
  if (claim !== 'claimed') return { status: claim, message: CLAIM_MESSAGES[claim] };

  const action = store.getPendingAction(user.id, actionId)!;
  const label = actionLabel(action.tool);
  let result;
  try {
    result = await integrations.execute(user, action.tool, action.args);
  } catch (err) {
    result = { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  store.finishPendingAction(action.id, result.isError ? 'failed' : 'done', clip(result.text, 4_000), now);
  // L'historique garde la trace : au tour suivant, Koto sait ce qui a été fait (ou pas).
  store.addMessage(
    user.id,
    'assistant',
    result.isError
      ? `⚠️ Échec après confirmation : ${label}${describe(action)} — ${clip(result.text, 300)}`
      : `✅ Fait après confirmation de la personne : ${label}${describe(action)}.`,
    'chat',
    now,
  );
  return result.isError
    ? { status: 'failed', message: `⚠️ Ça n'a pas marché : ${clip(result.text, 300)}` }
    : { status: 'done', message: "✅ C'est fait." };
}

export function cancelAction(store: Store, user: User, actionId: number, now: number): boolean {
  const action = store.getPendingAction(user.id, actionId);
  if (!action || !store.cancelPendingAction(user.id, actionId, now)) return false;
  store.addMessage(user.id, 'assistant', `❌ Annulé par la personne : ${actionLabel(action.tool)}${describe(action)}.`, 'chat', now);
  return true;
}
