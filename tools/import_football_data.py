#!/usr/bin/env python3
"""
Importe en LOCAL les CSV de football-data.co.uk (resultats, tirs, xG, cotes) pour nos 10 championnats.

Ou : donnees/football-data/<saison>/<division>.csv (dossier ignore par git : donnees volumineuses et
reproductibles, pas dans le repo public) + donnees/football-data/inventaire.json.

- Fichiers BRUTS, tels que publies (source de verite : aucune transformation a l'import).
- Saisons terminees : telechargees une seule fois (relancer avec --force pour les retelecharger).
  Saison en cours : retelechargee a chaque lancement (football-data la met a jour ~2 fois par semaine).
- Inventaire par fichier : nombre de matchs, dates, equipes, et taux de remplissage des colonnes utiles
  (tirs cadres, xG, cloture Pinnacle / Betfair / moyenne, +/- 2,5). Un fichier illisible, vide ou sans
  score fait echouer le script (code de sortie 1) au lieu d'etre ignore en silence.
- Politesse : 2 s entre deux fichiers, nouvelle tentative sur 429 / 502 / 503.

Les noms d'equipes restent ceux de football-data : un retro-test travaille a l'interieur d'une saison
football-data, il n'a pas besoin de nos team_id. Le lien avec nos team_id (saison en cours) : fd-mapping.json.

Usage (stdlib uniquement, depuis la racine du repo) :
  python3 tools/import_football_data.py                 # saisons 2012/13 -> en cours
  python3 tools/import_football_data.py 2019            # a partir de 2019/20
  python3 tools/import_football_data.py --force         # retelecharge aussi les saisons terminees
"""
import csv
import datetime
import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "donnees" / "football-data"
DIVISIONS = {
    "E0": "Premier League", "E1": "Championship", "SP1": "Liga", "I1": "Serie A", "D1": "Bundesliga",
    "F1": "Ligue 1", "F2": "Ligue 2", "N1": "Eredivisie", "P1": "Liga Portugal", "T1": "Süper Lig",
}
DEBUT_DEFAUT = 2012          # cloture Pinnacle (PSCH) publiee a partir de 2012/13 environ
# Colonnes suivies dans l'inventaire (taux de remplissage). Plusieurs noms = synonymes selon les saisons.
SUIVIES = {
    "tirs_cadres": ["HST"],
    "xg": ["HxG"],
    "cloture_pinnacle_1x2": ["PSCH"],
    "cloture_betfair_1x2": ["BFECH"],
    "cloture_moyenne_1x2": ["AvgCH"],
    "ouverture_moyenne_1x2": ["AvgH", "BbAvH"],
    "plus_2_5_moyenne": ["Avg>2.5", "BbAv>2.5"],
    "plus_2_5_cloture_pinnacle": ["PC>2.5"],
    "plus_2_5_cloture_moyenne": ["AvgC>2.5"],
    "bwin_1x2": ["BWH"],
}


def code_saison(annee):
    return f"{annee % 100:02d}{(annee + 1) % 100:02d}"


def saison_en_cours(aujourdhui):
    return aujourdhui.year if aujourdhui.month >= 7 else aujourdhui.year - 1


def telecharger(url, essais=4):
    req = urllib.request.Request(url, headers={"User-Agent": "football-analyst-import"})
    for i in range(essais):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            time.sleep(2)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 502, 503) or i == essais - 1:
                raise
            time.sleep(30 * (i + 1))


def decoder(data):
    for enc in ("utf-8-sig", "cp1252", "latin-1"):     # anciennes saisons parfois en cp1252
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue


def inventorier(data):
    texte, enc = decoder(data)
    lignes = [r for r in csv.DictReader(io.StringIO(texte)) if (r.get("Date") or "").strip()]
    if not lignes:
        raise ValueError("aucun match")
    joues = [r for r in lignes if (r.get("FTHG") or "").strip() != ""]
    if not joues:
        raise ValueError("aucun score")
    cols = set(lignes[0].keys())

    def date(s):
        j, m, a = s.strip().split("/")
        return datetime.date(int(a) + (2000 if len(a) == 2 else 0), int(m), int(j)).isoformat()
    dates = sorted(date(r["Date"]) for r in joues)
    remplissage = {}
    for nom, synonymes in SUIVIES.items():
        col = next((c for c in synonymes if c in cols), None)
        remplissage[nom] = None if col is None else round(
            sum(1 for r in joues if (r.get(col) or "").strip()) / len(joues), 3)
    return {
        "encodage": enc,
        "matchs": len(joues),
        "premier": dates[0], "dernier": dates[-1],
        "equipes": len({r["HomeTeam"] for r in joues} | {r["AwayTeam"] for r in joues}),
        "colonnes": len(cols),
        "remplissage": remplissage,
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    aujourdhui = datetime.date.today()
    courante = saison_en_cours(aujourdhui)
    debut = int(args[0]) if args else DEBUT_DEFAUT
    inv_path = DEST / "inventaire.json"
    inventaire = json.loads(inv_path.read_text(encoding="utf-8")) if inv_path.exists() else {"fichiers": {}}

    erreurs, telecharges, gardes = [], 0, 0
    for annee in range(debut, courante + 1):
        s = code_saison(annee)
        for div in DIVISIONS:
            cle = f"{s}/{div}"
            chemin = DEST / s / f"{div}.csv"
            if chemin.exists() and annee < courante and not force and cle in inventaire["fichiers"]:
                gardes += 1
                continue
            data = telecharger(f"https://football-data.co.uk/mmz4281/{s}/{div}.csv")
            if data is None:
                erreurs.append(f"{cle} : absent chez football-data (404)")
                continue
            try:
                info = inventorier(data)
            except Exception as e:                       # fichier inexploitable : on le dit
                erreurs.append(f"{cle} : illisible ({e})")
                continue
            chemin.parent.mkdir(parents=True, exist_ok=True)
            chemin.write_bytes(data)
            info.update({"saison": f"{annee}/{annee + 1}", "division": div, "championnat": DIVISIONS[div],
                         "telecharge_le": aujourdhui.isoformat(), "saison_en_cours": annee == courante})
            inventaire["fichiers"][cle] = info
            telecharges += 1
            print(f"  {cle:9} {info['matchs']:4} matchs  {info['premier']} -> {info['dernier']}  "
                  f"tirs cadres {info['remplissage']['tirs_cadres']}  "
                  f"cloture Pinnacle {info['remplissage']['cloture_pinnacle_1x2']}  "
                  f"Betfair {info['remplissage']['cloture_betfair_1x2']}  xG {info['remplissage']['xg']}")

    inventaire.update({
        "_doc": "Inventaire des CSV football-data.co.uk importes par tools/import_football_data.py "
                "(fichiers bruts dans donnees/football-data/<saison>/<division>.csv). remplissage = part des "
                "matchs joues ou la colonne est renseignee (null = colonne absente cette saison).",
        "maj": aujourdhui.isoformat(),
        "divisions": DIVISIONS,
    })
    inventaire["fichiers"] = dict(sorted(inventaire["fichiers"].items()))
    DEST.mkdir(parents=True, exist_ok=True)
    inv_path.write_text(json.dumps(inventaire, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    total = sum(f["matchs"] for f in inventaire["fichiers"].values())
    print(f"{telecharges} telecharge(s), {gardes} deja presents ; {len(inventaire['fichiers'])} fichiers, "
          f"{total} matchs -> {DEST.relative_to(ROOT)}")
    for e in erreurs:
        print("  ERREUR", e)
    return 1 if erreurs else 0


if __name__ == "__main__":
    sys.exit(main())
