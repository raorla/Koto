import { describe, expect, it } from 'vitest';
import { loginMatchesPage } from '../src/browser/credentials.js';
import { blockedUrlReason, hostMatches, isIrreversibleLabel, isPrivateAddress, looksLikeCardNumber } from '../src/browser/guards.js';

describe('garde-fous du navigateur', () => {
  it('reconnaît les adresses privées et locales', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.5', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '41.188.10.20', '172.32.0.1', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("n'autorise que le web public en http(s)", () => {
    expect(blockedUrlReason('https://www.jumia.mg/')).toBeNull();
    expect(blockedUrlReason('http://localhost:3000')).toMatch(/locale/);
    expect(blockedUrlReason('http://192.168.1.1/admin')).toMatch(/privé/);
    expect(blockedUrlReason('http://[::1]/')).toMatch(/privé/);
    expect(blockedUrlReason('file:///etc/passwd')).toMatch(/protocole/);
    expect(blockedUrlReason('javascript:alert(1)')).toMatch(/protocole/);
    expect(blockedUrlReason('pas une url')).toMatch(/invalide/);
  });

  it('repère les numéros de carte (clé de Luhn), pas les autres nombres', () => {
    expect(looksLikeCardNumber('4970 1012 3456 7890')).toBe(false); // Luhn invalide
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('5555-5555-5555-4444')).toBe(true);
    expect(looksLikeCardNumber('+261 34 12 345 67')).toBe(false);
    expect(looksLikeCardNumber('Vol AF 935 le 2026-12-04')).toBe(false);
  });

  it('repère les boutons qui engagent la personne, pas les bandeaux cookies', () => {
    for (const label of ['Payer 650 €', 'Confirmer la réservation', 'Commander', 'Envoyer', 'Valider le paiement', 'Book now', "S'abonner", 'Supprimer mon compte']) {
      expect(isIrreversibleLabel(label), label).toBe(true);
    }
    for (const label of ['Rechercher', 'Voir les vols', 'Confirmer mes choix de cookies', 'Accepter', 'Suivant', 'Réservations passées ?']) {
      expect(isIrreversibleLabel(label), label).toBe(false);
    }
  });

  it('ne reconnaît un site que sur son domaine ou ses sous-domaines (pas les sosies)', () => {
    expect(hostMatches('www.jumia.mg', 'jumia.mg')).toBe(true);
    expect(hostMatches('my.jumia.mg', 'jumia.mg')).toBe(true);
    expect(hostMatches('jumia.mg.evil.com', 'jumia.mg')).toBe(false);
    expect(hostMatches('evil-jumia.mg', 'jumia.mg')).toBe(false);
    expect(loginMatchesPage({ host: 'jumia.mg', exactDomain: true }, 'my.jumia.mg')).toBe(false);
    expect(loginMatchesPage({ host: 'jumia.mg', exactDomain: true }, 'www.jumia.mg')).toBe(true);
  });
});
