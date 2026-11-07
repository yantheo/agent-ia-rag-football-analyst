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

    // 9. Démarginage (puissance) — Lens – Côme 2026-11-04, cotes 3,60 / 3,80 / 1,95 (Python : 0,2596 / 0,2453 / 0,4951, marge 5,38 %)
    const mk = M.marche.demarginer([3.60, 3.80, 1.95]);
    check('Démarginage puissance : Lens – Côme',
      near(mk.pHome, 0.2596, 0.001) && near(mk.pDraw, 0.2453, 0.001) && near(mk.pAway, 0.4951, 0.001) && near(mk.marge, 0.0538, 0.001),
      `${mk.pHome.toFixed(4)} / ${mk.pDraw.toFixed(4)} / ${mk.pAway.toFixed(4)}, marge ${(mk.marge * 100).toFixed(2)} %`);
    check('Démarginage : cote invalide -> null', M.marche.demarginer([3.6, 0, 1.95]) === null);

    // 10. Moyenne v1/v2 : 50/50 issue par issue, somme = 1, null si un modèle manque
    const mo = M.moyenneV1V2.combiner({ pHome: 0.281, pDraw: 0.245, pAway: 0.474 }, { pHome: 0.434, pDraw: 0.245, pAway: 0.321 });
    check('Moyenne v1/v2 : 50/50 (Lens – Côme)',
      near(mo.pHome, 0.3575, 1e-9) && near(mo.pDraw, 0.245, 1e-9) && near(mo.pAway, 0.3975, 1e-9) && M.moyenneV1V2.VERSION === 'moy-v1v2-w50',
      `${mo.pHome.toFixed(4)} / ${mo.pDraw.toFixed(4)} / ${mo.pAway.toFixed(4)}`);
    check('Moyenne v1/v2 : null si v1 absente', M.moyenneV1V2.combiner(null, mo) === null);

    // 11. v3 (prod) : moyenne v1/v2 quand les deux existent, repli v2 explicite sinon
    const t4 = [
      { team_id: 'h', championnat: 'L', buts_pour: 20, buts_contre: 10, matchs_joues: 10 },
      { team_id: 'a', championnat: 'L', buts_pour: 14, buts_contre: 14, matchs_joues: 10 },
    ];
    const e4 = { equipes: { h: { elo: 1700 }, a: { elo: 1650 }, x: { elo: 1800 } }, moyennes_championnats: { L: 1600 } };
    const c4 = M.v3.prepare(t4, e4, { equipes: { h: 'H', a: 'A', x: 'X' } });
    const r4 = M.v3.matchProbabilities(c4, 'h', 'a');
    const i4 = M.v1.buildTeamIndices(t4, M.v1.computeLeagueAverages(t4));
    const q1 = M.v1_poisson(i4.h, i4.a), q2 = M.v2.matchProbabilities(M.v2.prepare(t4, e4, { equipes: { h: 'H', a: 'A', x: 'X' } }), 'h', 'a');
    check('v3 = ½ v1 + ½ v2 (issue par issue)',
      !r4.v3Repli && r4.version === 'moy-v1v2-w50' && near(r4.pHome, (q1.pHome + q2.pHome) / 2, 1e-12) && near(r4.pAway, (q1.pAway + q2.pAway) / 2, 1e-12),
      `P(1) ${r4.pHome.toFixed(4)} = (${q1.pHome.toFixed(4)} + ${q2.pHome.toFixed(4)}) / 2`);
    const r4x = M.v3.matchProbabilities(c4, 'h', 'x'); // 'x' : Elo connu, pas de stats de saison -> pas de v1
    check('v3 : repli explicite sur la v2 sans v1', r4x && r4x.v3Repli === true && r4x.version === 'v2-elo-k13' && r4x.probV1 === null,
      r4x ? `version ${r4x.version}, repli ${r4x.v3Repli}` : 'null');

    // 12. Bloc envoyé à l'IA : mêmes probabilités, Over 2,5 d'un Poisson(T).
    // T = 2,8 -> P(total <= 2) = e^-2,8 (1 + 2,8 + 3,92) = 0,4695 -> Over = 0,531.
    const pl = M.payloadModele(M.v2.matchProbabilities(ctxFor(1815, 1821), 'h', 'a'), 'Galatasaray', 'Stuttgart');
    check('payloadModele : probabilités, favori et Over 2,5',
      pl && pl.favori === 'Galatasaray' && near(pl.p_domicile, 0.459) && near(pl.p_over_2_5, 0.531)
        && near(pl.buts_attendus_total, 2.8, 0.001) && pl.version === 'v2-elo-k13',
      pl ? JSON.stringify(pl) : 'null');
    // P(les deux marquent) = (1 − e^−1,585)(1 − e^−1,215) = 0,7951 × 0,7033 = 0,559 ;
    // favori à 45,9 % -> léger favori ; nul 24,8 % -> risque normal.
    check('payloadModele : BTTS, niveau du favori, risque de nul',
      pl && near(pl.p_les_deux_marquent, 0.559) && pl.niveau_favori === 'léger favori' && pl.risque_nul === 'normal'
        && pl.championnats_differents === false,
      pl ? `BTTS ${pl.p_les_deux_marquent}, ${pl.niveau_favori}, nul ${pl.risque_nul}` : 'null');
    check('Seuils niveau / nul',
      M.niveauFavori(0.60) === 'favori net' && M.niveauFavori(0.595) === 'favori net' && M.niveauFavori(0.594) === 'léger favori'
        && M.niveauFavori(0.445) === 'léger favori' && M.niveauFavori(0.444) === 'match ouvert'
        && M.risqueNul(0.214) === 'faible' && M.risqueNul(0.216) === 'normal' && M.risqueNul(0.284) === 'normal' && M.risqueNul(0.286) === 'élevé');
    // Le libellé découle du pourcentage affiché : pour chaque entier n, p = n/100 et n/100 ± 0,004
    // (tous affichés « n % ») donnent le même mot. Toute différence = seuil appliqué à la valeur brute.
    let incoherences = [];
    for (let k = 0; k <= 100; k++) {
      for (const f of [M.niveauFavori, M.risqueNul]) {
        const ref = f(k / 100);
        for (const d of [-0.004, 0.004]) { const q = k / 100 + d; if (q >= 0 && q <= 1 && f(q) !== ref) incoherences.push(`${f.name}(${q.toFixed(3)})`); }
      }
    }
    const fakeP = (h, d, a, lh, la) => ({ pHome: h, pDraw: d, pAway: a, lambdaHome: lh, lambdaAway: la });
    // Lignes du verdict : « 40 % » affiché pour l'équipe devant et « 22 % » de nul → mêmes mots quelle que soit la valeur brute
    const Lv1 = M.lignesVerdict(fakeP(0.398, 0.30, 0.302, 1.1, 1.0), 'Venezia', 'Udinese'), Lv2 = M.lignesVerdict(fakeP(0.404, 0.30, 0.296, 1.1, 1.0), 'Venezia', 'Udinese');
    const Lh = M.lignesVerdict(fakeP(0.45, 0.218, 0.332, 2.1, 1.5), 'Hambourg', "M'gladbach"), Lg = M.lignesVerdict(fakeP(0.21, 0.221, 0.569, 0.9, 1.8), 'Grenoble', 'Reims');
    check('Libellés = pourcentage affiché (test paramétrique 0-100 ± 0,004, Venezia 40 %, nul 22 %)',
      !incoherences.length && Lv1.equipe_devant === 'Venezia' && Lv2.equipe_devant === 'Venezia' && Lh.nul === Lg.nul.replace(/^\d+/, '22') && Lh.nul === '22 %, risque normal',
      incoherences.slice(0, 5).join(', ') + ` | ${Lv1.equipe_devant} / ${Lh.nul} / ${Lg.nul}`);
    // Lignes du verdict — conseil par les seules probabilités, un contexte
    // DÉFAVORABLE le dégrade d'un cran (couplage asymétrique, 2026-11-06).
    const L = pl && pl.lignes;
    check('Lignes du verdict : léger favori',
      L && L.pronostic === 'Galatasaray 46 % · Nul 25 % · Stuttgart 29 % → Léger favori : Galatasaray'
        && L.nul === '25 %, risque normal' && L.buts === 'Plus de 2,5 buts à 53 % · les deux équipes marquent à 56 %'
        && L.conseil_probas === 'Pronostic fragile (Galatasaray léger favori) → Remboursé si nul sur Galatasaray'
        && L.conseil.FAVORABLE === L.conseil_probas && L.conseil['MITIGÉ'] === L.conseil_probas
        && L.conseil['DÉFAVORABLE'] === 'Pronostic trop incertain (Galatasaray léger favori, contexte défavorable) → Pas de pari sur le résultat',
      L ? JSON.stringify(L.conseil) : 'null');
    const fake = (h, d, a, lh, la) => ({ pHome: h, pDraw: d, pAway: a, lambdaHome: lh, lambdaAway: la });
    const Ln = M.lignesVerdict(fake(0.70, 0.18, 0.12, 2.4, 0.9), 'PSG', 'Lens'); // favori net, Over ~64 %
    check('Lignes : favori net = solide quel que soit le contexte, sauf DÉFAVORABLE -> fragile',
      Ln.conseil.FAVORABLE === 'Pronostic solide (PSG favori net) → Victoire de PSG + Plus de 2,5 buts'
        && Ln.conseil['MITIGÉ'] === Ln.conseil.FAVORABLE
        && Ln.conseil['DÉFAVORABLE'] === 'Pronostic fragile (PSG favori net, contexte défavorable) → Remboursé si nul sur PSG + Plus de 2,5 buts',
      JSON.stringify(Ln.conseil));
    const Lo = M.lignesVerdict(fake(0.38, 0.31, 0.31, 1.0, 0.9), 'A', 'B'); // ouvert, nul élevé, Under
    check('Lignes : match ouvert sans équipe devant -> pas de pari, contexte sans effet',
      Lo.pronostic.endsWith('→ Match ouvert') && Lo.nul === '31 %, risque élevé'
        && Object.values(Lo.conseil).every(c => c === 'Pronostic trop incertain (match ouvert) → Pas de pari sur le résultat + Moins de 2,5 buts'),
      JSON.stringify(Lo.conseil));
    const Lk = M.lignesVerdict(fake(0.31, 0.26, 0.43, 1.1, 1.4), 'Gaziantep FK', 'Kasımpaşa'); // ouvert, Kasımpaşa devant
    check('Lignes : match ouvert avec équipe devant (>= 40 %) -> double chance, DÉFAVORABLE -> pas de pari',
      Lk.equipe_devant === 'Kasımpaşa' && Lk.pronostic.endsWith('→ Match ouvert, Kasımpaşa légèrement devant (43 %)')
        && Lk.conseil.FAVORABLE === 'Pronostic fragile (match ouvert, Kasımpaşa légèrement devant) → Double chance : Kasımpaşa ou nul'
        && Lk.conseil['MITIGÉ'] === Lk.conseil.FAVORABLE
        && Lk.conseil['DÉFAVORABLE'] === 'Pronostic trop incertain (match ouvert, Kasımpaşa légèrement devant, contexte défavorable) → Pas de pari sur le résultat',
      JSON.stringify(Lk.conseil));
    const Ld = M.lignesVerdict(fake(0.50, 0.30, 0.20, 1.3, 0.7), 'A', 'B'); // léger favori, nul élevé
    check('Lignes : léger favori + nul élevé -> double chance', Ld.conseil_probas.includes('→ Double chance : A ou nul'), Ld.conseil_probas);
    check('Lignes : aucun contexte ne crée de pari (FAVORABLE = conseil des probabilités)',
      [L, Ln, Lo, Lk, Ld].every(x => x.conseil.FAVORABLE === x.conseil_probas));
    check('Lignes : équipe jugée = favori, équipe devant, ou null',
      L.equipe_jugee === 'Galatasaray' && Lk.equipe_jugee === 'Kasımpaşa' && Lo.equipe_jugee === null && Ln.equipe_jugee === 'PSG');
    check('Lignes : adversaire de l\'équipe jugée', Lk.adversaire_jugee === 'Gaziantep FK' && L.adversaire_jugee === 'Stuttgart' && Lo.adversaire_jugee === null);
    check('payloadModele(null) = null (match non calculable)', M.payloadModele(null, 'A', 'B') === null);

    // v2-tirs. Calcul à la main : championnat de 2 équipes, 50 tirs cadrés chacune
    // (5/match × 10), 20 et 10 buts -> c = 30/100 = 0,3, K = 0,3·0,7/0,02² = 525.
    // A : 50·(20 + 157,5)/575 = 15,4348 buts attendus ; mL = 30/20 = 1,5 (vrais buts) ;
    // att A = (15,4348 + 13·1,5)/23/1,5 = 1,01260. Défense inchangée : (10+19,5)/23/1,5 = 0,85507.
    const tt = [
      { team_id: 'A', championnat: 'L', buts_pour: 20, buts_contre: 10, matchs_joues: 10, tirs_cadres: 5 },
      { team_id: 'B', championnat: 'L', buts_pour: 10, buts_contre: 20, matchs_joues: 10, tirs_cadres: 5 },
      { team_id: 'C', championnat: 'L2', buts_pour: 20, buts_contre: 10, matchs_joues: 10, tirs_cadres: null },
    ];
    const eloT = { equipes: { A: { elo: 1600 }, B: { elo: 1600 }, C: { elo: 1600 } }, moyennes_championnats: {} };
    const cT = M.v2tirs.prepare(tt, eloT, { equipes: {} });
    check('v2-tirs : attaque lissée sur les tirs (A = 1,0126)', near(cT.indices.A.att, 1.01260, 0.0005), cT.indices.A.att);
    check('v2-tirs : défense inchangée (A = 0,8551)', near(cT.indices.A.def, 0.85507, 0.0005), cT.indices.A.def);
    check('v2-tirs : sans tirs cadrés, buts réels (C = indice v2)', near(cT.indices.C.att, M.v2.prepare(tt, eloT, { equipes: {} }).indices.C.att, 1e-9));
    check('v2-tirs : version propre', M.v2tirs.matchProbabilities(cT, 'A', 'B').version === 'v2-elo-k13-tirs-sd2');
    // Marché des buts : μ = 2,5 -> P(≥3) = 1 − e^−2,5(1 + 2,5 + 3,125) = 0,45619 -> pas de pari ; μ = 3,2 -> 0,62010 -> plus.
    check('marcheButs : P(+2,5) à μ = 2,5', near(M.marcheButs({ lambdaHome: 1.5, lambdaAway: 1.0 }).pOver, 0.45619, 0.0001));
    check('marcheButs : pari plus à 62 %, aucun à 46 %', M.marcheButs({ lambdaHome: 2, lambdaAway: 1.2 }).pari === 'plus' && M.marcheButs({ lambdaHome: 1.5, lambdaAway: 1.0 }).pari === null);

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
