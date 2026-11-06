/**
 * lecture-contexte.js — lecture du contexte d'un match, CALCULÉE (pas par l'IA).
 *
 * Source unique : le nœud Code « Préparer » du workflow n8n « IA modèle » (prompt v10)
 * en intègre le texte tel quel (pas de require possible dans n8n). Tests :
 *   node lecture-contexte.js
 *
 * Produit, du point de vue de l'équipe jugée X face à son adversaire Y :
 *   - une liste « Pour X » et une liste « Contre X » de faits déjà rédigés et chiffrés ;
 *   - une étiquette FAVORABLE / MITIGÉ / DÉFAVORABLE (score = nb Pour − nb Contre).
 * Le tri du signe est correct PAR CONSTRUCTION : un fait tiré des données de Y alimente
 * « Pour X », il ne peut pas atterrir dans « Contre X » (bug du prompt v9b, où gpt-4o-mini
 * classait « Gaziantep a une défense fragile » contre Kasımpaşa).
 *
 * L'étiquette est DESCRIPTIVE : elle ne crée jamais de pari. Le conseil découle des
 * probabilités du modèle (model.js, lignesVerdict) ; un contexte DÉFAVORABLE peut seulement
 * le dégrader d'un cran (couplage asymétrique, 2026-11-06).
 *
 * Écrit à partir d'une proposition externe (revue du 2026-11-06), adapté aux colonnes
 * réelles de classements_foot.
 */
