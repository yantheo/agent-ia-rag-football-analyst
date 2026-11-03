/*
 * model.js — moteur de prédiction des matchs (P victoire domicile / nul / extérieur).
 *
 * Un seul fichier partagé, chargé par <script src="model.js"> : avant, le modèle
 * vivait dans meilleurs-paris.html et chaque copie d'une constante finissait par
 * diverger. Expose un unique objet global `Modele` (pas de variables globales nues).
 *
 * Versions (chaque version est figée : changer une formule ou une constante =
 * nouvelle version_modele, sinon les logs/comparaisons deviennent inexploitables) :
 *   - Modele.v1 : "v1-poisson-k6" — modèle historique (en production sur main).
 *     CONSERVÉ TEL QUEL comme référence de comparaison, ne pas le modifier.
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

  global.Modele = {
    poissonPmf,
    poissonOutcomes,
    v1,
    // Raccourci demandé : Modele.v1_poisson(home, away) avec les indices de
    // Modele.v1.buildTeamIndices.
    v1_poisson: v1.matchProbabilities,
  };

  // Utilisable aussi sous Node pour les tests hors navigateur.
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Modele;
})(typeof window !== 'undefined' ? window : globalThis);
