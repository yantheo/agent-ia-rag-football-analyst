# CLAUDE.md

Ce fichier donne le contexte a Claude Code pour travailler sur ce repo.

## Vue d'ensemble

Frontend statique (un seul fichier `index.html`, pas de build) pour une demo d'agent IA RAG football.
Deploye sur GitHub Pages depuis `main` (tout push sur `main` publie directement sur
https://yantheo.github.io/agent-ia-rag-football-analyst/). **Repo public** — ne jamais committer de
secrets ni de details d'infra privee (hostnames serveur, noms de conteneurs, identifiants).

Ce n'est **pas** un chat libre. C'est une app calendrier :
1. Au chargement, le frontend requete directement Supabase (REST, cle anon en dur dans le JS — c'est
   voulu, c'est une cle publique en lecture seule) pour lister les matchs du jour (table `calendrier`).
2. L'utilisateur clique un match → affichage d'une comparaison stats (requete directe Supabase sur
   `classements_foot`, filtree par `team_id`).
3. Bouton "Analyser" → POST vers le webhook n8n avec le payload structure (voir plus bas) → affichage
   du rapport HTML genere par l'agent IA.

## Stack / Architecture

```
index.html (GitHub Pages)
    |-- GET direct --> Supabase REST (calendrier, classements_foot) [cle anon publique]
    |-- POST --------> Webhook n8n --> AI Agent (OpenAI) --> PostgreSQL Tool --> Supabase
```

Le **vrai backend** (n8n + scrapers Python qui remplissent Supabase) vit dans un **repo separe et
prive au niveau infra** : `yantheo/Setup-Claude-n8n-automation`. Son `CLAUDE.md` documente le schema
Supabase reel, le contrat du webhook cote n8n, les details d'acces serveur, et comment diagnostiquer
les executions qui echouent. **Toujours consulter ce fichier en priorite si le webhook ne repond pas.**
Les details d'infra (hostname serveur, identifiants, noms de conteneurs) sont dans le `.env` local
(jamais commite) et dans la documentation du repo backend — pas ici, ce repo etant public.

## Webhook n8n — contrat (cote frontend)

```js
const N8N_WEBHOOK_URL = 'https://n8n.scribify.net/webhook/football-analyze';

const payload = {
  match_id, equipe_domicile, equipe_exterieur,
  team_id_domicile, team_id_exterieur, championnat, date_match,
};
// POST JSON, reponse attendue : { "output": "<html>...</html>" }
```

Le `team_id` vient directement de la table `calendrier` Supabase (deja resolu, pas d'ambiguite de nom
d'equipe a gerer cote frontend — ne pas reintroduire un systeme de chat texte libre qui demanderait au
backend de deviner les equipes par nom, ca a deja ete essaye et c'est une mauvaise idee).

## Incident connu (resolu le 2026-11-01)

Le webhook renvoyait une reponse HTTP 200 avec un corps vide. Deux causes cumulees :
1. Credits OpenAI epuises (le node AI Agent plantait silencieusement, le node "Respond to Webhook"
   n'etait jamais atteint).
2. Une ancienne version du frontend utilisait une URL de webhook orpheline (UUID d'un vieux workflow
   supprime). La version actuelle utilise `/webhook/football-analyze`, deja a jour.

Si le webhook redevient silencieux, verifier dans l'ordre : credits OpenAI (platform.openai.com/settings/
organization/billing), workflow actif dans n8n, puis les executions recentes (voir repo backend pour les
commandes de diagnostic — necessite acces serveur).

## Historique git

L'historique de ce repo a ete force-push/reecrit a un moment (plusieurs versions du frontend ont
coexiste : un ancien widget `@n8n/chat` en chat libre, remplace par la version calendrier actuelle).
