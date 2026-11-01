# Agent IA | Football Analyste

Site multi-pages d'analyse football, couple a une base PostgreSQL en temps reel et a un agent IA pour les pronostics.

**[Demo live](https://yantheo.github.io/agent-ia-rag-football-analyst/)**

---

## Apercu

Un agent IA utilisant l'architecture **RAG (Retrieval-Augmented Generation)** couple a une base **PostgreSQL** pour fournir des analyses football basees sur des donnees reelles, sans hallucination.

L'utilisateur choisit un match dans le calendrier du jour ; l'agent interroge directement la base de donnees pour construire son rapport d'analyse.

## Pages

| Page | Contenu |
|------|---------|
| **Calendrier** (`index.html`) | Matchs du jour par championnat, comparaison de stats, rapport d'analyse IA a la demande |
| **Bankroll** (`bankroll.html`) | Suivi personnel de paris : import d'un export bwin, saisie manuelle, stockage 100% local (rien n'est envoye nulle part) |
| **Meilleurs Paris** (`meilleurs-paris.html`) | Pre-filtre statistique (sans IA) des matchs du jour les plus desequilibres, puis analyse IA des meilleurs candidats, classes par indice de confiance |
| **Buteurs & Passeurs** (`buteurs-passeurs.html`) | Top 10 buteurs/passeurs bruts + classements par importance relative (part des buts de leur equipe) |

## Fonctionnalites

- **RAG SQL** : l'agent IA interroge directement PostgreSQL (pas de chat en texte libre — les equipes sont resolues via le calendrier, pas devinees par nom)
- **8 championnats europeens** : Ligue 1, La Liga, Premier League, Serie A, Bundesliga, Super Lig, Liga Portugal, Eredivisie
- **160+ equipes** analysees avec 35+ metriques par equipe
- **Analyse de matchs** : comparaison d'equipes avec metriques avancees (taux de victoire, efficacite offensive, profil defensif, forme recente)
- **Indicateurs proprietaires** : Draw Index, Indice de Finition, detection des pieges
- **Pre-filtre statistique** (page Meilleurs Paris) : score de desequilibre calcule localement avant de solliciter l'IA, pour ne pas gaspiller d'appels sur des matchs sans interet
- **Module Bankroll** local-first : aucune donnee personnelle de paris n'est envoyee a un service tiers

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Frontend | HTML/CSS/JS vanilla, multi-pages, sans build |
| Agent IA | n8n AI Agent + OpenAI |
| Base de donnees | PostgreSQL (Supabase), interrogee en direct par le frontend (lecture) et par l'agent (lecture/analyse) |
| Scraping | Python + Playwright |
| Hebergement demo | GitHub Pages |

## Architecture

```
Frontend (GitHub Pages)
    |
    |-- GET direct --------> Supabase REST (calendrier, classements_foot) [cle anon publique, lecture seule]
    |
    |-- POST (par match) --> Webhook n8n
                                  |
                                  v
                              AI Agent (n8n)
                                  |-- Requetes SQL --> PostgreSQL (Supabase)
                                  |-- LLM ----------> OpenAI
                                  v
                              Rapport HTML (verdict, Draw Index, confiance...)
```

Le module **Bankroll** ne communique avec aucun backend : tout est stocke dans le `localStorage` du navigateur.

## Donnees

Les donnees sont collectees automatiquement par des scrapers Python/Playwright et synchronisees vers Supabase :

- **Classements** : points, victoires, nuls, defaites, buts marques/encaisses
- **Stats detaillees** : forme recente, buteurs, passeurs, cartons
- **Profils tactiques** : categorisation offensive/defensive, fiabilite
- **Calendrier** : matchs du jour par championnat, mis a jour quotidiennement

---

Projet par [yantheo](https://github.com/yantheo)
