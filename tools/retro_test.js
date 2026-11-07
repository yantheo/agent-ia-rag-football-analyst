#!/usr/bin/env node
/*
 * Rétro-test sur l'historique football-data (donnees/football-data, voir tools/import_football_data.py).
 *
 * Question : remplacer les buts marqués par « tirs cadrés × conversion lissée » (v2-tirs) améliore-t-il
 * les prédictions ? Et le second lissage (K = 13 de la v2, appliqué aussi à la v2-tirs) est-il trop fort ?
 *
 * Fidélité : les modèles viennent de model.js TEL QUEL (Modele.v1, v2, v2tirs, marcheButs, marche).
 * Seules les variantes « lissage K » sont recodées ici, avec un contrôle : à K = 13 elles doivent donner
 * exactement la v2 / v2-tirs de model.js (vérifié à chaque lancement, sinon arrêt).
 *
 * Pas de fuite d'information : chaque match est prédit avec les stats de la saison AVANT sa date (les
 * matchs d'un même jour sont tous prédits avant de mettre les stats à jour), dans son championnat.
 *
 * Marchés testés :
 *   - Plus / moins de 2,5 buts. En v2, P(+2,5) = P(Poisson(T) >= 3) avec T = buts attendus du match : T ne
 *     dépend PAS de l'Elo, d'où un test possible sur 15 ans sans Elo historique. Variantes : v2 (K 13),
 *     v2-tirs (model.js), v2 et v2-tirs avec un second lissage K plus faible.
 *   - 1/N/2 : v1 (n'a pas besoin d'Elo pour un match de championnat) contre « v1-tirs » (attaque = tirs
 *     cadrés × conversion lissée, même transformation que la v2-tirs). La v1 fait la moitié de la v3.
 *     La v2 (Elo) n'est pas testée en 1/N/2 : il faudrait l'Elo ClubElo historique.
 * Mesures : Brier, log-loss, écart au marché de clôture démargé (Pinnacle, sinon Betfair, sinon moyenne),
 * différences appariées avec leur erreur type (z). Le K variante est CHOISI sur 2012/13-2018/19 et MESURÉ sur
 * 2019/20-2025/26 (hors échantillon). Fenêtre récente (5 dernières saisons) rapportée à part.
 *
 * Usage : node tools/retro_test.js            -> rapport à l'écran + donnees/rapports/retro-test-<date>.md
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'model.js'));
const DATA = path.join(ROOT, 'donnees', 'football-data');

const MIN_J = 3;                       // match prédit si les deux équipes ont joué >= 3 matchs de la saison
const GRILLE_K = [50, 30, 20, 13, 8, 4, 2];
const CALIB = s => s < 2019;           // saisons 2012/13 -> 2018/19 : choix du K
const RECENT = s => s >= 2021 && s <= 2025;

// ---------------------------------------------------------------- lecture CSV (guillemets gérés)
function parseCSV(txt) {
  const lignes = [];
  let ligne = [], champ = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { champ += '"'; i++; } else q = false; } else champ += c; }
    else if (c === '"') q = true;
    else if (c === ',') { ligne.push(champ); champ = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      ligne.push(champ); champ = ''; lignes.push(ligne); ligne = [];
    } else champ += c;
  }
  if (champ || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  const tete = lignes.shift().map(h => h.replace(/^﻿/, '').trim());
  return lignes.filter(l => l.length > 3).map(l => Object.fromEntries(tete.map((h, i) => [h, (l[i] || '').trim()])));
}
const num = x => (x === '' || x == null ? null : Number(x));
const dateISO = s => { const [j, m, a] = s.split('/'); return `${a.length === 2 ? '20' + a : a}-${m.padStart(2, '0')}-${j.padStart(2, '0')}`; };

// ---------------------------------------------------------------- variantes de lissage (recodées)
// Même formule que Modele.v2.buildTeamIndices, K en paramètre.
function indicesK(teams, leagueAvg, K) {
  const map = {};
  teams.forEach(t => {
    const avg = leagueAvg[t.championnat] || 1.4, n = t.matchs_joues || 0;
    map[t.team_id] = { att: ((t.buts_pour || 0) + K * avg) / (n + K) / avg,
                       def: ((t.buts_contre || 0) + K * avg) / (n + K) / avg, league: t.championnat, mL: avg };
  });
  return map;
}
const ELO_NEUTRE = ids => ({ equipes: Object.fromEntries(ids.map(id => [id, { elo: 1500 }])), moyennes_championnats: {} });
const MAP_VIDE = { equipes: {} };
function ctxV2(teams, K) {
  const ctx = M.v2.prepare(teams, ELO_NEUTRE(teams.map(t => t.team_id)), MAP_VIDE);
  if (K !== M.v2.K_LISSAGE) ctx.indices = indicesK(teams, M.v1.computeLeagueAverages(teams), K);
  return ctx;
}
function ctxV2tirs(teams, K) {
  const ctx = M.v2tirs.prepare(teams, ELO_NEUTRE(teams.map(t => t.team_id)), MAP_VIDE);
  if (K !== M.v2.K_LISSAGE) ctx.indices = indicesK(M.v2tirs.butsAttendus(teams), M.v1.computeLeagueAverages(teams), K);
  return ctx;
}
const pOver = (ctx, h, a) => M.marcheButs(M.v2.matchProbabilities(ctx, h, a)).pOver;

// ---------------------------------------------------------------- mesures
const brier2 = (p, y) => (p - y) ** 2;
const ll2 = (p, y) => -Math.log(Math.min(Math.max(y ? p : 1 - p, 1e-12), 1));
const brier3 = (p, r) => ['H', 'D', 'A'].reduce((s, k, i) => s + (p[i] - (r === k ? 1 : 0)) ** 2, 0);
const ll3 = (p, r) => -Math.log(Math.max(p[['H', 'D', 'A'].indexOf(r)], 1e-12));
function resume(vals) {
  const n = vals.length, m = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { n, m, se: sd / Math.sqrt(n) };
}

// ---------------------------------------------------------------- boucle principale
const inv = JSON.parse(fs.readFileSync(path.join(DATA, 'inventaire.json'), 'utf8')).fichiers;
const obs = [];        // une entrée par match prédit
let controle = 0;
for (const cle of Object.keys(inv).sort()) {
  const f = inv[cle];
  const annee = Number(f.saison.slice(0, 4));
  if (f.saison_en_cours) continue;                     // saison en cours : incomplète, gardée pour plus tard
  const rows = parseCSV(fs.readFileSync(path.join(DATA, cle + '.csv'), 'utf8'))
    .filter(r => r.Date && r.FTHG !== '' && r.HST !== '' && r.AST !== '')
    .map(r => ({ ...r, iso: dateISO(r.Date) })).sort((a, b) => a.iso.localeCompare(b.iso));
  const st = {};                                       // stats de la saison par équipe
  let ligueN = 0, ligueOver = 0;                       // référence naïve : taux de +2,5 du championnat à date
  const eq = n => (st[n] = st[n] || { team_id: n, championnat: f.division, matchs_joues: 0, buts_pour: 0, buts_contre: 0, tc: 0 });
  for (let i = 0; i < rows.length;) {
    const jour = rows[i].iso, lot = [];
    while (i < rows.length && rows[i].iso === jour) lot.push(rows[i++]);
    const teams = Object.values(st).filter(t => t.matchs_joues > 0)
      .map(t => ({ ...t, tirs_cadres: t.tc / t.matchs_joues }));
    const ids = new Set(teams.map(t => t.team_id));
    const pret = lot.filter(r => ids.has(r.HomeTeam) && ids.has(r.AwayTeam)
      && st[r.HomeTeam].matchs_joues >= MIN_J && st[r.AwayTeam].matchs_joues >= MIN_J);
    if (pret.length) {
      const c2 = Object.fromEntries(GRILLE_K.map(K => [K, ctxV2(teams, K)]));
      const c2t = Object.fromEntries(GRILLE_K.map(K => [K, ctxV2tirs(teams, K)]));
      const avg = M.v1.computeLeagueAverages(teams);
      const i1 = M.v1.buildTeamIndices(teams, avg);
      const i1t = M.v1.buildTeamIndices(M.v2tirs.butsAttendus(teams), avg);
      // Contrôle de fidélité : variante K=13 recodée == model.js (indices identiques).
      if (controle < 50) {
        const ref = M.v2tirs.prepare(teams, ELO_NEUTRE([...ids]), MAP_VIDE).indices;
        const rec = indicesK(M.v2tirs.butsAttendus(teams), avg, 13);
        for (const id of ids) if (Math.abs(ref[id].att - rec[id].att) > 1e-12) throw new Error('variante K=13 != model.js');
        controle++;
      }
      for (const r of pret) {
        const h = r.HomeTeam, a = r.AwayTeam, total = num(r.FTHG) + num(r.FTAG);
        const o = { saison: annee, div: f.division, jmin: Math.min(st[h].matchs_joues, st[a].matchs_joues),
                    y: total > 2.5 ? 1 : 0, res: r.FTR, over: {}, x12: {} };
        for (const K of GRILLE_K) { o.over['v2_K' + K] = pOver(c2[K], h, a); o.over['v2tirs_K' + K] = pOver(c2t[K], h, a); }
        o.over.naif_ligue = (ligueOver + 20 * 0.5) / (ligueN + 20);
        const p1 = M.v1.matchProbabilities(i1[h], i1[a]), p1t = M.v1.matchProbabilities(i1t[h], i1t[a]);
        o.x12.v1 = [p1.pHome, p1.pDraw, p1.pAway];
        o.x12.v1tirs = [p1t.pHome, p1t.pDraw, p1t.pAway];
        // Marché de clôture : Pinnacle, sinon Betfair Exchange, sinon moyenne.
        for (const [src, cH, cD, cA] of [['Pinnacle', 'PSCH', 'PSCD', 'PSCA'], ['Betfair', 'BFECH', 'BFECD', 'BFECA'], ['moyenne', 'AvgCH', 'AvgCD', 'AvgCA']]) {
          const d = M.marche.demarginer([num(r[cH]), num(r[cD]), num(r[cA])]);
          if (d) { o.m12 = [d.pHome, d.pDraw, d.pAway]; o.m12src = src; break; }
        }
        for (const [src, cO, cU] of [['Pinnacle', 'PC>2.5', 'PC<2.5'], ['Betfair', 'BFEC>2.5', 'BFEC<2.5'], ['moyenne', 'AvgC>2.5', 'AvgC<2.5']]) {
          const po = num(r[cO]), pu = num(r[cU]);
          if (po > 1 && pu > 1) { o.mOver = (1 / po) / (1 / po + 1 / pu); o.mOverSrc = src; o.coteOver = po; o.coteUnder = pu; break; }
        }
        obs.push(o);
      }
    }
    for (const r of lot) {                             // mise à jour APRÈS les prédictions du jour
      const h = eq(r.HomeTeam), a = eq(r.AwayTeam), gh = num(r.FTHG), ga = num(r.FTAG);
      h.matchs_joues++; a.matchs_joues++; h.buts_pour += gh; h.buts_contre += ga; a.buts_pour += ga; a.buts_contre += gh;
      h.tc += num(r.HST); a.tc += num(r.AST);
      ligueN++; ligueOver += gh + ga > 2.5 ? 1 : 0;
    }
  }
}

// ---------------------------------------------------------------- rapport
const out = [];
const P = s => { out.push(s); console.log(s); };
const f3 = x => x.toFixed(4), sg = x => (x >= 0 ? '+' : '') + x.toFixed(4);
function tableOver(sel, titre, modeles) {
  const L = obs.filter(sel); if (!L.length) return;
  P(`\n### ${titre} — ${L.length} matchs (part de +2,5 : ${(100 * L.reduce((s, o) => s + o.y, 0) / L.length).toFixed(1)} %)`);
  P('| modèle | Brier | log-loss | Δ Brier vs v2 (K13) | z |');
  P('|---|---|---|---|---|');
  for (const m of modeles) {
    const b = resume(L.map(o => brier2(o.over[m], o.y))), l = resume(L.map(o => ll2(o.over[m], o.y)));
    const d = resume(L.map(o => brier2(o.over[m], o.y) - brier2(o.over.v2_K13, o.y)));
    P(`| ${m} | ${f3(b.m)} | ${f3(l.m)} | ${m === 'v2_K13' ? '—' : sg(d.m)} | ${m === 'v2_K13' ? '—' : (d.m / d.se).toFixed(1)} |`);
  }
  const Lm = L.filter(o => o.mOver != null);
  if (Lm.length) {
    const b = resume(Lm.map(o => brier2(o.mOver, o.y)));
    const src = [...new Set(Lm.map(o => o.mOverSrc))].join(' / ');
    P(`| marché clôture (${src}, ${Lm.length} matchs) | ${f3(b.m)} | ${f3(resume(Lm.map(o => ll2(o.mOver, o.y))).m)} | | |`);
    P(`\nÉcart moyen au marché de clôture (points de %) : ` + modeles.map(m => `${m} ${(100 * resume(Lm.map(o => Math.abs(o.over[m] - o.mOver))).m).toFixed(1)}`).join(' · '));
  }
}
function table12(sel, titre) {
  const L = obs.filter(sel); if (!L.length) return;
  P(`\n### ${titre} — ${L.length} matchs`);
  P('| modèle | Brier | log-loss | Δ Brier vs v1 | z |');
  P('|---|---|---|---|---|');
  for (const m of ['v1', 'v1tirs']) {
    const b = resume(L.map(o => brier3(o.x12[m], o.res))), l = resume(L.map(o => ll3(o.x12[m], o.res)));
    const d = resume(L.map(o => brier3(o.x12[m], o.res) - brier3(o.x12.v1, o.res)));
    P(`| ${m} | ${f3(b.m)} | ${f3(l.m)} | ${m === 'v1' ? '—' : sg(d.m)} | ${m === 'v1' ? '—' : (d.m / d.se).toFixed(1)} |`);
  }
  const Lm = L.filter(o => o.m12);
  if (Lm.length) P(`| marché clôture (${[...new Set(Lm.map(o => o.m12src))].join(' / ')}) | ${f3(resume(Lm.map(o => brier3(o.m12, o.res))).m)} | ${f3(resume(Lm.map(o => ll3(o.m12, o.res))).m)} | | |`);
}

P(`# Rétro-test football-data — ${new Date().toISOString().slice(0, 10)}`);
P(`${obs.length} matchs prédits (saisons terminées 2012/13 -> 2025/26, 10 championnats, les deux équipes à >= ${MIN_J} matchs joués).`);
P('Fidélité : variante K = 13 recodée identique à model.js (contrôlé). Δ < 0 = meilleur que la référence ; |z| >= 2 = écart net.');

// Choix du K sur la période de calibration, pour chaque famille.
const calib = obs.filter(o => CALIB(o.saison));
const meilleurK = fam => GRILLE_K.map(K => [K, resume(calib.map(o => brier2(o.over[`${fam}_K${K}`], o.y))).m]).sort((a, b) => a[1] - b[1]);
const k2 = meilleurK('v2'), k2t = meilleurK('v2tirs');
P(`\n## Plus / moins de 2,5 buts`);
P(`Choix du second lissage sur 2012/13-2018/19 (${calib.length} matchs), Brier par K :`);
P(`- v2 : ` + k2.map(([K, b]) => `K${K} ${f3(b)}`).join(' · ') + ` -> meilleur K = ${k2[0][0]}`);
P(`- v2-tirs : ` + k2t.map(([K, b]) => `K${K} ${f3(b)}`).join(' · ') + ` -> meilleur K = ${k2t[0][0]}`);
const mods = [...new Set(['naif_ligue', 'v2_K13', 'v2tirs_K13', `v2_K${k2[0][0]}`, `v2tirs_K${k2t[0][0]}`])];
P(`\nModèles comparés : naif_ligue = taux de +2,5 du championnat depuis le début de saison (référence sans équipe) ; v2_K13 = v2 de prod (buts attendus) ; v2tirs_K13 = v2-tirs de model.js ; les autres = second lissage choisi ci-dessus.`);
tableOver(o => o.saison >= 2019, 'Hors échantillon : 2019/20 -> 2025/26', mods);
tableOver(o => RECENT(o.saison), 'Fenêtre récente : 2021/22 -> 2025/26 (5 saisons)', mods);
tableOver(o => o.saison >= 2019 && o.jmin < 10, 'Hors échantillon, début de saison (une équipe à < 10 matchs)', mods);
tableOver(o => o.saison >= 2019 && o.jmin >= 20, 'Hors échantillon, fin de saison (les deux à >= 20 matchs)', mods);
P('\nPar championnat (hors échantillon), Δ Brier de chaque variante vs v2_K13 :');
for (const d of [...new Set(obs.map(o => o.div))].sort()) {
  const L = obs.filter(o => o.saison >= 2019 && o.div === d);
  P(`- ${d} (${L.length}) : ` + mods.filter(m => m !== 'v2_K13').map(m => { const r = resume(L.map(o => brier2(o.over[m], o.y) - brier2(o.over.v2_K13, o.y))); return `${m} ${sg(r.m)} (z ${(r.m / r.se).toFixed(1)})`; }).join(' · '));
}
P('\nCalibration hors échantillon (v2_K13 et marché), par tranche de P(+2,5) prédite :');
P('| tranche | matchs | v2 prédit | observé | marché prédit (mêmes matchs) |');
P('|---|---|---|---|---|');
for (let b = 0.3; b < 0.75; b += 0.05) {
  const L = obs.filter(o => o.saison >= 2019 && o.over.v2_K13 >= b && o.over.v2_K13 < b + 0.05);
  if (L.length < 50) continue;
  const moy = f => (100 * L.reduce((s, o) => s + f(o), 0) / L.length).toFixed(1);
  P(`| ${Math.round(b * 100)}-${Math.round(b * 100) + 5} % | ${L.length} | ${moy(o => o.over.v2_K13)} % | ${moy(o => o.y)} % | ${moy(o => o.mOver)} % |`);
}
// Règle de conseil de l'appli (model.js, marcheButs) : « plus de 2,5 » si P affichée >= 60 %, « moins » si
// <= 40 %. Bilan sur les cotes de CLÔTURE (référence exigeante : on parie en général plus tôt, à d'autres cotes).
P('\nRègle de conseil de l\'appli (+2,5 si P affichée >= 60 %, -2,5 si <= 40 %), hors échantillon, mise 1 à la cote de clôture :');
P('| modèle | côté | paris | gagnés | P moyenne annoncée | rendement |');
P('|---|---|---|---|---|---|');
for (const m of ['v2_K13', `v2_K${k2[0][0]}`, 'v2tirs_K13']) {
  for (const cote of ['plus', 'moins']) {
    const L = obs.filter(o => o.saison >= 2019 && o.coteOver && (cote === 'plus' ? Math.round(100 * o.over[m]) >= 60 : Math.round(100 * o.over[m]) <= 40));
    if (!L.length) { P(`| ${m} | ${cote} | 0 | | | |`); continue; }
    const gagne = o => (cote === 'plus' ? o.y === 1 : o.y === 0);
    const gain = L.reduce((s, o) => s + (gagne(o) ? (cote === 'plus' ? o.coteOver : o.coteUnder) - 1 : -1), 0);
    const pAnn = L.reduce((s, o) => s + (cote === 'plus' ? o.over[m] : 1 - o.over[m]), 0) / L.length;
    P(`| ${m} | ${cote} | ${L.length} | ${(100 * L.filter(gagne).length / L.length).toFixed(1)} % | ${(100 * pAnn).toFixed(1)} % | ${(100 * gain / L.length).toFixed(1)} % |`);
  }
}
P(`\n## 1/N/2 (v1 contre v1-tirs)`);
table12(o => o.saison >= 2019, 'Hors échantillon : 2019/20 -> 2025/26');
table12(o => RECENT(o.saison), 'Fenêtre récente : 2021/22 -> 2025/26');
table12(o => o.saison < 2019, 'Période 2012/13 -> 2018/19');

const dir = path.join(ROOT, 'donnees', 'rapports');
fs.mkdirSync(dir, { recursive: true });
const fichier = path.join(dir, `retro-test-${new Date().toISOString().slice(0, 10)}.md`);
fs.writeFileSync(fichier, out.join('\n') + '\n');
console.log(`\n-> ${path.relative(ROOT, fichier)}`);
