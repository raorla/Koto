import { describe, expect, it } from 'vitest';
import { renderUserContext } from '../src/agent/prompt.js';
import { executeTool } from '../src/agent/tools.js';
import { renderList } from '../src/bot/delivery.js';
import { NOW, makeStore, makeUser } from './helpers.js';

function setup() {
  const store = makeStore();
  const ana = makeUser(store, { firstName: 'Ana' });
  const bob = makeUser(store, { firstName: 'Bob' });
  const as = (userId: number) => ({ store, userId, now: NOW });
  return { store, ana, bob, as };
}

describe('listes', () => {
  it('ajoute sans doublon, normalise le nom de liste et refuse les secrets', () => {
    const { store, ana, as } = setup();

    const first = executeTool('list_add', { list: 'Courses', items: ['lait', 'pain'] }, as(ana.id));
    expect(first.content).toMatch(/Ajouté à « courses » : \[\d+\] lait, \[\d+\] pain\./);

    const again = executeTool('list_add', { list: 'courses ', items: ['Lait', 'œufs'] }, as(ana.id));
    expect(again.content).toContain('Déjà dans la liste : Lait.');
    expect(store.listItems(ana.id, 'courses').map((i) => i.text)).toEqual(['lait', 'pain', 'œufs']);

    expect(executeTool('list_add', { list: 'notes', items: ['Mon mot de passe Gmail est hunter2'] }, as(ana.id)).isError).toBe(true);
  });

  it('coche, décoche, supprime et vide les éléments cochés', () => {
    const { store, ana, as } = setup();
    executeTool('list_add', { list: 'tâches', items: ['Envoyer le devis', 'Appeler Rado', 'Payer la JIRAMA'] }, as(ana.id));
    const [devis, rado, jirama] = store.listItems(ana.id, 'tâches');

    expect(executeTool('list_update', { action: 'done', ids: [devis!.id, rado!.id] }, as(ana.id)).content).toContain('Coché');
    expect(store.listOpenItems(ana.id).map((i) => i.text)).toEqual(['Payer la JIRAMA']);
    executeTool('list_update', { action: 'undo', ids: [rado!.id] }, as(ana.id));
    expect(store.listOpenItems(ana.id)).toHaveLength(2);

    expect(executeTool('list_update', { action: 'remove', ids: [jirama!.id] }, as(ana.id)).content).toContain('1 élément(s) supprimé(s)');
    expect(executeTool('list_update', { action: 'clear_done', list: 'Tâches' }, as(ana.id)).content).toContain('1 élément(s) coché(s) retiré(s)');
    expect(store.listItems(ana.id, 'tâches').map((i) => i.text)).toEqual(['Appeler Rado']);
    expect(executeTool('list_update', { action: 'done' }, as(ana.id)).isError).toBe(true);
  });

  it("isole les listes de chaque personne", () => {
    const { store, ana, bob, as } = setup();
    executeTool('list_add', { list: 'courses', items: ['lait'] }, as(ana.id));
    const [lait] = store.listItems(ana.id, 'courses');

    expect(executeTool('list_update', { action: 'done', ids: [lait!.id] }, as(bob.id)).isError).toBe(true);
    expect(executeTool('list_update', { action: 'remove', ids: [lait!.id] }, as(bob.id)).isError).toBe(true);
    expect(store.getListItem(bob.id, lait!.id)).toBeNull();
    expect(store.listOpenItems(ana.id)).toHaveLength(1);
  });

  it('montre les éléments à faire dans le contexte, liste par liste', () => {
    const { store, ana, as } = setup();
    executeTool('list_add', { list: 'courses', items: ['lait', 'pain'] }, as(ana.id));
    executeTool('list_add', { list: 'à lire', items: ['Sapiens'] }, as(ana.id));
    const user = store.getUserById(ana.id)!;

    const context = renderUserContext(user, [], [], null, { speech: false, news: false }, store.listOpenItems(ana.id));

    expect(context).toMatch(/<listes>\n## courses\n- \[\d+\] lait\n- \[\d+\] pain\n## à lire\n- \[\d+\] Sapiens\n<\/listes>/);
    expect(renderUserContext(user, [], [])).toContain('<listes>\n(aucune)\n</listes>');
  });

  it('affiche une liste à cocher dans Telegram', () => {
    const { store, ana, as } = setup();
    executeTool('list_add', { list: 'courses', items: ['lait', 'pain'] }, as(ana.id));
    const [lait] = store.listItems(ana.id, 'courses');
    store.setListItemsDone(ana.id, [lait!.id], true, NOW);

    const { text, keyboard } = renderList('courses', store.listItems(ana.id, 'courses'));

    expect(text).toContain('<b>courses</b> · 1 à faire');
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['⬜ pain', '✅ lait']);
  });
});