const lectureContexte = (() => {
  // Arrondi à une décimale, sans « 2,0 » : la précision affichée est celle du code, ni
  // celle du SQL ni celle du modèle (« 1,8181… » envoyé à l'IA l'autorisait à « nettoyer »
  // les autres nombres, Grenoble – Reims, 2026-11-06).
  const n = v => (Math.round(Number(v) * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  const P = v => Math.round(v * 100);
  // Accord français : « 1,7 but », « 2 buts ».
  const pl = (v, mot) => `${n(v)} ${mot}${Math.abs(v) >= 2 ? 's' : ''}`;

  // --- Seuils. Réglables, mais documenter tout changement : ils déplacent les étiquettes.
  // Absolus pour l'instant (identiques pour tous les championnats) — à rendre relatifs
  // au championnat, comme le reste du projet.
  const SEUIL_FORME = 4;         // écart de points sur 15
  const SEUIL_LIEU = 0.6;        // écart de points par match sur le lieu du match
  const SEUIL_DEFENSE = 1.6;     // buts encaissés par match
  const SEUIL_ATTAQUE = 1.8;     // buts marqués par match
  const SEUIL_CONVERSION = 0.38; // au-dessus, régression vers ~0,30 attendue
  const SEUIL_CLASSEMENT = 6;    // écart de places (jamais entre deux championnats)

  /**
   * @param X équipe jugée, Y son adversaire :
   *   { nom, ptsSur15, ptsParMatchLieu, butsMarques, butsEncaisses, conversion, position, lieu }
   *   lieu = "à domicile" ou "à l'extérieur" ; ptsParMatchLieu peut valoir null.
   * @param memeChampionnat false pour une coupe d'Europe ou une affiche inter-ligues
   */
  function lc(X, Y, memeChampionnat) {
    const pour = [], contre = [];

    // 1. Forme récente
    const dF = X.ptsSur15 - Y.ptsSur15;
    if (dF >= SEUIL_FORME) pour.push(`${X.nom} est mieux lancé (${X.ptsSur15} points sur 15 contre ${Y.ptsSur15})`);
    else if (dF <= -SEUIL_FORME) contre.push(`${Y.nom} est mieux lancé (${Y.ptsSur15} points sur 15 contre ${X.ptsSur15})`);

    // 2. Bilan sur le lieu du match
    if (X.ptsParMatchLieu != null && Y.ptsParMatchLieu != null) {
      const dL = X.ptsParMatchLieu - Y.ptsParMatchLieu;
      if (dL >= SEUIL_LIEU) pour.push(`${X.nom} ${X.lieu} : ${pl(X.ptsParMatchLieu, 'point')} par match, contre ${n(Y.ptsParMatchLieu)} pour ${Y.nom} ${Y.lieu}`);
      else if (dL <= -SEUIL_LIEU) contre.push(`${Y.nom} ${Y.lieu} : ${pl(Y.ptsParMatchLieu, 'point')} par match, contre ${n(X.ptsParMatchLieu)} pour ${X.nom} ${X.lieu}`);
    }

    // 3. Défenses — la fragilité de l'adversaire est un atout pour X
    if (Y.butsEncaisses >= SEUIL_DEFENSE) pour.push(`${Y.nom} encaisse ${pl(Y.butsEncaisses, 'but')} par match`);
    if (X.butsEncaisses >= SEUIL_DEFENSE) contre.push(`${X.nom} encaisse ${pl(X.butsEncaisses, 'but')} par match`);

    // 4. Attaques — exclusif avec le risque de conversion (tâche 3, 2026-11-06) : un taux
    // de conversion élevé rend le ratio de buts non représentatif. On ne présente pas les
    // buts en atout ET leur régression en risque dans le même rapport (Grenoble – Reims :
    // « Reims marque 2 buts par match » en atout, « Reims transforme 43 % » en risque).
    const convChaudeX = X.conversion >= SEUIL_CONVERSION;
    const convChaudeY = Y.conversion >= SEUIL_CONVERSION;
    if (X.butsMarques >= SEUIL_ATTAQUE && !convChaudeX) pour.push(`${X.nom} marque ${pl(X.butsMarques, 'but')} par match`);
    if (Y.butsMarques >= SEUIL_ATTAQUE && !convChaudeY) contre.push(`${Y.nom} marque ${pl(Y.butsMarques, 'but')} par match`);

    // 5. Conversion : un taux élevé est un RISQUE pour celui qui l'affiche
    if (X.conversion >= SEUIL_CONVERSION) contre.push(`${X.nom} transforme ${P(X.conversion)} % de ses tirs cadrés, au-dessus de la normale : ce rythme devrait baisser`);
    if (Y.conversion >= SEUIL_CONVERSION) pour.push(`${Y.nom} transforme ${P(Y.conversion)} % de ses tirs cadrés, au-dessus de la normale : ce rythme devrait baisser`);

    // 6. Classement — jamais entre deux championnats différents
    if (memeChampionnat && X.position && Y.position) {
      const dP = Y.position - X.position;
      if (dP >= SEUIL_CLASSEMENT) pour.push(`${X.nom} est ${X.position}e, ${Y.nom} ${Y.position}e`);
      else if (dP <= -SEUIL_CLASSEMENT) contre.push(`${Y.nom} est ${Y.position}e, ${X.nom} ${X.position}e`);
    }

    const nPour = pour.length, nContre = contre.length;
    if (!nPour) pour.push('rien de net');
    if (!nContre) contre.push('rien de net');
    const score = nPour - nContre;
    return { pour, contre, score, etiquette: score >= 2 ? 'FAVORABLE' : score <= -2 ? 'DÉFAVORABLE' : 'MITIGÉ' };
  }
  lc.formatNombre = n; // exposé pour les tests uniquement
  return lc;
})();

/* ------------------------------------------------------------------ */
/* Tests — node lecture-contexte.js                                    */
/* ------------------------------------------------------------------ */
function testsLectureContexte() {
  let echecs = 0;
  const check = (ok, msg) => { if (!ok) { echecs++; console.error('ECHEC ' + msg); } };

  // Valeurs réelles du 2026-11-06 (classements_foot)
  const gaziantep = { nom: 'Gaziantep FK', ptsSur15: 0, ptsParMatchLieu: 0.4, butsEncaisses: 1.7,
                      butsMarques: 0.9, conversion: 0.231, position: 16, lieu: 'à domicile' };
  const kasimpasa = { nom: 'Kasımpaşa', ptsSur15: 8, ptsParMatchLieu: 2.0, butsEncaisses: 1.1,
                      butsMarques: 1.5, conversion: 0.357, position: 5, lieu: "à l'extérieur" };

  const a = lectureContexte(kasimpasa, gaziantep, true);
  check(a.etiquette === 'FAVORABLE', 'Kasımpaşa doit être FAVORABLE (v9b produisait DÉFAVORABLE), obtenu ' + a.etiquette);
  check(a.contre.length === 1 && a.contre[0] === 'rien de net', 'aucun fait ne dessert Kasımpaşa, obtenu : ' + a.contre.join(' · '));

  const b = lectureContexte(gaziantep, kasimpasa, true);
  check(b.etiquette === 'DÉFAVORABLE', 'symétrie : Gaziantep doit être DÉFAVORABLE, obtenu ' + b.etiquette);
  check(a.score === -b.score, `les scores doivent être opposés (${a.score} / ${b.score})`);

  check(!a.pour.some(s => s.includes('Kasımpaşa transforme')), 'la conversion de X ne peut pas être un atout pour X');

  const c = lectureContexte(kasimpasa, gaziantep, false);
  check(!c.pour.concat(c.contre).some(s => /\de,/.test(s)), 'aucun classement comparé entre deux championnats différents');

  const fmt = lectureContexte.formatNombre;
  check(fmt(1.5) === '1,5', 'virgule décimale');
  check(fmt(20 / 11) === '1,8', 'arrondi à une décimale, obtenu ' + fmt(20 / 11));
  check(fmt(2.0) === '2', 'pas de « 2,0 », obtenu ' + fmt(2.0));
  check(fmt(2.25) === '2,3' || fmt(2.25) === '2,2', 'une seule décimale, obtenu ' + fmt(2.25));
  check(a.pour.some(s => s === 'Gaziantep FK encaisse 1,7 but par match'), 'accord « 1,7 but » : ' + a.pour.join(' · '));

  // Conversion chaude : le ratio de buts ne figure pas en atout, le risque reste (Grenoble – Reims réel)
  const reims = { nom: 'Reims', ptsSur15: 9, ptsParMatchLieu: 1.8, butsEncaisses: 1.1,
                  butsMarques: 2.0, conversion: 0.43, position: 4, lieu: "à l'extérieur" };
  const grenoble = { nom: 'Grenoble', ptsSur15: 1, ptsParMatchLieu: 0.4, butsEncaisses: 1.82,
                     butsMarques: 0.9, conversion: 0.24, position: 18, lieu: 'à domicile' };
  const r = lectureContexte(reims, grenoble, true);
  check(!r.pour.some(s => s.includes('Reims marque')), 'conversion chaude : le ratio de buts ne doit pas figurer en atout');
  check(r.contre.some(s => s.includes('transforme')), 'le risque de conversion doit rester présent');
  check(r.etiquette === 'FAVORABLE' && r.score === 3, `Grenoble – Reims : FAVORABLE, score 3 (obtenu ${r.etiquette}, ${r.score})`);
  check(r.pour.includes('Grenoble encaisse 1,8 but par match'), 'arrondi dans les phrases : ' + r.pour.join(' · '));
  // Symétrie : la conversion chaude de l'adversaire retire aussi son attaque de « Contre X »
  const r2 = lectureContexte(grenoble, reims, true);
  check(!r2.contre.some(s => s.includes('Reims marque')), 'conversion chaude de Y : son attaque ne figure pas en Contre X');

  console.log(echecs ? `lectureContexte : ${echecs} échec(s)` : 'lectureContexte : tests OK');
  return echecs;
}

if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
  process.exit(testsLectureContexte() ? 1 : 0);
}
if (typeof module !== 'undefined') module.exports = { lectureContexte, testsLectureContexte };
