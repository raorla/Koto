import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Garde-fous appliqués par le CODE, quoi qu'en dise le modèle ou la page visitée.

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Adresse locale, privée, lien-local ou multicast (IPv4 et IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => (value & (~0 << (32 - bits))) >>> 0 === ipv4ToInt(base));
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return false;
}

/**
 * Raison de refuser une URL, ou null si elle est autorisée : seulement http(s), jamais la
 * machine locale ni le réseau privé (sinon une page piégée pourrait viser la box internet).
 */
export function blockedUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'adresse invalide';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `protocole « ${url.protocol} » interdit`;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'adresse locale interdite';
  }
  if (isIP(host) && isPrivateAddress(host)) return 'adresse de réseau privé interdite';
  return null;
}

/** Vérifie aussi ce que le nom de domaine résout (un domaine public peut pointer vers une IP privée). */
export async function navigationBlockedReason(raw: string): Promise<string | null> {
  const reason = blockedUrlReason(raw);
  if (reason) return reason;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return null;
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((a) => isPrivateAddress(a.address))) return 'ce domaine pointe vers un réseau privé';
  } catch {
    return 'domaine introuvable';
  }
  return null;
}

/** Numéro de carte bancaire probable (13 à 19 chiffres, clé de Luhn valide). */
export function looksLikeCardNumber(text: string): boolean {
  const candidates = text.match(/(?:\d[ -]?){12,18}\d/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  });
}

// Libellés de boutons qui engagent la personne. Délimités en Unicode (\b ignore les accents en JS).
const IRREVERSIBLE =
  /(?<![\p{L}])(payer|paiement|pay|acheter|achat|buy|commander|commande|order|checkout|réserver|reserver|réservation|book|booking|confirmer|confirm|valider|validate|envoyer|send|soumettre|submit|supprimer|delete|souscrire|subscribe|s'abonner|abonner|transférer|transferer|transfer|virement|signer|sign)(?![\p{L}])/iu;
// Les bandeaux cookies emploient « confirmer » ou « valider » sans rien engager.
const HARMLESS = /cookie|consentement|consent|mes choix|préférences|preferences|newsletter/iu;

/** Vrai si cliquer sur ce bouton peut payer, réserver, envoyer, valider ou supprimer. */
export function isIrreversibleLabel(label: string): boolean {
  return IRREVERSIBLE.test(label) && !HARMLESS.test(label);
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Le site visité correspond-il au site d'un identifiant (même domaine ou sous-domaine) ? */
export function hostMatches(pageHost: string, siteHost: string): boolean {
  const page = bareHost(pageHost);
  const site = bareHost(siteHost);
  return page === site || page.endsWith(`.${site}`);
}
