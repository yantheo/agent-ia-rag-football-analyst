#!/usr/bin/env node
/*
 * Tableau comparatif des pronostics d'un jour : prod (v3) et références (v1, v2, v2-tirs) contre le candidat
 * de la branche donnees-reelles (« v2-buts-calibres » = v2 avec un second lissage K = 50 : meilleur sur le
 * +/- 2,5 au rétro-test du 2026-11-07) et contre le marché (cotes football-data fixtures.csv : Betfair Exchange,
 * sinon moyenne des bookmakers ; bwin affiché pour information).
 *
 * Mêmes données que l'appli : classements_foot Supabase (clé anon de index.html), elo-clubs.json,
 * elo-mapping.json, model.js tel quel. Contrôle : la v3 recalculée doit égaler la v3 figée
 * (predictions-figees.json) — sinon les données ont changé depuis le gel et c'est signalé.
 * Gel : les prédictions du candidat et le marché sont écrits dans predictions-figees-branche.json (même clé
 * date|dom|ext), une seule fois par match et seulement AVANT le coup d'envoi (jamais réécrits).
 *
 * Usage : python3 tools/import_football_data.py (pour donnees/football-data/fixtures.csv, ou le télécharger)
 *         node tools/pronos_du_jour.js [AAAA-MM-JJ]   (défaut : aujourd'hui)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'model.js'));
const K_CANDIDAT = 50;
const JOUR = process.argv[2] || new Date().toISOString().slice(0, 10);
const FIGEES_BRANCHE = path.join(ROOT, 'predictions-figees-branche.json');

function parseCSV(txt) {
  const L = txt.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map(l => l.split(','));
  const h = L.shift();
  return L.map(l => Object.fromEntries(h.map((k, i) => [k, l[i]])));
}
const num = x => (x === '' || x == null ? null : Number(x));
const pct = x => (x == null ? '—' : Math.round(100 * x) + '');
const trio = p => (p ? `${pct(p[0])}/${pct(p[1])}/${pct(p[2])}` : '—');

function indicesK(teams, leagueAvg, K) {               // = Modele.v2.buildTeamIndices avec K en paramètre
  const map = {};
  teams.forEach(t => {
    const avg = leagueAvg[t.championnat] || 1.4, n = t.matchs_joues || 0;
    map[t.team_id] = { att: ((t.buts_pour || 0) + K * avg) / (n + K) / avg,
                       def: ((t.buts_contre || 0) + K * avg) / (n + K) / avg, league: t.championnat, mL: avg };
  });
  return map;
}

(async () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const key = src.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1], url = src.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
  const limite = new Date(Date.now() - 3 * 86400e3).toISOString();
  const teams = (await (await fetch(`${url}/rest/v1/classements_foot?select=*`, { headers: { apikey: key } })).json())
    .filter(t => t.updated_at >= limite);
  const majStats = teams.reduce((m, t) => (t.updated_at > m ? t.updated_at : m), '');
  const eloData = JSON.parse(fs.readFileSync(path.join(ROOT, 'elo-clubs.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(ROOT, 'elo-mapping.json'), 'utf8'));
  const figees = JSON.parse(fs.readFileSync(path.join(ROOT, 'predictions-figees.json'), 'utf8')).predictions;
  const fdm = JSON.parse(fs.readFileSync(path.join(ROOT, 'fd-mapping.json'), 'utf8')).equipes;
  const versTid = {}; for (const [tid, e] of Object.entries(fdm)) versTid[`${e.ligue}|${e.fd}`] = tid;

  const ctx3 = M.v3.prepare(teams, eloData, mapping);
  const ctxT = M.v2tirs.prepare(teams, eloData, mapping);
  const ctxK = M.v2.prepare(teams, eloData, mapping);
  ctxK.indices = indicesK(teams, M.v1.computeLeagueAverages(teams), K_CANDIDAT);
  const nom = Object.fromEntries(teams.map(t => [t.team_id, t.equipe]));

  // Cotes du jour (fixtures.csv), par paire de team_id.
  const cotes = {};
  const fx = path.join(ROOT, 'donnees', 'football-data', 'fixtures.csv');
  if (fs.existsSync(fx)) for (const r of parseCSV(fs.readFileSync(fx, 'utf8'))) {
    const [j, m, a] = (r.Date || '').split('/'); if (`${a}-${m}-${j}` !== JOUR) continue;
    const h = versTid[`${r.Div}|${r.HomeTeam}`], w = versTid[`${r.Div}|${r.AwayTeam}`];
    if (h && w) cotes[`${h}|${w}`] = r;
  }

  const figBr = fs.existsSync(FIGEES_BRANCHE) ? JSON.parse(fs.readFileSync(FIGEES_BRANCHE, 'utf8')) : {
    _info: 'Predictions de la branche donnees-reelles figees AVANT les matchs par tools/pronos_du_jour.js. Cle = date|dom|ext. ' +
      'oK50 = P(+2,5) du candidat v2-buts-calibres (v2, second lissage K 50) ; m12 / mO = marche demarge (Betfair Exchange, ' +
      'sinon moyenne) au moment du gel ; source_cotes ; fige_le. Ne jamais modifier une valeur deja figee.', predictions: {} };

  const lignes = [], ecartsV3 = [];
  const cles = Object.keys(figees).filter(k => k.startsWith(JOUR + '|')).sort();
  for (const k of cles) {
    const [, dom, ext] = k.split('|'), f = figees[k];
    const p3 = M.v3.matchProbabilities(ctx3, dom, ext), pT = M.v2tirs.matchProbabilities(ctxT, dom, ext);
    const pK = M.v2.matchProbabilities(ctxK, dom, ext);
    if (!p3) { lignes.push({ k, dom, ext, erreur: 'incalculable' }); continue; }
    const v3 = [p3.pHome, p3.pDraw, p3.pAway];
    if (f.pm) ecartsV3.push(Math.max(...v3.map((x, i) => Math.abs(x - f.pm[i]))));
    const r = cotes[`${dom}|${ext}`];
    let m12 = null, mO = null, srcC = null, bwO = null;
    if (r) {
      for (const [s, a, b, c, o, u] of [['Betfair', 'BFEH', 'BFED', 'BFEA', 'BFE>2.5', 'BFE<2.5'], ['moyenne', 'AvgH', 'AvgD', 'AvgA', 'Avg>2.5', 'Avg<2.5']]) {
        const d = M.marche.demarginer([num(r[a]), num(r[b]), num(r[c])]);
        if (d && num(r[o]) > 1 && num(r[u]) > 1) { m12 = [d.pHome, d.pDraw, d.pAway]; mO = (1 / num(r[o])) / (1 / num(r[o]) + 1 / num(r[u])); srcC = s; break; }
      }
      bwO = num(r['B365>2.5']);
    }
    const oProd = M.marcheButs(M.v2.matchProbabilities(ctx3.v2, dom, ext)).pOver;
    const oK = M.marcheButs(pK).pOver, oT = M.marcheButs(pT).pOver;
    const conseil = p => (Math.round(100 * p) >= 60 ? 'plus' : Math.round(100 * p) <= 40 ? 'moins' : '—');
    lignes.push({ k, dom, ext, v1: [p3.probV1 ? p3.probV1.pHome : null, p3.probV1 && p3.probV1.pDraw, p3.probV1 && p3.probV1.pAway],
      v2: [p3.probV2.pHome, p3.probV2.pDraw, p3.probV2.pAway], v3, m12, oProd, oT, oK, mO, srcC,
      cProd: conseil(oProd), cK: conseil(oK), eloApprox: p3.eloDegrade });
    if (!figBr.predictions[k]) {
      figBr.predictions[k] = { oK50: +oK.toFixed(4), m12: m12 && m12.map(x => +x.toFixed(4)), mO: mO && +mO.toFixed(4),
        source_cotes: srcC, fige_le: new Date().toISOString(), stats_maj: majStats };
    }
  }
  fs.writeFileSync(FIGEES_BRANCHE, JSON.stringify(figBr, null, 1) + '\n');

  const out = [], P = s => { out.push(s); console.log(s); };
  P(`# Pronostics du ${JOUR} — prod contre branche donnees-reelles et marché`);
  P(`Stats Supabase du ${majStats.slice(0, 16)} UTC ; Elo = elo-clubs.json (prod) ; cotes football-data du jour (Betfair Exchange, sinon moyenne). ` +
    `Contrôle : v3 recalculée vs v3 figée, écart max ${ecartsV3.length ? (100 * Math.max(...ecartsV3)).toFixed(2) : '—'} pt sur ${ecartsV3.length} matchs.`);
  P('\n## 1/N/2 (en %, domicile / nul / extérieur)');
  P('| Match | v1 | v2 | **v3 (prod)** | Marché | Écart v3 – marché | Écart v2 – marché |');
  P('|---|---|---|---|---|---|---|');
  const ecart = (p, m) => (p && m ? Math.round(100 * Math.max(...p.map((x, i) => Math.abs(x - m[i])))) + ' pts' : '—');
  for (const l of lignes) {
    if (l.erreur) { P(`| ${nom[l.dom]} – ${nom[l.ext]} | ${l.erreur} | | | | | |`); continue; }
    P(`| ${nom[l.dom]} – ${nom[l.ext]}${l.eloApprox ? ' ⚠️' : ''} | ${trio(l.v1)} | ${trio(l.v2)} | **${trio(l.v3)}** | ${trio(l.m12)} | ${ecart(l.v3, l.m12)} | ${ecart(l.v2, l.m12)} |`);
  }
  P('\n⚠️ = Elo approximatif (équipe sans Elo ClubElo fiable : Elo moyen de son championnat).');
  P('\n## Plus de 2,5 buts (P en %) et conseil buts (plus si >= 60 %, moins si <= 40 %)');
  P('| Match | v2 (prod) | v2-tirs | **candidat K50** | Marché | Conseil prod | Conseil candidat |');
  P('|---|---|---|---|---|---|---|');
  for (const l of lignes) if (!l.erreur)
    P(`| ${nom[l.dom]} – ${nom[l.ext]} | ${pct(l.oProd)} | ${pct(l.oT)} | **${pct(l.oK)}** | ${pct(l.mO)} | ${l.cProd} | ${l.cK} |`);
  const ok = lignes.filter(l => !l.erreur && l.m12);
  const moy = f => (ok.reduce((s, l) => s + f(l), 0) / ok.length * 100).toFixed(1);
  const fav = p => p.indexOf(Math.max(...p));
  P(`\n**Résumé (${ok.length} matchs avec cotes)** : écart max moyen au marché en 1/N/2 — v1 ${moy(l => Math.max(...l.v1.map((x, i) => Math.abs(x - l.m12[i]))))} · v2 ${moy(l => Math.max(...l.v2.map((x, i) => Math.abs(x - l.m12[i]))))} · v3 ${moy(l => Math.max(...l.v3.map((x, i) => Math.abs(x - l.m12[i]))))} pts ; ` +
    `même favori que le marché — v1 ${ok.filter(l => fav(l.v1) === fav(l.m12)).length} · v2 ${ok.filter(l => fav(l.v2) === fav(l.m12)).length} · v3 ${ok.filter(l => fav(l.v3) === fav(l.m12)).length} / ${ok.length}. ` +
    `+2,5 : écart moyen au marché — prod ${moy(l => Math.abs(l.oProd - l.mO))} · v2-tirs ${moy(l => Math.abs(l.oT - l.mO))} · candidat K50 ${moy(l => Math.abs(l.oK - l.mO))} pts ; ` +
    `conseils buts — prod ${lignes.filter(l => l.cProd && l.cProd !== '—').length}, candidat ${lignes.filter(l => l.cK && l.cK !== '—').length}.`);
  const dir = path.join(ROOT, 'donnees', 'rapports'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `pronos-${JOUR}.md`), out.join('\n') + '\n');
  console.log(`\n-> donnees/rapports/pronos-${JOUR}.md ; gel : ${path.basename(FIGEES_BRANCHE)}`);
})().catch(e => { console.error(e); process.exit(1); });
