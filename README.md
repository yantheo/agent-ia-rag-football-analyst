# Agent IA | Football Analyste

Agent conversationnel connecte a une base de donnees SQL en temps reel pour l'analyse football.

**[Demo live](https://yantheo.github.io/agent-ia-rag-football-analyst/)**

---

## Apercu

Un agent IA utilisant l'architecture **RAG (Retrieval-Augmented Generation)** couple a une base **PostgreSQL** pour fournir des analyses football basees sur des donnees reelles, sans hallucination.

L'utilisateur pose des questions en langage naturel et l'agent interroge directement la base de donnees pour construire ses reponses.

## Fonctionnalites

- **RAG SQL** : Interrogation directe de PostgreSQL via un agent IA
- **8 championnats europeens** : Ligue 1, La Liga, Premier League, Serie A, Bundesliga, Super Lig, Liga Portugal, Eredivisie
- **160+ equipes** analysees avec 35+ metriques par equipe
- **Analyse de matchs** : Comparaison d'equipes avec metriques avancees (taux de victoire, efficacite offensive, profil defensif, forme recente)
- **Indicateurs proprietaires** : Draw Index, Indice de Finition, detection des pieges
- **Limite de session** : 10 messages par session navigateur

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Agent IA | n8n AI Agent + OpenAI |
| Base de donnees | PostgreSQL (Supabase) |
| Scraping | Python + Playwright |
| Chat frontend | @n8n/chat |
| Tunnel | ngrok |
| Hebergement demo | GitHub Pages |

## Architecture

```
Utilisateur
    |
    v
Chat Frontend (n8n/chat)
    |
    v
Webhook n8n (via ngrok)
    |
    v
AI Agent (n8n)
    |-- Requetes SQL --> PostgreSQL (Supabase)
    |-- LLM ----------> OpenAI
    |
    v
Reponse en langage naturel
```

## Exemples de questions

- "Analyse PSG vs Marseille"
- "Top 5 Ligue 1"
- "Statistiques Real Madrid"
- "Quelle equipe a le meilleur ratio buts/matchs en Bundesliga ?"
- "Compare Arsenal et Liverpool sur les 5 derniers matchs"

## Donnees

Les donnees sont collectees automatiquement par des scrapers Python/Playwright et synchronisees vers Supabase :

- **Classements** : Points, victoires, nuls, defaites, buts marques/encaisses
- **Stats detaillees** : Forme recente, buteurs, passeurs, cartons
- **Profils tactiques** : Categorisation offensive/defensive, fiabilite

---

Projet par [yantheo](https://github.com/yantheo)
