#!/usr/bin/env node
/*
 * Rétro-test 1/N/2 : v1, v2, v3 (model.js TEL QUEL) sur l'historique football-data, avec un ELO MAISON.
 *
 * Pourquoi un Elo maison : l'API ClubElo (Elo historique de la prod) était en panne le 2026-11-07. Cet Elo
 * est calculé ici à partir des seuls matchs de championnat football-data (pas de coupes d'Europe, pas
 * d'échelle commune entre pays) : la « v2 » et la « v3 » testées ici sont donc des APPROXIMATIONS de la
 * prod. Résultat indicatif, à refaire avec ClubElo quand l'API répondra.
 *
 * Elo maison — paramètres fixés AVANT le test (aucun réglage sur les résultats) :
 *   - K = 20, avantage du terrain 65 (= ADV_DOM_DEFAUT de la v2), multiplicateur d'écart de buts de l'Elo
 *     mondial (1 / 1,5 / (11 + N) / 8) ;
 *   - une équipe qui apparaît dans une division prend la moyenne des 3 derniers de cette division à la fin
 *     de la saison précédente (approximation des relégués qu'elle remplace) ; 1500 la première saison ;
 *   - Angleterre et France : E0/E1 et F1/F2 partagent l'échelle (montées / descentes suivies).
 *   - l'Elo d'un match = celui de la veille (tous les matchs d'un jour sont prédits avant la mise à jour).
 * Saisons 2012/13 et 2013/14 = rodage de l'Elo, non mesurées. Mesure : 2014/15 -> 2025/26.
 * Contrôle : l'Elo maison de la saison en cours est comparé à l'instantané ClubElo de la prod
 * (elo-clubs.json, via fd-mapping.json) : corrélation et dispersion par championnat.
 *
 * Usage : node tools/retro_test_1x2.js   -> écran + donnees/rapports/retro-test-1x2-<date>.md
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'model.js'));
const DATA = path.join(ROOT, 'donnees', 'football-data');

const ELO_K = 20, ELO_HFA = 65, ELO_DEPART = 1500;
// Échelle : l'Elo maison est ~1,3x plus étalé que ClubElo (voir le contrôle du rapport). ELO_ECHELLE=0.75
// resserre les écarts autour de la moyenne de la division au moment de la prédiction (réglage tiré de la
// comparaison avec ClubElo, pas des résultats). Défaut 1 = Elo maison brut.
const ELO_ECHELLE = Number(process.env.ELO_ECHELLE || 1);
const MIN_J = 3, DEBUT_MESURE = 2014, RECENT = s => s >= 2021 && s <= 2025;
const PAYS = { E0: 'ENG', E1: 'ENG', F1: 'FRA', F2: 'FRA', SP1: 'ESP', I1: 'ITA', D1: 'GER', N1: 'NED', P1: 'POR', T1: 'TUR' };

function parseCSV(txt) {
  const lignes = []; let ligne = [], champ = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { champ += '"'; i++; } else q = false; } else champ += c; }
    else if (c === '"') q = true;
    else if (c === ',') { ligne.push(champ); champ = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; ligne.push(champ); champ = ''; lignes.push(ligne); ligne = []; }
    else champ += c;
  }
  if (champ || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  const tete = lignes.shift().map(h => h.replace(/^﻿/, '').trim());
  return lignes.filter(l => l.length > 3).map(l => Object.fromEntries(tete.map((h, i) => [h, (l[i] || '').trim()])));
}
const num = x => (x === '' || x == null ? null : Number(x));
const dateISO = s => { const [j, m, a] = s.split('/'); return `${a.length === 2 ? '20' + a : a}-${m.padStart(2, '0')}-${j.padStart(2, '0')}`; };
const brier3 = (p, r) => ['H', 'D', 'A'].reduce((s, k, i) => s + (p[i] - (r === k ? 1 : 0)) ** 2, 0);
const ll3 = (p, r) => -Math.log(Math.max(p[['H', 'D', 'A'].indexOf(r)], 1e-12));
function resume(v) { const n = v.length, m = v.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return { n, m, se: sd / Math.sqrt(n) }; }

// ---------------------------------------------------------------- chargement (toutes divisions, ordre chronologique)
const inv = JSON.parse(fs.readFileSync(path.join(DATA, 'inventaire.json'), 'utf8')).fichiers;
const saisons = {};      // annee -> [{div, rows}]
for (const cle of Object.keys(inv)) {
  const f = inv[cle], annee = Number(f.saison.slice(0, 4));
  const rows = parseCSV(fs.readFileSync(path.join(DATA, cle + '.csv'), 'utf8'))
    .filter(r => r.Date && r.FTHG !== '' && r.FTR).map(r => ({ ...r, iso: dateISO(r.Date), div: f.division }));
  (saisons[annee] = saisons[annee] || []).push({ div: f.division, rows, enCours: f.saison_en_cours });
}

const elo = {};                                  // "PAYS:nom" -> Elo
const finSaison = {};                            // div -> Elo moyen des 3 derniers à la fin de la saison précédente
const cleEq = (div, nom) => `${PAYS[div]}:${nom}`;
function g(n) { return n <= 1 ? 1 : n === 2 ? 1.5 : (11 + n) / 8; }

const obs = [];
for (const annee of Object.keys(saisons).map(Number).sort()) {
  const fichiers = saisons[annee];
  // Nouvelles équipes : moyenne des 3 derniers de leur division la saison précédente (sinon départ).
  for (const { div, rows } of fichiers) {
    for (const r of rows) for (const n of [r.HomeTeam, r.AwayTeam]) {
      const k = cleEq(div, n);
      if (elo[k] == null) elo[k] = finSaison[div] != null ? finSaison[div] : ELO_DEPART - (div === 'E1' || div === 'F2' ? 150 : 0);
    }
  }
  const tous = fichiers.flatMap(f => f.rows.map(r => ({ ...r, enCours: f.enCours }))).sort((a, b) => a.iso.localeCompare(b.iso));
  const st = {};                                 // stats de saison par division puis équipe
  const eqSt = (div, n) => { st[div] = st[div] || {}; return (st[div][n] = st[div][n] || { team_id: n, championnat: div, matchs_joues: 0, buts_pour: 0, buts_contre: 0 }); };
  for (let i = 0; i < tous.length;) {
    const jour = tous[i].iso, lot = [];
    while (i < tous.length && tous[i].iso === jour) lot.push(tous[i++]);
    if (annee >= DEBUT_MESURE && !lot[0].enCours) {
      for (const div of [...new Set(lot.map(r => r.div))]) {
        const teams = Object.values(st[div] || {}).filter(t => t.matchs_joues > 0);
        const ids = new Set(teams.map(t => t.team_id));
        const pret = lot.filter(r => r.div === div && ids.has(r.HomeTeam) && ids.has(r.AwayTeam)
          && st[div][r.HomeTeam].matchs_joues >= MIN_J && st[div][r.AwayTeam].matchs_joues >= MIN_J);
        if (!pret.length) continue;
        const moyDiv = teams.reduce((x, t) => x + elo[cleEq(div, t.team_id)], 0) / teams.length;
        const eloData = { equipes: Object.fromEntries(teams.map(t => [t.team_id, { elo: moyDiv + ELO_ECHELLE * (elo[cleEq(div, t.team_id)] - moyDiv) }])), moyennes_championnats: {} };
        const ctx3 = M.v3.prepare(teams, eloData, { equipes: {} });
        for (const r of pret) {
          const p3 = M.v3.matchProbabilities(ctx3, r.HomeTeam, r.AwayTeam);
          if (!p3 || p3.v3Repli) throw new Error('v3 incalculable : ' + r.HomeTeam + ' - ' + r.AwayTeam);
          const o = { saison: annee, div, res: r.FTR, jmin: Math.min(st[div][r.HomeTeam].matchs_joues, st[div][r.AwayTeam].matchs_joues),
                      p: { v1: [p3.probV1.pHome, p3.probV1.pDraw, p3.probV1.pAway], v2: [p3.probV2.pHome, p3.probV2.pDraw, p3.probV2.pAway], v3: [p3.pHome, p3.pDraw, p3.pAway] } };
          for (const [src, a, b, c] of [['Pinnacle', 'PSCH', 'PSCD', 'PSCA'], ['Betfair', 'BFECH', 'BFECD', 'BFECA'], ['moyenne', 'AvgCH', 'AvgCD', 'AvgCA']]) {
            const cotes = [num(r[a]), num(r[b]), num(r[c])], d = M.marche.demarginer(cotes);
            if (d) { o.p.marche = [d.pHome, d.pDraw, d.pAway]; o.cotes = cotes; o.src = src; break; }
          }
          obs.push(o);
        }
      }
    }
    // Mise à jour APRÈS les prédictions du jour : stats de saison puis Elo.
    for (const r of lot) {
      const gh = num(r.FTHG), ga = num(r.FTAG), h = eqSt(r.div, r.HomeTeam), a = eqSt(r.div, r.AwayTeam);
      h.matchs_joues++; a.matchs_joues++; h.buts_pour += gh; h.buts_contre += ga; a.buts_pour += ga; a.buts_contre += gh;
      const kh = cleEq(r.div, r.HomeTeam), ka = cleEq(r.div, r.AwayTeam);
      const e = 1 / (1 + Math.pow(10, -(elo[kh] + ELO_HFA - elo[ka]) / 400));
      const s = gh > ga ? 1 : gh === ga ? 0.5 : 0;
      const d = ELO_K * g(Math.abs(gh - ga)) * (s - e);
      elo[kh] += d; elo[ka] -= d;
    }
  }
  // Fin de saison : Elo moyen des 3 derniers (par Elo) de chaque division, pour les arrivants suivants.
  for (const { div, rows } of fichiers) {
    const eqs = [...new Set(rows.flatMap(r => [r.HomeTeam, r.AwayTeam]))].map(n => elo[cleEq(div, n)]).sort((a, b) => a - b);
    finSaison[div] = (eqs[0] + eqs[1] + eqs[2]) / 3;
  }
}

// ---------------------------------------------------------------- rapport
const out = [], P = s => { out.push(s); console.log(s); };
const f3 = x => x.toFixed(4), sg = x => (x >= 0 ? '+' : '') + x.toFixed(4);
P(`# Rétro-test 1/N/2 avec Elo maison — ${new Date().toISOString().slice(0, 10)}`);
P(`${obs.length} matchs (2014/15 -> 2025/26, 10 championnats, les deux équipes à >= ${MIN_J} matchs). v1, v2, v3 = model.js tel quel ;`);
P(`**v2 et v3 utilisent un Elo MAISON** (K ${ELO_K}, terrain ${ELO_HFA}, échelle x${ELO_ECHELLE}, matchs de championnat seulement) à la place de ClubElo : approximation de la prod.`);

// Contrôle de l'Elo maison contre l'instantané ClubElo de la prod (saison en cours).
const fdm = JSON.parse(fs.readFileSync(path.join(ROOT, 'fd-mapping.json'), 'utf8')).equipes;
const ce = JSON.parse(fs.readFileSync(path.join(ROOT, 'elo-clubs.json'), 'utf8')).equipes;
P('\n## Contrôle : Elo maison (fin des données 2026/27) contre ClubElo de la prod (elo-clubs.json)');
P('| championnat | équipes | corrélation | écart-type maison | écart-type ClubElo |');
P('|---|---|---|---|---|');
for (const div of Object.keys(PAYS)) {
  const paires = Object.entries(fdm).filter(([tid, e]) => e.ligue === div && ce[tid] && ce[tid].elo && elo[cleEq(div, e.fd)] != null)
    .map(([tid, e]) => [elo[cleEq(div, e.fd)], ce[tid].elo]);
  if (paires.length < 5) continue;
  const mx = paires.reduce((s, p) => s + p[0], 0) / paires.length, my = paires.reduce((s, p) => s + p[1], 0) / paires.length;
  const sx = Math.sqrt(paires.reduce((s, p) => s + (p[0] - mx) ** 2, 0) / paires.length), sy = Math.sqrt(paires.reduce((s, p) => s + (p[1] - my) ** 2, 0) / paires.length);
  const r = paires.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / paires.length / sx / sy;
  P(`| ${div} | ${paires.length} | ${r.toFixed(2)} | ${sx.toFixed(0)} | ${sy.toFixed(0)} |`);
}

function table(sel, titre) {
  const L = obs.filter(sel); if (!L.length) return;
  const Lm = L.filter(o => o.p.marche);
  P(`\n### ${titre} — ${L.length} matchs`);
  P('| modèle | Brier | log-loss | Δ Brier vs v2 | z | Δ Brier vs v1 | z |');
  P('|---|---|---|---|---|---|---|');
  for (const m of ['v1', 'v2', 'v3']) {
    const b = resume(L.map(o => brier3(o.p[m], o.res))), l = resume(L.map(o => ll3(o.p[m], o.res)));
    const d2 = resume(L.map(o => brier3(o.p[m], o.res) - brier3(o.p.v2, o.res))), d1 = resume(L.map(o => brier3(o.p[m], o.res) - brier3(o.p.v1, o.res)));
    P(`| ${m} | ${f3(b.m)} | ${f3(l.m)} | ${m === 'v2' ? '—' : sg(d2.m)} | ${m === 'v2' ? '—' : (d2.m / d2.se).toFixed(1)} | ${m === 'v1' ? '—' : sg(d1.m)} | ${m === 'v1' ? '—' : (d1.m / d1.se).toFixed(1)} |`);
  }
  if (Lm.length) P(`| marché clôture (${[...new Set(Lm.map(o => o.src))].join(' / ')}, ${Lm.length}) | ${f3(resume(Lm.map(o => brier3(o.p.marche, o.res))).m)} | ${f3(resume(Lm.map(o => ll3(o.p.marche, o.res))).m)} | | | | |`);
  if (Lm.length) {
    const ecart = m => (100 * resume(Lm.map(o => Math.max(...o.p[m].map((x, i) => Math.abs(x - o.p.marche[i]))))).m).toFixed(1);
    const memeFav = m => (100 * Lm.filter(o => o.p[m].indexOf(Math.max(...o.p[m])) === o.p.marche.indexOf(Math.max(...o.p.marche))).length / Lm.length).toFixed(1);
    P(`\nÉcart max moyen au marché (pts) : v1 ${ecart('v1')} · v2 ${ecart('v2')} · v3 ${ecart('v3')} — même favori que le marché : v1 ${memeFav('v1')} % · v2 ${memeFav('v2')} % · v3 ${memeFav('v3')} %`);
  }
}
P('\n## Résultats (Δ < 0 = meilleur ; |z| >= 2 = écart net)');
table(o => true, 'Toute la période : 2014/15 -> 2025/26');
table(o => RECENT(o.saison), 'Fenêtre récente : 2021/22 -> 2025/26 (5 saisons)');
table(o => o.jmin < 10, 'Début de saison (une équipe à < 10 matchs)');
table(o => o.jmin >= 20, 'Fin de saison (les deux à >= 20 matchs)');
P('\nPar championnat, Δ Brier v3 vs v2 et v3 vs v1 :');
for (const div of Object.keys(PAYS)) {
  const L = obs.filter(o => o.div === div); if (!L.length) continue;
  const d = ref => { const r = resume(L.map(o => brier3(o.p.v3, o.res) - brier3(o.p[ref], o.res))); return `${sg(r.m)} (z ${(r.m / r.se).toFixed(1)})`; };
  P(`- ${div} (${L.length}) : vs v2 ${d('v2')} · vs v1 ${d('v1')}`);
}
// Règle de conseil 1/N/2 de l'appli : victoire du favori si P affichée >= 60 %.
P('\nRègle « favori net » de l\'appli (victoire du favori si P affichée >= 60 %), mise 1 à la cote de clôture :');
P('| modèle | paris | gagnés | P moyenne annoncée | rendement |');
P('|---|---|---|---|---|');
for (const m of ['v1', 'v2', 'v3']) {
  const L = obs.filter(o => o.cotes && Math.round(100 * Math.max(...o.p[m])) >= 60 && o.p[m].indexOf(Math.max(...o.p[m])) !== 1);
  const idx = o => o.p[m].indexOf(Math.max(...o.p[m]));
  const gagne = o => ['H', 'D', 'A'][idx(o)] === o.res;
  const gain = L.reduce((s, o) => s + (gagne(o) ? o.cotes[idx(o)] - 1 : -1), 0);
  P(`| ${m} | ${L.length} | ${(100 * L.filter(gagne).length / L.length).toFixed(1)} % | ${(100 * L.reduce((s, o) => s + Math.max(...o.p[m]), 0) / L.length).toFixed(1)} % | ${(100 * gain / L.length).toFixed(1)} % |`);
}

const dir = path.join(ROOT, 'donnees', 'rapports'); fs.mkdirSync(dir, { recursive: true });
const fichier = path.join(dir, `retro-test-1x2-${new Date().toISOString().slice(0, 10)}${ELO_ECHELLE !== 1 ? '-echelle' + ELO_ECHELLE : ''}.md`);
fs.writeFileSync(fichier, out.join('\n') + '\n');
console.log(`\n-> ${path.relative(ROOT, fichier)}`);
