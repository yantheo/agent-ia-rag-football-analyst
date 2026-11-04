/*
 * Tests chiffrés du modèle (model.js). Tournent sous Node (pas de page de test publiée)
 *   node model.tests.js
 * Tolérance ±0,005 sauf mention. Les valeurs attendues sont calculées
 * indépendamment (Python, double Poisson tronqué à 10 buts) — un test ne doit
 * pas valider "ce que le code produit actuellement" (cf. piège bwinDateToISO
 * dans CLAUDE.md).
 */
(function (global) {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./model.js') : global.Modele;
  const TOL = 0.005;

  function run() {
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });
    const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol;

    // Contexte synthétique : équipes moyennes (att = def = 1) d'un même
    // championnat à 1,4 but/équipe/match -> T = 2,8. Seul l'Elo varie.
    function ctxFor(eloH, eloA) {
      const teams = [
        { team_id: 'h', championnat: 'L', buts_pour: 14, buts_contre: 14, matchs_joues: 10 },
        { team_id: 'a', championnat: 'L', buts_pour: 14, buts_contre: 14, matchs_joues: 10 },
      ];
      const elo = { equipes: { h: { elo: eloH }, a: { elo: eloA } }, moyennes_championnats: { L: 1600 } };
      return M.v2.prepare(teams, elo, { equipes: { h: 'H', a: 'A' } });
    }

    // 1. Les cinq matchs de référence (v2, T = 2,8, avantage du terrain +65)
    const refs = [
      ['Galatasaray (1815) – Stuttgart (1821)', 1815, 1821, 0.459, 0.248, 0.293, 0.583],
      ['Barcelone (2027) – Aston Villa (1901)', 2027, 1901, 0.639, 0.209, 0.151, 0.744],
      ['Man United (1847) – Roma (1866)', 1847, 1866, 0.440, 0.250, 0.310, 0.565],
      ['QPR (1588) – Burnley (1635)', 1588, 1635, 0.400, 0.252, 0.348, 0.526],
      ['Preston (1509) – Sheffield Utd (1623)', 1509, 1623, 0.306, 0.249, 0.445, 0.431],
    ];
    refs.forEach(([name, eh, ea, p1, pn, p2, esp]) => {
      const r = M.v2.matchProbabilities(ctxFor(eh, ea), 'h', 'a');
      const e = r.pHome + r.pDraw / 2;
      const cible = 1 / (1 + Math.pow(10, -r.dE / 400));
      check(`Référence ${name}`,
        near(r.pHome, p1) && near(r.pDraw, pn) && near(r.pAway, p2) && near(e, esp) && near(r.T, 2.8, 1e-9),
        `P = ${r.pHome.toFixed(3)} / ${r.pDraw.toFixed(3)} / ${r.pAway.toFixed(3)}, espérance ${e.toFixed(3)} (attendu ${p1} / ${pn} / ${p2}, ${esp})`);
      check(`Espérance ≈ cible Elo (±0,01) — ${name}`, near(e, cible, 0.01), `${e.toFixed(3)} vs ${cible.toFixed(3)}`);
    });

    // 2. Le test qui compte : Galatasaray – Stuttgart change de camp
    const gs = M.v2.matchProbabilities(ctxFor(1815, 1821), 'h', 'a');
    check('Galatasaray–Stuttgart : favori = Galatasaray (domicile) en v2',
      gs.pHome > gs.pAway && gs.pHome > gs.pDraw, `P(1) ${gs.pHome.toFixed(3)} > P(2) ${gs.pAway.toFixed(3)}`);

    // 3. Calibration du facteur k (équipes moyennes, T = 2,8, dE imposé)
    [[0, 0.500], [100, 0.638], [200, 0.753], [300, 0.835]].forEach(([dE, attendu]) => {
      const r = M.v2.matchProbabilities(ctxFor(1600 + dE - M.v2.ADV_DOM_DEFAUT, 1600), 'h', 'a');
      const e = r.pHome + r.pDraw / 2;
      check(`Calibration k : dE = ${dE}`, near(e, attendu) && Math.abs(r.dE - dE) < 1e-9, `espérance ${e.toFixed(3)} (attendu ${attendu})`);
    });

    // 4. Conservation du total (avant plancher) pour tout dE
    let maxEcart = 0;
    for (let dE = -600; dE <= 600; dE += 25) {
      const s = Math.exp(2 * M.v2.K_ELO * dE), T = 2.8;
      maxEcart = Math.max(maxEcart, Math.abs((T * s) / (1 + s) + T / (1 + s) - T));
    }
    check('Conservation : λdom + λext = T (avant plancher)', maxEcart < 1e-9, `écart max ${maxEcart.toExponential(1)}`);

    // 5. Taux de nuls, deux équipes de force égale (dE = 0), T = 2,8
    const eq = M.v2.matchProbabilities(ctxFor(1600 - M.v2.ADV_DOM_DEFAUT, 1600), 'h', 'a');
    check('Taux de nuls à force égale = 0,250 ± 0,005', near(eq.pDraw, 0.250), `P(N) = ${eq.pDraw.toFixed(3)}`);

    // 6. Plancher : aucun λ sous 0,25 même sur un écart énorme
    const big = M.v2.matchProbabilities(ctxFor(2100, 1300), 'h', 'a');
    check('Plancher λ ≥ 0,25', big.lambdaAway >= 0.25 - 1e-12, `λext = ${big.lambdaAway.toFixed(3)}`);

    // 7. Fallback Elo explicite : équipe non appariée -> Elo moyen + dégradé
    const ctxD = M.v2.prepare(
      [{ team_id: 'x', championnat: 'L', buts_pour: 10, buts_contre: 10, matchs_joues: 8 },
       { team_id: 'a', championnat: 'L', buts_pour: 10, buts_contre: 10, matchs_joues: 8 }],
      { equipes: { a: { elo: 1700 } }, moyennes_championnats: { L: 1600 } }, { equipes: { a: 'A' } });
    const dg = M.v2.matchProbabilities(ctxD, 'x', 'a');
    check('Équipe non appariée : Elo moyen du championnat + prédiction dégradée',
      dg && dg.eloHome === 1600 && dg.eloDegrade === true, dg ? dg.eloDegradeDetail.join(' ; ') : 'null');

    // 8. v1 conservée : présente et versionnée
    check('v1 conservée (Modele.v1_poisson, version v1-poisson-k6)',
      typeof M.v1_poisson === 'function' && M.v1.VERSION === 'v1-poisson-k6' && M.v1.SHRINK_K === 6);

    // 9. v3b (expérimental) : Elo mixte sur un cas synthétique, valeurs calculées en Python.
    //    h : 20 BP / 10 BC en 10 j, ClubElo 1700 ; a : 14 / 14, ClubElo 1650 ; ligue moy. Elo 1600.
    //    mL = 1,7 ; Elo saison h = 1660,265, a = 1600 ; w = 0,5 -> 1680,132 et 1625.
    const t3 = [
      { team_id: 'h', championnat: 'L', buts_pour: 20, buts_contre: 10, matchs_joues: 10 },
      { team_id: 'a', championnat: 'L', buts_pour: 14, buts_contre: 14, matchs_joues: 10 },
    ];
    const e3 = { equipes: { h: { elo: 1700 }, a: { elo: 1650 } }, moyennes_championnats: { L: 1600 } };
    const c3 = M.v3b.prepare(t3, e3, { equipes: { h: 'H', a: 'A' } });
    const r3 = M.v3b.matchProbabilities(c3, 'h', 'a');
    check('v3b : Elo mixte (J0 = 10) dans un même championnat',
      r3.melange && Math.abs(r3.eloHome - 1680.132) < 0.01 && Math.abs(r3.eloAway - 1625) < 0.01,
      `Elo ${r3.eloHome.toFixed(3)} / ${r3.eloAway.toFixed(3)} (attendu 1680,132 / 1625)`);
    const p3v2 = M.v2.matchProbabilities(c3, 'h', 'a');
    check('v3b : T identique à la v2', Math.abs(r3.T - p3v2.T) < 1e-12, `T ${r3.T.toFixed(3)}`);
    const t3x = [t3[0], Object.assign({}, t3[1], { championnat: 'M' })];
    const e3x = { equipes: e3.equipes, moyennes_championnats: { L: 1600, M: 1600 } };
    const c3x = M.v3b.prepare(t3x, e3x, { equipes: { h: 'H', a: 'A' } });
    const r3x = M.v3b.matchProbabilities(c3x, 'h', 'a'), r3x2 = M.v2.matchProbabilities(c3x, 'h', 'a');
    check('v3b : match entre championnats = v2 pure',
      !r3x.melange && r3x.pHome === r3x2.pHome && r3x.pAway === r3x2.pAway, `P(1) ${r3x.pHome.toFixed(3)}`);

    // 10. Démarginage (puissance) — Lens – Côme 2026-11-04, cotes 3,60 / 3,80 / 1,95 (Python : 0,2596 / 0,2453 / 0,4951, marge 5,38 %)
    const mk = M.marche.demarginer([3.60, 3.80, 1.95]);
    check('Démarginage puissance : Lens – Côme',
      near(mk.pHome, 0.2596, 0.001) && near(mk.pDraw, 0.2453, 0.001) && near(mk.pAway, 0.4951, 0.001) && near(mk.marge, 0.0538, 0.001),
      `${mk.pHome.toFixed(4)} / ${mk.pDraw.toFixed(4)} / ${mk.pAway.toFixed(4)}, marge ${(mk.marge * 100).toFixed(2)} %`);
    check('Démarginage : cote invalide -> null', M.marche.demarginer([3.6, 0, 1.95]) === null);

    // 11. Moyenne v1/v2 : 50/50 issue par issue, somme = 1, null si un modèle manque
    const mo = M.moyenneV1V2.combiner({ pHome: 0.281, pDraw: 0.245, pAway: 0.474 }, { pHome: 0.434, pDraw: 0.245, pAway: 0.321 });
    check('Moyenne v1/v2 : 50/50 (Lens – Côme)',
      near(mo.pHome, 0.3575, 1e-9) && near(mo.pDraw, 0.245, 1e-9) && near(mo.pAway, 0.3975, 1e-9) && M.moyenneV1V2.VERSION === 'moy-v1v2-w50',
      `${mo.pHome.toFixed(4)} / ${mo.pDraw.toFixed(4)} / ${mo.pAway.toFixed(4)}`);
    check('Moyenne v1/v2 : null si v1 absente', M.moyenneV1V2.combiner(null, mo) === null);

    return results;
  }

  if (typeof module !== 'undefined' && require.main === module) {
    const res = run();
    res.forEach(r => console.log(`${r.ok ? 'OK  ' : 'ECHEC'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
    const ko = res.filter(r => !r.ok).length;
    console.log(`\n${res.length - ko}/${res.length} tests OK`);
    process.exit(ko ? 1 : 0);
  } else {
    global.ModeleTests = { run };
  }
})(typeof window !== 'undefined' ? window : globalThis);
