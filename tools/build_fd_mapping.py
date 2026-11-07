#!/usr/bin/env python3
"""
Construit fd-mapping.json : team_id (calendrier / classements_foot Supabase) -> nom de l'equipe chez
football-data.co.uk (CSV gratuits : resultats, tirs, xG, cotes).

Pourquoi PAS de rapprochement par les noms : teste le 2026-11-07, la meilleure suggestion automatique
par ressemblance de nom etait fausse dans ~1 cas sur 5 parmi les noms differents (Paris SG -> Paris FC,
Ath Madrid -> Real Madrid, Nott'm Forest -> Brentford...), sans aucune erreur visible. Meme piege que
l'Elo (Inter -> Milan).

Methode (independante des noms) :
  1. EMPREINTE CHIFFREE (preuve principale) : pour chaque equipe, matchs joues / buts pour / buts
     contre, au total, a domicile et a l'exterieur (classements_foot + classement_domicile /
     classement_exterieur) comparés a ceux recalcules depuis le CSV. football-data a 1 a 5 jours de
     retard : les matchs joues depuis sa derniere mise a jour (lus dans `calendrier`) sont deduits
     cote par cote ; un cote (domicile / exterieur) sans match depuis doit etre IDENTIQUE, un cote avec
     des matchs depuis n'est controle que sur le nombre de matchs. Le candidat doit etre UNIQUE dans
     le championnat.
  2. AFFICHES (controle) : une fois la table posee, aucun match football-data ne doit etre CONTREDIT
     par `calendrier` (l'une des deux equipes y jouant le meme jour contre un autre adversaire ou de
     l'autre cote). Un match simplement absent du calendrier (trou du scrape) ne compte pas.
  3. Le nom ne sert qu'a l'affichage (« meme nom » ou non).
Statuts : "auto" (empreinte unique et affiches concordantes), "a_verifier" (le reste, avec les
raisons), "valide_main" (pose a la main dans fd-mapping.json : jamais ecrase par ce script).
Controles : un nom football-data n'est attribue qu'a un seul team_id ; toute equipe sans
correspondance est listee, jamais devinee.

Usage (stdlib uniquement, depuis la racine du repo) :
  python3 tools/build_fd_mapping.py            # saison 2026/27
  python3 tools/build_fd_mapping.py 2627       # code de saison football-data
Code de sortie 1 s'il reste des equipes a verifier ou sans correspondance.
"""
import collections
import csv
import datetime
import io
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "fd-mapping.json"

# Code de division football-data -> nom du championnat dans Supabase (colonne `championnat`).
LIGUES = {
    "E0": "Premier League",
    "E1": "Championship",
    "SP1": "Liga",
    "I1": "Serie A",
    "D1": "Bundesliga",
    "F1": "Ligue 1 McDonald's",
    "F2": "Ligue 2",
    "N1": "Eredivisie",
    "P1": "Liga Portugal Betclic",
    "T1": "Süper Lig",
}
SEUIL_AFFICHES = 0.8    # part minimale des matchs couverts par le calendrier retrouves a l'identique
FRAICHEUR_JOURS = 3     # meme filtre que les pages (lignes orphelines d'une saison precedente)
UK = ZoneInfo("Europe/London")


def get(url, headers=None, essais=4):
    req = urllib.request.Request(url, headers={"User-Agent": "football-analyst-mapping", **(headers or {})})
    for i in range(essais):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                texte = r.read().decode("utf-8-sig", errors="replace")
            if "football-data" in url:
                time.sleep(2)            # politesse : un fichier toutes les 2 s
            return texte
        except urllib.error.HTTPError as e:
            if e.code not in (429, 502, 503) or i == essais - 1:
                raise
            time.sleep(30 * (i + 1))     # surcharge passagere (503 vu le 2026-11-07) : on attend


def supabase():
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    key = re.search(r"SUPABASE_ANON_KEY = '([^']+)'", src).group(1)
    url = re.search(r"https://[a-z0-9]+\.supabase\.co", src).group(0)

    def q(path):
        return json.loads(get(f"{url}/rest/v1/{path}", {"apikey": key, "Authorization": "Bearer " + key}))
    return q


def fd_date(s):
    d, m, y = s.split("/")
    return datetime.date(int(y) + (2000 if len(y) == 2 else 0), int(m), int(d))


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


