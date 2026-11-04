/*
 * model.js — moteur de prédiction des matchs (P victoire domicile / nul / extérieur).
 *
 * Un seul fichier partagé, chargé par <script src="model.js"> : avant, le modèle
 * vivait dans meilleurs-paris.html et chaque copie d'une constante finissait par
 * diverger. Expose un unique objet global `Modele` (pas de variables globales nues).
 *
 * Versions (chaque version est figée : changer une formule ou une constante =
 * nouvelle version_modele, sinon les logs/comparaisons deviennent inexploitables) :
 *   - Modele.v1 : "v1-poisson-k6" — modèle historique, référence (ne pas le modifier).
 *   - Modele.v2 : "v2-elo-k13" — Elo des clubs + Poisson, référence (prod du 2026-11-03 au 2026-11-05).
 *   - Modele.v3 : "moy-v1v2-w50" — moyenne 50/50 de v1 et v2, EN PRODUCTION (Meilleurs Paris)
 *     depuis le 2026-11-05. Repli explicite sur la v2 quand la v1 n'est pas calculable.
 */
(function (global) {
  'use strict';

  function poissonPmf(lambda, k) {
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 2; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
  }

  // P(1) / P(N) / P(2) d'un double Poisson indépendant, tronqué à maxGoals buts
  // par équipe, renormalisé (la troncature retire une masse négligeable).
  function poissonOutcomes(lambdaHome, lambdaAway, maxGoals) {
    let pHome = 0, pDraw = 0, pAway = 0;
    for (let i = 0; i <= maxGoals; i++) {
      const pi = poissonPmf(lambdaHome, i);
      for (let j = 0; j <= maxGoals; j++) {
        const p = pi * poissonPmf(lambdaAway, j);
        if (i > j) pHome += p;
        else if (i === j) pDraw += p;
        else pAway += p;
      }
    }
    const total = pHome + pDraw + pAway;
    return { pHome: pHome / total, pDraw: pDraw / total, pAway: pAway / total };
  }

  // ===========================================================================
  // v1 — "v1-poisson-k6" (modèle historique, identique à la production)
  // ===========================================================================
  // 1. attackIndex = buts marqués/match rapportés à la moyenne de SON championnat,
  //    defenseIndex = buts encaissés/match, idem, avec shrinkage bayésien K=6 ;
  // 2. buts attendus = moyenne × attaque × défense adverse × 1,08 (dom) / 0,94 (ext) ;
  // 3. correction inter-ligues par Elo moyen de championnat (ajoutée le 2026-11-03).
  // Défaut connu (motif de la v2) : la correction de ligue s'applique en entier
  // alors que le lissage n'a restitué qu'une partie de la supériorité d'un club
  // sur sa ligue -> pénalise les clubs dominants d'une ligue plus faible
  // (Galatasaray - Stuttgart : favori Stuttgart, alors que l'Elo des clubs dit
  // l'inverse).
  const v1 = (function () {
    const VERSION = 'v1-poisson-k6';
    const SHRINK_K = 6;
    const HOME_ADV = 1.08;
    const AWAY_ADV = 0.94;
    const MAX_GOALS = 8;
    // Elo moyen par championnat (ClubElo, classement du 2026-11-02).
    const LEAGUE_ELO = {
      'Premier League': 1838, 'Liga': 1766, 'Bundesliga': 1752, 'Serie A': 1740,
      "Ligue 1 McDonald's": 1713, 'Championship': 1611, 'Süper Lig': 1606,
      'Liga Portugal Betclic': 1595, 'Eredivisie': 1559, 'Ligue 2': 1540,
    };
    // 100 pts d'écart Elo = x1,25 sur les buts (calibré sur 1/(1+10^(-écart/400))).
    const ELO_GOAL_K = 0.00225;

    function computeLeagueAverages(teams) {
      const byLeague = {};
      teams.forEach(t => {
        if (!t.championnat || !t.matchs_joues) return;
        if (!byLeague[t.championnat]) byLeague[t.championnat] = { buts: 0, matchs: 0 };
        byLeague[t.championnat].buts += t.buts_pour || 0;
        byLeague[t.championnat].matchs += t.matchs_joues || 0;
      });
      const avgByLeague = {};
      Object.keys(byLeague).forEach(lg => {
        avgByLeague[lg] = byLeague[lg].matchs ? byLeague[lg].buts / byLeague[lg].matchs : 1.3;
      });
      return avgByLeague;
    }

    function buildTeamIndices(teams, leagueAvg) {
      const map = {};
      teams.forEach(t => {
        const avg = leagueAvg[t.championnat] || 1.3;
        const n = t.matchs_joues || 0;
        const attackRate = ((t.buts_pour || 0) + SHRINK_K * avg) / (n + SHRINK_K);
        const defenseRate = ((t.buts_contre || 0) + SHRINK_K * avg) / (n + SHRINK_K);
        map[t.team_id] = {
          attackIndex: attackRate / avg,
          defenseIndex: defenseRate / avg,
          leagueAvg: avg,
          league: t.championnat,
        };
      });
      return map;
    }

    function matchProbabilities(home, away) {
      if (!home || !away) return null;
      const avg = (home.leagueAvg + away.leagueAvg) / 2;
      let lambdaHome = avg * home.attackIndex * away.defenseIndex * HOME_ADV;
      let lambdaAway = avg * away.attackIndex * home.defenseIndex * AWAY_ADV;

      const crossLeague = home.league !== away.league;
      const eloH = LEAGUE_ELO[home.league], eloA = LEAGUE_ELO[away.league];
      const leagueAdjusted = crossLeague && eloH != null && eloA != null;
      if (leagueAdjusted) {
        const f = Math.exp(ELO_GOAL_K * (eloH - eloA));
        lambdaHome *= f;
        lambdaAway /= f;
      }
      return Object.assign(poissonOutcomes(lambdaHome, lambdaAway, MAX_GOALS), {
        lambdaHome, lambdaAway, crossLeague, leagueAdjusted, version: VERSION,
      });
    }

    return {
      VERSION, SHRINK_K, HOME_ADV, AWAY_ADV, MAX_GOALS, LEAGUE_ELO, ELO_GOAL_K,
      computeLeagueAverages, buildTeamIndices, matchProbabilities,
    };
  })();

  // ===========================================================================
  // v2 — "v2-elo-k13" : Elo des clubs pour le rapport de force, Poisson pour les buts
  // ===========================================================================
  // Principe : QUI est favori vient uniquement de l'Elo des clubs (ClubElo, échelle
  // commune à tous les championnats, donc plus de correction de ligue) ; COMBIEN de
  // buts vient des indices attaque/défense de la saison. Formules figées (voir
  // CLAUDE.md, section "Modèle v2") — ne pas les "simplifier" :
  //   dE = eloDom + advDomLigue - eloExt          (TOUT l'avantage du terrain ici)
  //   s  = exp(2·k·dE)                             (PAS exp(k·dE) : pente 2x trop faible)
  //   T  = mL · (attDom·defExt + attExt·defDom)    (strictement neutre, sans 1,08/0,94)
  //   λdom = T·s/(1+s), λext = T/(1+s)             (conserve le total : λdom+λext = T)
  //   plancher 0,25 sur chaque λ
  // Vérifié : reproduit la formule Elo 1/(1+10^(-dE/400)) sur l'espérance
  // P(1)+½P(N) (±0,01 jusqu'à dE=200), 25 % de nuls pour deux équipes égales à T=2,8.
  const v2 = (function () {
    const VERSION = 'v2-elo-k13';
    const K_ELO = 0.00225;      // même calibrage que v1 (100 pts = x1,25 sur le rapport de buts)
    const K_LISSAGE = 13;       // lissage bayésien des indices (v1 : 6) — n'agit que sur T
    const ADV_DOM_DEFAUT = 65;  // avantage du terrain en points Elo
    // Par championnat, jamais par équipe (trop bruité sur une demi-saison).
    // Même valeur partout pour l'instant ; à différencier plus tard (plus fort en
    // Süper Lig / Liga Portugal qu'en Eredivisie).
    const ADV_DOM_LIGUE = {};
    const PLANCHER_LAMBDA = 0.25;
    const MAX_GOALS = 10;       // T peut dépasser 4 buts : troncature plus large que v1
    const M_DEFAUT = 1.4;       // buts/équipe/match si aucun des deux championnats n'est connu

    function buildTeamIndices(teams, leagueAvg) {
      const map = {};
      teams.forEach(t => {
        const avg = leagueAvg[t.championnat] || M_DEFAUT;
        const n = t.matchs_joues || 0;
        map[t.team_id] = {
          att: ((t.buts_pour || 0) + K_LISSAGE * avg) / (n + K_LISSAGE) / avg,
          def: ((t.buts_contre || 0) + K_LISSAGE * avg) / (n + K_LISSAGE) / avg,
          league: t.championnat,
          mL: avg,
        };
      });
      return map;
    }

    /**
     * Prépare le contexte d'une passe de calcul.
     * @param teams  lignes classements_foot (team_id, championnat, buts_pour, buts_contre, matchs_joues)
     * @param eloData contenu de elo-clubs.json
     * @param mapping contenu de elo-mapping.json (pour distinguer "absent chez ClubElo" et "jamais apparié")
     */
    function prepare(teams, eloData, mapping) {
      const leagueAvg = v1.computeLeagueAverages(teams);
      return {
        indices: buildTeamIndices(teams, leagueAvg),
        elo: (eloData && eloData.equipes) || {},
        eloLigue: (eloData && eloData.moyennes_championnats) || {},
        mapping: (mapping && mapping.equipes) || {},
      };
    }

    // Elo d'une équipe. Fallback EXPLICITE : Elo moyen de son championnat, et
    // la prédiction est marquée dégradée. Jamais de valeur silencieuse.
    function eloOf(ctx, teamId, league) {
      const e = ctx.elo[teamId];
      if (e) return { elo: e.elo, degrade: false, raison: null };
      const raison = teamId in ctx.mapping ? 'absent chez ClubElo' : 'non apparié (elo-mapping.json)';
      const moy = league != null ? ctx.eloLigue[league] : undefined;
      return { elo: moy != null ? moy : null, degrade: true, raison };
    }

    function matchProbabilities(ctx, homeId, awayId) {
      const iH = ctx.indices[homeId], iA = ctx.indices[awayId];
      const leagueH = iH ? iH.league : null, leagueA = iA ? iA.league : null;
      const eH = eloOf(ctx, homeId, leagueH), eA = eloOf(ctx, awayId, leagueA);
      if (eH.elo == null || eA.elo == null) return null; // ni Elo ni championnat connu

      // Équipe sans stats de saison (hors de nos 10 championnats) : indices neutres.
      const attH = iH ? iH.att : 1, defH = iH ? iH.def : 1;
      const attA = iA ? iA.att : 1, defA = iA ? iA.def : 1;
      // mL = niveau de buts de la compétition. Faute de données propres à la
      // Ligue des Champions, moyenne des deux championnats (valeur journalisée).
      const ms = [iH && iH.mL, iA && iA.mL].filter(v => v != null);
      const mL = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : M_DEFAUT;

      const advDomLigue = (leagueH && ADV_DOM_LIGUE[leagueH] != null) ? ADV_DOM_LIGUE[leagueH] : ADV_DOM_DEFAUT;
      const dE = eH.elo + advDomLigue - eA.elo;
      const s = Math.exp(2 * K_ELO * dE);
      const T = mL * (attH * defA + attA * defH);
      const lambdaHome = Math.max((T * s) / (1 + s), PLANCHER_LAMBDA);
      const lambdaAway = Math.max(T / (1 + s), PLANCHER_LAMBDA);

      return Object.assign(poissonOutcomes(lambdaHome, lambdaAway, MAX_GOALS), {
        lambdaHome, lambdaAway, T, dE, s,
        eloHome: eH.elo, eloAway: eA.elo,
        eloDegrade: eH.degrade || eA.degrade,
        eloDegradeDetail: [eH.degrade && `${homeId} : ${eH.raison}`, eA.degrade && `${awayId} : ${eA.raison}`].filter(Boolean),
        advDomLigue, mL_utilise: mL, K_lissage: K_LISSAGE,
        attHome: attH, defHome: defH, attAway: attA, defAway: defA,
        crossLeague: leagueH !== leagueA,
        version: VERSION,
      });
    }

    // Compteur d'équipes sans Elo réel parmi celles demandées, affiché en
    // console : s'il n'est pas à zéro, des prédictions sont dégradées.
    function eloCoverage(ctx, teamIds) {
      const nonApparies = [], absents = [];
      [...new Set(teamIds)].forEach(id => {
        if (ctx.elo[id]) return;
        (id in ctx.mapping ? absents : nonApparies).push(id);
      });
      if (nonApparies.length || absents.length) {
        console.warn(`[Modele v2] ${nonApparies.length} équipe(s) non appariée(s) à ClubElo, ` +
          `${absents.length} absente(s) chez ClubElo -> Elo moyen du championnat (prédiction dégradée)`,
          { nonApparies, absents });
      } else {
        console.info('[Modele v2] toutes les équipes ont un Elo ClubElo.');
      }
      return { nonApparies, absents };
    }

    return {
      VERSION, K_ELO, K_LISSAGE, ADV_DOM_DEFAUT, ADV_DOM_LIGUE, PLANCHER_LAMBDA, MAX_GOALS,
      buildTeamIndices, prepare, eloOf, matchProbabilities, eloCoverage,
    };
  })();

  // ===========================================================================
  // Marché : probabilités implicites des cotes 1/N/2, marge retirée par la
  // méthode de la puissance (p_i = (1/cote_i)^k, k tel que Σ p_i = 1). Moins
  // biaisée que la normalisation proportionnelle sur les gros outsiders.
  // Repère de calibration du modèle, PAS un signal de pari.
  // ===========================================================================
  const marche = (function () {
    const METHODE = 'puissance';
    function demarginer(cotes) {
      if (!Array.isArray(cotes) || cotes.length !== 3 || cotes.some(c => !(c > 1))) return null;
      const q = cotes.map(c => 1 / c);
      const somme = q.reduce((a, b) => a + b, 0);
      let lo = 0.1, hi = 10, k = 1;
      for (let it = 0; it < 100; it++) {
        k = (lo + hi) / 2;
        const s = q.reduce((a, x) => a + Math.pow(x, k), 0);
        if (s > 1) lo = k; else hi = k;
      }
      const p = q.map(x => Math.pow(x, k));
      return { pHome: p[0], pDraw: p[1], pAway: p[2], marge: somme - 1, k, methode: METHODE };
    }
    return { METHODE, demarginer };
  })();

  // ===========================================================================
  // Moyenne v1/v2 — "moy-v1v2-w50" : brique de calcul de la v3 (voir Modele.v3).
  // P = w·P(v1) + (1−w)·P(v2) sur chaque issue, w = 0,5 figé AVANT toute mesure
  // (2026-11-04). Idée : v1 (buts de la saison) et v2 (Elo des clubs) se trompent
  // sur des cas différents (v1 : clubs dominants d'une ligue faible ; v2 :
  // dynamique de la saison), la moyenne peut réduire l'erreur. Voir CLAUDE.md.
  // ===========================================================================
  const moyenneV1V2 = (function () {
    const VERSION = 'moy-v1v2-w50';
    const W_V1 = 0.5;
    function combiner(p1, p2) {
      if (!p1 || !p2) return null;
      const m = k => W_V1 * p1[k] + (1 - W_V1) * p2[k];
      return { pHome: m('pHome'), pDraw: m('pDraw'), pAway: m('pAway'), version: VERSION, W_V1 };
    }
    return { VERSION, W_V1, combiner };
  })();

  // ===========================================================================
  // v3 — EN PRODUCTION depuis le 2026-11-05 : moyenne v1/v2 (même VERSION
  // 'moy-v1v2-w50', formule inchangée). Même interface que la v2 (prepare /
  // matchProbabilities / eloCoverage) et mêmes métadonnées (crossLeague,
  // eloDegrade, dE, T...) reprises de la v2.
  // Repli EXPLICITE : si la v1 n'est pas calculable (équipe sans stats de saison,
  // ex. adversaire de Coupe d'Europe hors de nos championnats), on renvoie la v2
  // avec v3Repli = true et version = v2 — jamais une moyenne silencieusement
  // incomplète.
  // ===========================================================================
  const v3 = (function () {
    const VERSION = moyenneV1V2.VERSION;
    function prepare(teams, eloData, mapping) {
      return { v1: v1.buildTeamIndices(teams, v1.computeLeagueAverages(teams)), v2: v2.prepare(teams, eloData, mapping) };
    }
    function matchProbabilities(ctx, homeId, awayId) {
      const p2 = v2.matchProbabilities(ctx.v2, homeId, awayId);
      if (!p2) return null;
      const p1 = v1.matchProbabilities(ctx.v1[homeId], ctx.v1[awayId]);
      const detail = { probV1: p1 ? { pHome: p1.pHome, pDraw: p1.pDraw, pAway: p1.pAway } : null,
                       probV2: { pHome: p2.pHome, pDraw: p2.pDraw, pAway: p2.pAway } };
      if (!p1) return Object.assign({}, p2, detail, { version: v2.VERSION, v3Repli: true });
      const m = moyenneV1V2.combiner(p1, p2);
      return Object.assign({}, p2, detail, { pHome: m.pHome, pDraw: m.pDraw, pAway: m.pAway, version: VERSION, v3Repli: false });
    }
    function eloCoverage(ctx, teamIds) { return v2.eloCoverage(ctx.v2, teamIds); }
    return { VERSION, prepare, matchProbabilities, eloCoverage };
  })();

  global.Modele = {
    moyenneV1V2,
    v3,
    poissonPmf,
    poissonOutcomes,
    v1,
    v2,
    marche,
    // Raccourci demandé : Modele.v1_poisson(home, away) avec les indices de
    // Modele.v1.buildTeamIndices.
    v1_poisson: v1.matchProbabilities,
  };

  // Utilisable aussi sous Node pour les tests hors navigateur.
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Modele;
})(typeof window !== 'undefined' ? window : globalThis);
