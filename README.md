# Agent IA | Football Analyste

Site multi-pages d'analyse football : un **modèle statistique** calcule les probabilités de chaque match,
un **agent IA** rédige l'analyse à partir de données réelles (PostgreSQL), sans inventer ni chiffres ni favori.

**[Demo live](https://yantheo.github.io/agent-ia-rag-football-analyst/)**

---

## Principe

*Les chiffres et les décisions viennent du code, l'IA ne fait que rédiger.*

1. Un modèle de prédiction (dans le navigateur) donne les probabilités victoire / nul / défaite, plus de 2,5 buts
   et « les deux équipes marquent ».
2. Le code lit le contexte des deux équipes (forme, bilan sur le lieu du match, attaque, défense, classement)
   et le classe en points pour / contre le favori, avec une étiquette **FAVORABLE / MITIGÉ / DÉFAVORABLE**.
3. Le conseil de pari découle des seules probabilités ; un contexte défavorable le rend plus prudent, jamais
   plus audacieux.
4. L'IA rédige le rapport à partir de ces éléments ; les lignes du verdict (pronostic, conseil, nul, buts) et
   les risques sont imposés par le code.

## Pages

| Page | Contenu |
|------|---------|
| **Calendrier** (`index.html`) | Matchs du jour par championnat, probabilités du modèle, comparaison de stats, analyse IA à la demande |
| **Championnats** (`championnats.html`) | Classement (général, domicile, extérieur) et top / flop 5 par championnat |
| **Équipes** (`equipe.html`) | Fiche d'équipe : niveau, forme, attaque, défense, style de jeu, joueurs clés, rang dans le championnat |
| **Confrontation** (`confrontation.html`) | Deux équipes au choix (toutes ligues) : probabilités, comparaison, analyse IA |
| **Meilleures / Pires équipes** | Classements toutes ligues sur 6 métriques + domicile / extérieur |
| **Buteurs & Passeurs** (`buteurs-passeurs.html`) | Classements bruts, par importance dans l'équipe, et par force de l'équipe |
| **Meilleurs Paris** (`meilleurs-paris.html`) | Pré-filtre statistique des matchs du jour les plus déséquilibrés, puis analyse IA des meilleurs candidats |
| **Bankroll** (`bankroll.html`) | Suivi personnel de paris (import bwin, saisie manuelle), 100 % local |

Outil de suivi (hors menu) : `comparaison.html` compare les versions du modèle au marché (cotes démargées)
et aux résultats réels (Brier, log-loss) sur des prédictions figées avant les matchs.

## Modèle de prédiction (`model.js`)

- **v1** : buts de la saison (Poisson), indices attaque / défense relatifs au championnat, lissage bayésien,
  correction de la force des ligues pour les matchs européens.
- **v2** : Elo des clubs (ClubElo) pour le rapport de force + buts de la saison pour le total de buts.
- **v3 (en production)** : moyenne 50/50 de v1 et v2 — les deux se trompent sur des cas différents.
- Versions figées (`version_modele`) et testées (`node model.tests.js`) ; jugées sur les matchs réels, pas sur
  un résultat isolé.

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Frontend | HTML/CSS/JS vanilla, multi-pages, sans build |
| Base de données | PostgreSQL (Supabase), lue en direct par le frontend (clé publique en lecture seule) |
| Agent IA | n8n + OpenAI (gpt-4.1-mini), un seul appel LLM par analyse |
| Scraping | Python + Playwright, chaque nuit |
| Hébergement | GitHub Pages |

## Architecture

```
Frontend (GitHub Pages)
    |
    |-- GET direct --> Supabase REST (calendrier, classements_foot)
    |-- modèle de prédiction calculé dans le navigateur (model.js)
    |
    |-- POST (match + probabilités du modèle) --> Webhook n8n
              |
              v
          Requête SQL fixe (stats des deux équipes)
              -> lecture du contexte (code : lecture-contexte.js)
              -> rédaction (OpenAI)
              -> verdict imposé par le code
              v
          Rapport HTML
```

Le module **Bankroll** ne communique avec aucun backend : tout est stocké dans le `localStorage` du navigateur.

## Données

- **10 championnats européens** : Ligue 1, Ligue 2, Liga, Premier League, Championship, Serie A, Bundesliga,
  Süper Lig, Liga Portugal, Eredivisie (~190 équipes).
- Classements (général, domicile, extérieur), buts, tirs cadrés, possession, passes, dribbles, forme récente,
  buteurs et passeurs, calendrier du jour.
- Elo des clubs : instantané ClubElo (`elo-clubs.json`) et correspondance des noms vérifiée à la main
  (`elo-mapping.json`).

## Développement local

```
python3 -m http.server 8000      # puis http://localhost:8000
node model.tests.js              # tests du modèle
node lecture-contexte.js         # tests de la lecture du contexte
```

---

Projet par [yantheo](https://github.com/yantheo)