def compatible(fd, sb, depuis):
    """fd / sb : {'dom': [j, bp, bc], 'ext': [j, bp, bc]} ; depuis : {'dom': k, 'ext': k}.
    Renvoie (ok, detail)."""
    for cote in ("dom", "ext"):
        if sb[cote] is None:
            return False, f"{cote} absent de Supabase"
        # Un match du calendrier posterieur a la mise a jour football-data peut ne pas etre compte
        # par Supabase (reporte, ou classement footmercato pas encore a jour : Derby - Bolton du
        # 2026-11-06) : on accepte entre 0 et k matchs en plus, buts identiques si 0.
        k = depuis[cote]
        ecart = sb[cote][0] - fd[cote][0]
        if not 0 <= ecart <= k:
            return False, f"{cote} : J Supabase {sb[cote][0]}, football-data {fd[cote][0]} (+ 0 a {k} depuis)"
        if ecart == 0 and sb[cote][1:] != fd[cote][1:]:
            return False, f"{cote} : buts Supabase {sb[cote][1:]}, football-data {fd[cote][1:]}"
    exacts = [c for c in ("dom", "ext") if sb[c][0] == fd[c][0]]
    return True, "identiques" if len(exacts) == 2 else (f"identiques ({exacts[0]} seulement)" if exacts else "J seulement")


