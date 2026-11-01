# CLAUDE.md

Ce fichier donne le contexte a Claude Code pour travailler sur ce repo.

## Vue d'ensemble

Frontend statique multi-pages (HTML/CSS/JS vanilla, pas de build, pas de framework) pour une app
d'analyse football. Deploye sur GitHub Pages depuis `main` (tout push sur `main` publie directement sur
https://yantheo.github.io/agent-ia-rag-football-analyst/). **Repo public** — ne jamais committer de
secrets ni de details d'infra privee (hostnames serveur, noms de conteneurs, identifiants), ni de
donnees personnelles (ex: historique de paris reel — voir `.gitignore`).

Pages actuelles :
- **`index.html`** — Calendrier du jour, comparaison stats, bouton "Analyser" un match.
- **`bankroll.html`** — Suivi de paris personnel (import bwin, saisie manuelle), 100% `localStorage`,
  aucune communication avec un backend.
- **`meilleurs-paris.html`** — Pre-filtre statistique local (gratuit) des matchs du jour, puis analyse
  IA des candidats les plus desequilibres, classes par indice de confiance.
- **`buteurs-passeurs.html`** — 4 classements (buteurs/passeurs bruts + par importance relative a
  l'equipe), calcules cote client depuis les donnees Supabase deja chargees.

Ce n'est **pas** un chat libre. Le calendrier (`index.html`) fonctionne ainsi :
1. Au chargement, le frontend requete directement Supabase (REST, cle anon en dur dans le JS — c'est
   voulu, c'est une cle publique en lecture seule) pour lister les matchs du jour (table `calendrier`).
2. L'utilisateur clique un match → affichage d'une comparaison stats (requete directe Supabase sur
   `classements_foot`, filtree par `team_id`).
3. Bouton "Analyser" → POST vers le webhook n8n avec le payload structure (voir plus bas) → affichage
   du rapport HTML genere par l'agent IA.

Les 3 autres pages reutilisent ce meme webhook et/ou les memes requetes Supabase REST — aucun nouveau
backend n'a ete introduit.

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

## Module Bankroll (bankroll.html)

Stockage `localStorage` uniquement (cle `bankroll_bets_v1`), aucun appel reseau pour ce module. Le
parseur d'import bwin est un portage JS de `parse_bwin.py` (fichier de reference, non commite — voir
`.gitignore`, il contient des donnees de test). **Piege deja rencontre** : le script Python utilise
`re.split(...)[1:]` qui genere toujours une premiere entree vide a retirer ; `String.prototype.split`
en JS avec un lookahead ne genere PAS cette entree vide si le texte commence directement par le motif.
Un `.shift()` copie tel quel depuis la logique Python supprimait donc le premier ticket importe à
chaque fois. Repere grace aux self-tests (`bankroll.html?debug=1`, assertions dans la console) — a
lancer apres toute modification du parseur.

## Page Meilleurs Paris (meilleurs-paris.html)

Pas de nouveau prompt ni de nouveau workflow n8n : reutilise tel quel le webhook `/webhook/football-analyze`
existant, match par match. La valeur ajoutee est un **pre-filtre statistique local** (gratuit, sans IA)
qui choisit quels matchs du jour envoyer a l'agent, plutot que les N premiers par ordre chronologique :

- Score de "force" par equipe = `taux_victoire` (poids principal, 0-100) + bonus ponderes sur
  `etat_fiabilite` / `profil_offensif` / `profil_defensif`, matches par mots-cles normalises (sans
  accents) car ces champs melangent deux generations de l'algorithme du scraper (ex: `"DOMINANCE"` vs
  `"DOMINANCE (Profil Équilibré)"`, `"EXCALIBUR"` vs `"ATTAQUE EXPLOSIVE"`) — voir fonctions
  `reliabilityRank` / `offensiveRank` / `defensiveRank` dans le fichier.
- Les matchs sont tries par ecart de score entre les deux equipes (plus l'ecart est grand, plus le
  match est juge desequilibre) ; seuls les `maxMatches` premiers de ce tri sont envoyes a l'IA.
- L'**indice de confiance** affiche vient du rapport IA lui-meme (deja present dans son prompt existant,
  `Faible / Moyen / Élevé`), extrait par regex sur le HTML retourne — pas une metrique inventee cote
  frontend.
- Resultats mis en cache en `localStorage` (cle `meilleurs_paris_cache_v1`) par date du jour, pour ne
  pas re-declencher des appels OpenAI a chaque visite.

## Page Buteurs & Passeurs (buteurs-passeurs.html)

Calcule 4 classements cote client a partir d'une seule requete Supabase sur `classements_foot`
(`meilleurs_buteurs`, `meilleurs_passeurs`, `buts_pour`). Chaque equipe stocke son top 3 buteurs/passeurs
sous forme `[{nom, stats}]` (`stats` = nombre de buts ou de passes). Pas de colonne "total de passes
decisives de l'equipe" en base : le classement "passeurs les plus importants" utilise donc `buts_pour`
(buts totaux de l'equipe) comme denominateur, pas un total de passes — logique car une passe decisive
contribue directement a un but, mais a garder en tete si ce tableau est etendu. Seuils minimums
(3 buts / 2 passes) pour eviter qu'un joueur avec 1 but sur une equipe qui n'en a marque qu'1 ressorte
a 100%.

## Historique git

L'historique de ce repo a ete force-push/reecrit a un moment (plusieurs versions du frontend ont
coexiste : un ancien widget `@n8n/chat` en chat libre, remplace par la version calendrier actuelle).
