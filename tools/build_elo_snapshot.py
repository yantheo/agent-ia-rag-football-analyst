#!/usr/bin/env python3
"""
Construit elo-clubs.json (Elo de chaque equipe suivie) a partir de ClubElo.

Pourquoi un instantane versionne plutot qu'un appel direct depuis le site :
l'API ClubElo (api.clubelo.com) n'existe qu'en HTTP. Depuis GitHub Pages (HTTPS),
le navigateur bloque la requete (contenu mixte), CORS ou pas. Solution cible :
un scraper backend qui alimente une table Supabase ; en attendant, ce script.

Source utilisee : la page d'accueil http://clubelo.com/ (l'API etait en panne,
erreur 502, le 2026-11-03). Elle contient, par pays :
  "<Pays> | Club | Elo" puis "Level N (M teams) ⌀<Elo moyen>" puis les clubs.
Limite connue : la page d'accueil ne liste pas toutes les equipes de chaque
championnat (ex : Liga Portugal, 15 clubs listes sur 18). Les equipes absentes
sont null dans elo-mapping.json et recoivent l'Elo moyen de leur championnat
(prediction marquee "degradee").

Usage (stdlib uniquement) :
  python3 tools/build_elo_snapshot.py                      # telecharge clubelo.com
  python3 tools/build_elo_snapshot.py page_clubelo.html    # depuis un fichier
"""
import datetime
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_page(arg):
    if arg:
        return Path(arg).read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request("http://clubelo.com/", headers={"User-Agent": "football-analyst-snapshot"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def parse(page):
    txt = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " | ", page)))
    txt = re.sub(r"(\| )+", "| ", txt)
    date = re.search(r"(\d{4}-\d{2}-\d{2}) \| Fixtures", txt)
    parts = re.split(r"\| ([A-Z][A-Za-zÀ-ÿ'\.\- ]+?) \| Club \| Elo \|", txt)
    clubs, leagues = {}, {}
    for i in range(1, len(parts), 2):
        country, body, level = parts[i].strip(), parts[i + 1], None
        for tok in re.finditer(
            r"Level (\d) \((\d+) teams\) \| ⌀(\d+)|\| Lower \||"
            r"\| ([A-Z0-9ÁÉÍÓÚÄÖÜ\.]{2,4}) \| ([^|]{2,40}?) \| (\d{3,4})p? \|", body):
            if tok.group(1):
                level = int(tok.group(1))
                leagues[f"{country}|{level}"] = int(tok.group(3))
            elif tok.group(0).startswith("| Lower"):
                level = 9
            elif tok.group(5):
                clubs.setdefault(tok.group(5).strip(), {"country": country, "level": level, "elo": int(tok.group(6))})
    return (date.group(1) if date else None), clubs, leagues


def main():
    date, clubs, leagues = parse(load_page(sys.argv[1] if len(sys.argv) > 1 else None))
    mapping = json.loads((ROOT / "elo-mapping.json").read_text(encoding="utf-8"))

    league_avg = {}
    for champ, (country, level) in mapping["championnats"].items():
        key = f"{country}|{level}"
        if key not in leagues:
            sys.exit(f"Moyenne ClubElo introuvable pour {champ} ({key}) : la page a change ?")
        league_avg[champ] = leagues[key]

    teams, missing_in_page = {}, []
    for team_id, name in mapping["equipes"].items():
        if name is None:
            continue
        if name not in clubs:
            missing_in_page.append((team_id, name))
            continue
        elo = clubs[name]["elo"]
        # Garde-fou (2026-11-07) : le snapshot du 2026-11-03 contenait Lorient 157, Atalanta 210,
        # Benfica 554... (erreur de lecture de la page), sans aucune erreur. Un Elo de club est
        # entre ~1300 et ~2100 : hors 1000-2500, on refuse d'ecrire le fichier.
        if not 1000 < elo < 2500:
            sys.exit(f"Elo impossible pour {team_id} ({name}) : {elo} -> la lecture de la page ClubElo est fausse")
        teams[team_id] = {"clubelo": name, "elo": elo}

    if missing_in_page:
        # Un nom present dans le mapping mais absent de la page : ne pas produire un
        # fichier silencieusement incomplet.
        sys.exit(f"Equipes du mapping absentes de la page ClubElo : {missing_in_page}")

    out = {
        "_doc": "Genere par tools/build_elo_snapshot.py - ne pas editer a la main.",
        "source": "http://clubelo.com/ (page d'accueil)",
        "date_classement_clubelo": date,
        "genere_le": datetime.date.today().isoformat(),
        "moyennes_championnats": league_avg,
        "equipes": teams,
        "equipes_sans_elo": sorted(k for k, v in mapping["equipes"].items() if v is None),
    }
    (ROOT / "elo-clubs.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"elo-clubs.json : {len(teams)} equipes avec Elo, {len(out['equipes_sans_elo'])} sans Elo, "
          f"classement ClubElo du {date}")


if __name__ == "__main__":
    main()