def main():
    saison = sys.argv[1] if len(sys.argv) > 1 else "2627"
    q = supabase()
    limite = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=FRAICHEUR_JOURS)).isoformat()
    equipes = [t for t in q("classements_foot?select=team_id,equipe,championnat,classement_domicile,"
                            "classement_exterieur,updated_at")
               if t["updated_at"] >= limite and t["championnat"] in LIGUES.values()]
    par_id = {t["team_id"]: t for t in equipes}
    cal = q(f"calendrier?select=date_match,championnat,team_id_domicile,team_id_exterieur"
            f"&date_match=gte.20{saison[:2]}-07-01&limit=10000")
    affiches = collections.defaultdict(set)       # (championnat, date UK) -> {(dom, ext)}
    for c in cal:
        if c["championnat"] in LIGUES.values() and c["team_id_domicile"] and c["team_id_exterieur"]:
            d = datetime.datetime.fromisoformat(c["date_match"]).astimezone(UK).date()
            affiches[(c["championnat"], d)].add((c["team_id_domicile"], c["team_id_exterieur"]))
    hier = datetime.date.today() - datetime.timedelta(days=1)

    existant = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"equipes": {}}
    manuels = {tid: e for tid, e in existant.get("equipes", {}).items() if e.get("statut") == "valide_main"}
    noms_manuels = {(e["ligue"], e["fd"]) for e in manuels.values()}

    resultat, problemes = {}, []
    for code, champ in LIGUES.items():
        rows = [r for r in csv.DictReader(io.StringIO(get(f"https://football-data.co.uk/mmz4281/{saison}/{code}.csv")))
                if r.get("Date") and r.get("FTHG", "") != ""]
        derniere = max(fd_date(r["Date"]) for r in rows)
        fd = collections.defaultdict(lambda: {"dom": [0, 0, 0], "ext": [0, 0, 0]})
        for r in rows:
            h, a, gh, ga = r["HomeTeam"], r["AwayTeam"], int(r["FTHG"]), int(r["FTAG"])
            for nom, cote, bp, bc in ((h, "dom", gh, ga), (a, "ext", ga, gh)):
                t = fd[nom][cote]; t[0] += 1; t[1] += bp; t[2] += bc
        depuis = collections.defaultdict(lambda: {"dom": 0, "ext": 0})
        for (ch, d), paires in affiches.items():
            if ch == champ and derniere < d <= hier:
                for dom, ext in paires:
                    depuis[dom]["dom"] += 1; depuis[ext]["ext"] += 1
        sb = {}
        for t in equipes:
            if t["championnat"] != champ:
                continue
            cd, ce = t.get("classement_domicile"), t.get("classement_exterieur")
            sb[t["team_id"]] = {"dom": [cd["j"], cd["bp"], cd["bc"]] if cd else None,
                                "ext": [ce["j"], ce["bp"], ce["bc"]] if ce else None}

        # 1. Empreintes : candidats compatibles, puis affectation des candidats uniques (iterative).
        cands = {nom: {tid: compatible(fd[nom], sb[tid], depuis[tid])[1] for tid in sb
                       if compatible(fd[nom], sb[tid], depuis[tid])[0]} for nom in fd if (code, nom) not in noms_manuels}
        affecte = {}
        change = True
        while change:
            change = False
            pris = set(affecte.values())
            for nom, c in cands.items():
                libres = [tid for tid in c if tid not in pris]
                if nom not in affecte and len(libres) == 1:
                    affecte[nom] = libres[0]; change = True; pris.add(libres[0])

        # 2. Affiches : chaque match d'un jour couvert doit exister a l'identique dans le calendrier.
        vers_tid = dict(affecte)
        vers_tid.update({e["fd"]: tid for tid, e in manuels.items() if e["ligue"] == code})
        couverts, retrouves = collections.Counter(), collections.Counter()
        absentes = collections.defaultdict(list)
        for r in rows:
            paires = affiches.get((champ, fd_date(r["Date"])))
            if not paires:
                continue
            h, a = r["HomeTeam"], r["AwayTeam"]
            th, ta = vers_tid.get(h), vers_tid.get(a)
            ok = (th, ta) in paires
            # Match absent du calendrier (trou du scrape, ex. 3 matchs de GAE en aout-septembre) : ni pour
            # ni contre. Seule une CONTRADICTION compte : l'une des deux equipes joue ce jour-la contre un
            # autre adversaire, ou de l'autre cote.
            if not ok and not any(th in p or ta in p for p in paires):
                continue
            for nom in (h, a):
                couverts[nom] += 1; retrouves[nom] += ok
                if not ok:
                    absentes[nom].append(f"{r['Date']} {h} - {a}")

        for nom in sorted(fd):
            if (code, nom) in noms_manuels:
                if absentes[nom]:            # une saisie manuelle est controlee comme le reste
                    problemes.append(f"{code}:{nom} (valide_main) contredit par le calendrier : {absentes[nom]}")
                continue
            tid = affecte.get(nom)
            n, ok = couverts[nom], retrouves[nom]
            preuve = {"fd_dom_ext": fd[nom], "affiches": f"{ok}/{n}"}
            if absentes[nom]:
                preuve["affiches_absentes"] = absentes[nom]
            raisons = []
            if tid is None:
                c = cands.get(nom, {})
                raisons.append("aucune empreinte compatible" if not c else f"plusieurs candidats : {sorted(c)}")
            else:
                preuve.update({"supabase_dom_ext": sb[tid], "matchs_depuis_maj_fd": depuis[tid],
                               "empreinte": cands[nom][tid]})
                if n and ok / n < SEUIL_AFFICHES:
                    raisons.append(f"affiches : {ok}/{n} matchs retrouves dans le calendrier")
            cle = tid or f"?{code}:{nom}"
            entree = {"fd": nom, "ligue": code, "equipe": par_id[tid]["equipe"] if tid else None,
                      "meme_nom": bool(tid and norm(nom) == norm(par_id[tid]["equipe"])),
                      "statut": "a_verifier" if raisons else "auto", "preuve": preuve}
            if raisons:
                entree["raisons"] = raisons
            resultat[cle] = entree
        for tid in sb:
            if tid not in resultat and tid not in manuels:
                problemes.append(f"{tid} ({champ}) : aucune equipe football-data ne lui correspond")

    resultat.update(manuels)                     # une validation manuelle n'est jamais ecrasee
    vus = collections.Counter((e["ligue"], e["fd"]) for e in resultat.values())
    problemes += [f"{l}:{n} attribue a plusieurs team_id" for (l, n), k in vus.items() if k > 1]
    out = {
        "_doc": "Correspondance team_id -> nom football-data.co.uk, construite par tools/build_fd_mapping.py "
                "(empreinte chiffree dom/ext + affiches du calendrier, PAS les noms). statut : auto / "
                "a_verifier / valide_main (pose a la main, jamais ecrase). Saison " + saison + ".",
        "genere_le": datetime.date.today().isoformat(),
        "ligues": LIGUES,
        "equipes": dict(sorted(resultat.items())),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    c = collections.Counter(e["statut"] for e in resultat.values())
    print(f"{len(resultat)} equipes : {dict(c)}, noms differents : "
          f"{sum(1 for e in resultat.values() if not e.get('meme_nom'))} -> {OUT.name}")
    for tid, e in resultat.items():
        if e["statut"] == "a_verifier":
            print(f"  A VERIFIER {tid:28} <- {e['fd']:20} {e.get('raisons')}")
    for p in problemes:
        print("  PROBLEME", p)
    return 1 if problemes or c.get("a_verifier") else 0


if __name__ == "__main__":
    sys.exit(main())
