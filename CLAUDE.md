# CLAUDE.md

Ce fichier donne le contexte a Claude Code pour travailler sur ce repo.

## Vue d'ensemble

Frontend statique multi-pages (HTML/CSS/JS vanilla, pas de build, pas de framework) pour une app
d'analyse football. Deploye sur GitHub Pages depuis `main` (tout push sur `main` publie directement sur
https://yantheo.github.io/agent-ia-rag-football-analyst/). **Repo public** — ne jamais committer de
secrets ni de details d'infra privee (hostnames serveur, noms de conteneurs, identifiants), ni de
donnees personnelles (ex: historique de paris reel — voir `.gitignore`).

Pages actuelles :
- **`index.html`** — Calendrier du jour, comparaison stats, bouton "Analyser" un match. Vue match : bloc
  « Probabilités du modèle » (`Modele.v3`, meme rendu que `confrontation.html`, `renderModelBox`).
- **`bankroll.html`** — Suivi de paris personnel (import bwin, saisie manuelle), 100% `localStorage`,
  aucune communication avec un backend.
- **`meilleurs-paris.html`** — Pre-filtre statistique local (gratuit) des matchs du jour, puis analyse
  IA des candidats les plus desequilibres, classes par indice de confiance.
- **`championnats.html`** — Menu lateral des championnats scrapes, classement du championnat choisi +
  top/flop 5 par championnat (forme, attaque, defense, efficacite, possession, points vs attendus).
- **`meilleures-equipes.html`** / **`pires-equipes.html`** — Classements toutes ligues confondues sur les
  memes 6 metriques + domicile / exterieur (pires = meme calcul, tri inverse). Top 20 (`TOP_N`). Menu
  lateral a gauche (meme style que `championnats.html`), **genere depuis les `.table-block` du HTML**
  (titre = `<h3>`, cle = id du `<tbody>` sans `tbl-`) : un seul tableau affiche a la fois, choix dans le
  hash (`meilleures-equipes.html#domicile`). Ajouter un tableau dans le HTML suffit pour qu'il apparaisse
  dans le menu.
- **`buteurs-passeurs.html`** — 6 classements (buteurs/passeurs bruts, par importance relative a
  l'equipe, equipes dominantes), calcules cote client depuis les donnees Supabase. Meme menu lateral
  que `championnats.html` : "Tous les championnats" par defaut (20 joueurs par tableau), ou un seul
  championnat (10 joueurs — `TOP_N_ALL` / `TOP_N_LEAGUE`), filtre cote client sans nouvelle requete.

- **`equipe.html?team=<team_id>`** — Fiche d'une equipe (menu « Équipes », apres Championnats ; sans `?team=`, liste de toutes les equipes par championnat) : niveau et
  forme decoupes en palier + nuances, classement (dont domicile / exterieur), forme, attaque, defense, jeu,
  joueurs cles, avec le **rang dans le championnat** sur chaque stat chiffree ; menu deroulant de toutes les
  equipes. Chaque nom d'equipe est un lien vers cette page (`teamLink()` + CSS `a.team-link`, duplique
  dans championnats, meilleures / pires equipes, buteurs-passeurs et l'en-tete de la comparaison d'index).

- **`confrontation.html?dom=<team_id>&ext=<team_id>`** (menu « Confrontation », apres Équipes, ajout du
  2026-11-05) — deux equipes au choix (toutes ligues), sans passer par le calendrier : probabilites
  `Modele.v3` (mention si championnats differents), meme comparaison qu'index (`buildComparisonHTML`
  copiee), bouton « Analyser » -> meme webhook n8n (`match_id: null`, championnat = « A / B (confrontation
  hors championnat) » si ligues differentes). Analyses en cache `localStorage` (`confrontation_analyses_v1`,
  par jour + affiche, bouton « Relancer »). Limite : l'IA ne corrige pas la force des ligues (niveau
  relatif a chaque championnat) — sur une affiche inter-ligues, le modele est plus fiable que le verdict IA.
  Charge `model.js?v=` : a mettre a jour avec `comparaison.html` et `meilleurs-paris.html`.

**Header/navigation dupliques dans chaque page** (pas de build, pas d'include) : ajouter une page ou
modifier le menu implique de modifier le `<nav class="nav-links">` et le CSS `.header-content` de
toutes les pages. Le menu est centre sous le logo (`flex-direction: column`).

Ce n'est **pas** un chat libre. Le calendrier (`index.html`) fonctionne ainsi :
1. Au chargement, le frontend requete directement Supabase (REST, cle anon en dur dans le JS — c'est
   voulu, c'est une cle publique en lecture seule) pour lister les matchs du jour (table `calendrier`).
2. L'utilisateur clique un match → affichage d'une comparaison stats (requete directe Supabase sur
   `classements_foot`, filtree par `team_id`).
3. Bouton "Analyser" → POST vers le webhook n8n avec le payload structure (voir plus bas) → affichage
   du rapport HTML genere par l'agent IA.

Les autres pages reutilisent ce meme webhook et/ou les memes requetes Supabase REST — aucun nouveau
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

**Piege n°2 (corrige le 2026-11-01)** : `bwinDateToISO` lisait les dates au format `D/M/YY`
(commentaire d'origine), alors que bwin utilise en realite le format americain `M/D/YY`. Comme pour le
piege n°1, aucune erreur n'etait levee — le format etait juste mal devine, et le resultat avait l'air
correct. Mesure sur un export reel de 100 tickets : 76% des dates donnaient une chaine ISO invalide
(mois > 12, ex. `2026-31-10`), et les 24% restants etaient silencieusement faux mais plausibles
(`10/12/26` = 12 octobre, stocke comme `2026-12-10` = 10 decembre). **Le self-test lui-meme validait le
bug** (`paris[0].date === '2026-02-09'` au lieu de `'2026-09-02'`) — a verifier systematiquement qu'un
self-test teste le bon comportement, pas juste "ce que le code produit actuellement".
Pas de migration automatique des paris deja stockes : seules les dates avec mois > 12 sont detectables
apres coup, les ~24% silencieusement plausibles sont indiscernables une fois converties en ISO (le
format brut bwin n'est plus disponible). Une migration partielle donnerait une fausse confiance que tout
est corrige — un avertissement conditionnel (`#date-fix-notice`, affiche si un pari avec `betslipId`
existe et que `bankroll_date_fix_ack` n'est pas pose) invite a tout effacer et reimporter a la place.

## Page Meilleurs Paris (meilleurs-paris.html)

Pas de nouveau prompt ni de nouveau workflow n8n : reutilise tel quel le webhook `/webhook/football-analyze`
existant, match par match. La valeur ajoutee est un **pre-filtre statistique local** (gratuit, sans IA)
qui choisit quels matchs du jour envoyer a l'agent, plutot que les N premiers par ordre chronologique :

- **Modele de buts attendus (Poisson)**, pas un score composite de labels qualitatifs : pour chaque
  equipe, `attackIndex` = buts marques/match rapportes a la moyenne de SON championnat (1.0 = dans la
  moyenne), `defenseIndex` = buts encaisses/match, meme logique. Buts attendus d'un match = moyenne du
  championnat x attackIndex x defenseIndex adverse (+ leger bonus domicile 1.08 / malus exterieur 0.94).
  P(victoire domicile/nul/victoire exterieur) calculee par sommation de Poisson sur chaque score possible
  (tronque a 8 buts). Voir `computeLeagueAverages` / `buildTeamIndices` / `matchProbabilities`.
- **Shrinkage bayesien** : les moyennes de buts sont tirees vers la moyenne du championnat avec un poids
  de `SHRINK_K = 6` matchs-equivalents, pour qu'une equipe a 2-3 matchs joues ne paraisse pas
  artificiellement extreme. Les anciens labels qualitatifs (`etat_fiabilite`, `profil_offensif`,
  `profil_defensif`) ne sont PLUS utilises ici : ils sont deja derives de ces memes stats par le scraper,
  les reutiliser en plus aurait compte le meme signal deux fois.
- Les matchs sont tries par probabilite du favori (`max(pHome, pDraw, pAway)`) decroissante ; seuls les
  `maxMatches` premiers de ce tri sont envoyes a l'IA.
- L'**indice de confiance** affiche vient du rapport IA lui-meme (deja present dans son prompt existant,
  `Faible / Moyen / Élevé`), extrait par regex sur le HTML retourne — **non calibre** : rien dans
  l'architecture actuelle (pas de table de resultats reels en base, pas d'acces en ecriture Supabase
  depuis le frontend) ne permet de verifier que "Élevé" correspond a un vrai taux de reussite superieur.
  Mention explicite de cette limite dans l'UI. Pour vraiment calibrer, il faudrait un scraper de
  resultats + une table dediee + un acces en ecriture — evolution backend, pas frontend.
- **REMPLACE le soir meme par le modele v2 (voir section "Modele de prediction v2")** : la page utilise
  desormais `Modele.v2` (Elo des clubs) ; l'etiquette "inter-ligues" est devenue "Champions League"
  (ou "Coupe d'Europe"), et "Elo approximatif" signale une equipe sans Elo ClubElo. Le paragraphe
  ci-dessous decrit la correction v1, conservee dans `Modele.v1` comme reference.
- **v3 EN PRODUCTION depuis le 2026-11-05** (voir « Piste v3 ») : la page utilise `Modele.v3` (moyenne
  50/50 v1/v2, `moy-v1v2-w50`). Repli explicite sur la v2 si la v1 est incalculable (equipe sans stats de
  saison) : badge « v2 seule ». Seuils des badges (60 % / 45 %) gardes tels quels, a revoir avec les
  donnees (la moyenne resserre un peu les probabilites).
- **Matchs inter-ligues (ajout du 2026-11-03, v1)** : les indices etant relatifs a CHAQUE championnat, le
  modele supposait qu'une equipe moyenne de Liga vaut une equipe moyenne de Premier League ou de Super
  Lig (Barcelone - Aston Villa donne a 83 %). Entre deux championnats differents, les buts attendus sont
  multiplies / divises par `exp(ELO_GOAL_K x ecart)`, ou ecart = difference d'Elo moyen des deux ligues
  (table `LEAGUE_ELO`, source ClubElo, classement du 2026-11-02, a rafraichir de temps en temps).
  `ELO_GOAL_K = 0.00225` calibre pour que deux equipes moyennes de leur ligue donnent la meme esperance
  de resultat que la formule Elo `1/(1+10^(-ecart/400))` (100 pts = x1,25 sur les buts). Matchs internes a
  un championnat : inchanges. Effet le 2026-11-03 : Barcelone - Aston Villa 83 % -> 73 %, Man United -
  Rome 65 % -> 49 % (Rome), Galatasaray - Stuttgart 62 % (Galatasaray) -> 41 % (Stuttgart). Mention
  "inter-ligues" sur la carte. Limite : la Ligue des Champions a son propre contexte (rotation, enjeu)
  que le modele ignore.
- **Badge** : nom du favori devant le pourcentage ("Rome 49%") et les 3 issues au survol — avant, "65%"
  ne disait pas a quelle equipe il correspondait.
- **Cache** : au chargement, le modele est recalcule sur les resultats en cache (`refreshModel`, sans
  appel IA) : un changement de modele s'applique aux analyses deja faites sans consommer de credits.
- Resultats mis en cache en `localStorage` (cle `meilleurs_paris_cache_v1`) par date du jour, pour ne
  pas re-declencher des appels OpenAI a chaque visite.

## Page Buteurs & Passeurs (buteurs-passeurs.html)

Calcule 6 classements cote client a partir d'une seule requete Supabase sur `classements_foot`
(`meilleurs_buteurs`, `meilleurs_passeurs`, `buts_pour`, `buts_contre`, `matchs_joues`,
`forme_recente_championnat`). Chaque equipe stocke son top 3 buteurs/passeurs sous forme `[{nom, stats}]`
(`stats` = nombre de buts ou de passes).

- **Top brut** (buteurs/passeurs) et **par importance** (% des buts de l'equipe, min. 3 buts / 2 passes) :
  inchange. Pas de colonne "total de passes decisives de l'equipe" en base, donc le tableau "passeurs les
  plus importants" utilise `buts_pour` comme denominateur (une passe decisive contribue directement a un
  but). **Non ajuste au temps de jeu** (donnee absente de la base) — mentionne explicitement dans l'UI,
  un joueur avec peu de matchs peut ressortir artificiellement haut.
- **Equipes dominantes** (buteurs + passeurs, meme principe x2) : meme modele de buts attendus que
  `meilleurs-paris.html` (voir cette section) — `attackIndex` / `defenseIndex` par rapport a la moyenne
  du championnat, shrinkage bayesien (`SHRINK_K = 6`). Le score de force d'une equipe est
  `(attackIndex - defenseIndex) + 0.5 x formRecencyScore`, ou `formRecencyScore` pondere les 5 derniers
  resultats par recence (le plus recent pese le plus, poids `[5,4,3,2,1]`) plutot qu'une simple somme
  plate V/N/D. Un seul joueur par equipe (son meilleur buteur/passeur), classe par ce score d'equipe
  decroissant — pas par buts/passes bruts.
- Les anciens labels qualitatifs (`etat_fiabilite`, `profil_offensif`, `profil_defensif`,
  `taux_victoire`) ne sont plus utilises dans le score : ils sont derives des memes stats brutes par le
  scraper, les reutiliser aurait compte deux fois le meme signal.

## Page Championnats (championnats.html)

Une seule requete `classements_foot`, regroupee par `championnat` cote client. Le menu lateral (fixe en
`position: sticky`, barre horizontale scrollable sous 860px) est genere depuis les donnees : aucun nom
de championnat en dur. Meme filtre de fraicheur que les autres pages (`updated_at` < 3 jours, pour
exclure les lignes orphelines d'une saison precedente). Le championnat choisi est dans le hash de l'URL
(`championnats.html#Serie%20A`), partageable.

- **Classement : `position` et `points` repris tels quels de la source, PAS recalcules.** Verifie le
  2026-11-02 : un recalcul `3V + N` / tri points > diff > BP aurait ete faux dans deux cas reels —
  Southampton (Championship) a une penalite de points (23 en base vs 27 par 3V+N), et la Liga Portugal
  departage par confrontations directes (4 equipes mal placees par un tri diff de buts). Seule la
  difference de buts (`buts_pour - buts_contre`) est calculee cote client — pas besoin de colonne
  backend pour ca.
- **12 tableaux top/flop 5** generes depuis une liste de definitions (`buildMetrics`) : memes formules
  que Meilleures/Pires Equipes (min. 5 matchs joues, `SHRINK_K = 6`, moyennes du championnat ponderees
  par matchs joues), restreintes au championnat selectionne. Pour ajouter une metrique, ajouter une
  entree a cette liste.
- **Difference volontaire** : l'ecart "points reels vs attendus" (expectation pythagoricienne, exposant
  1.3) est affiche en **vrais points** ici, alors que `meilleures-equipes.html` l'affiche en points de %
  du maximum. Ici il est affiche a cote de "Pts / att." et les equipes d'un meme championnat ont
  quasiment le meme nombre de matchs, donc les vrais points sont comparables et lisibles.

## Niveau d'equipe (colonne `etat_fiabilite`, affichee « Niveau » dans index.html) — 2026-11-05

Calcule par le scraper backend (`niveaux_championnat`, voir le CLAUDE.md du repo backend) : palier =
rang dans le championnat selon les points par match lisses (Tête de championnat / Haut de tableau /
Milieu de tableau / Bas de tableau / Zone rouge) + nuances factuelles (invaincue, rarement / souvent
battue, beaucoup de nuls, résultats au-dessus / en dessous de ses stats). Remplace les anciens libelles
(DOMINANCE / « Profil Instable / Ne tient pas le score »...). Colonne non renommee en base. Le modele
v1/v2/v3 ne l'utilise pas. Prompt n8n correspondant : v7 (`prompts-n8n/`, local), deploye le 2026-11-05.
**Points reels vs attendus** (« Surperforment / Malchanceuses » de `championnats.html`, « Performance vs
attendu » / « Equipes malchanceuses » de `meilleures-equipes.html` / `pires-equipes.html`) alignes le
meme jour sur le backend : points reels = 3V+N (hors penalites), attendus = part pythagoricienne x 2 x
ppm moyen du championnat x J. Piege : `part x 3 x J` ignore les nuls (ecart moyen -1,06 pt, presque toutes
les equipes « malchanceuses », championnats a beaucoup de nuls penalises dans les classements toutes
ligues).

**Forme (colonne `forme_championnat`, affichee « Forme »)** — meme refonte le 2026-11-05 cote backend
(`analyser_forme_actuelle`) : « Excellente forme / Bonne forme / Forme moyenne / Méforme / En crise (X pts
sur 15) » + nuances (series, invaincue / sans victoire, en regain de forme / en perte de vitesse, en dents
de scie, beaucoup de nuls). Prompt n8n v8. Rien a changer cote frontend (affichage tel quel).

## Classements domicile / exterieur (ajout du 2026-11-03)

- **Source** : classements domicile et exterieur publies par footmercato (vue
  `<classement>?partial=1&type=home|away`), scrapes par `scraper_league_team.py` dans deux colonnes
  jsonb `classement_domicile` / `classement_exterieur` = `{position, pts, j, v, n, d, bp, bc}`.
  Verifie : `points_domicile + points_exterieur = points` pour 191/192 equipes (exception :
  Southampton, penalite de points).
- **`championnats.html`** : 4 tableaux (5 meilleurs / 5 pires a domicile et a l'exterieur), colonnes
  J, V, N, D, buts, Pts, Pts/m. **`meilleures-equipes.html` / `pires-equipes.html`** : top 10 domicile et
  exterieur toutes ligues confondues (`#split-tables`, grille de 2).
- **Tri** : points par match lisses (`(pts + SHRINK_K x moy) / (j + SHRINK_K)`) vers la moyenne du MEME
  cote dans le championnat, car le nombre de matchs a domicile varie d'une equipe a l'autre (4 ou 5 en
  debut de saison). Pages equipes : rapporte a cette moyenne (indice, 1.00x = moyenne de sa ligue).
- **Repli `supabaseGetSplit`** : si Supabase refuse ces colonnes (400 avant migration), la page recharge
  sans elles et les tableaux affichent "Pas encore de donnees". Ordre de deploiement : `ALTER TABLE` ->
  backend (pull + restart + scrape) -> frontend, mais le repli evite de casser les pages en cas de
  decalage.

## Modeles de prediction v1 / v2 (references) et v3 (en production depuis le 2026-11-05)

Valide le 2026-11-03 apres comparaison sur les 18 matchs du jour : Man United - Roma, cotes 2,00 / 4,20 /
2,90 demargees en puissance = 47 / 21 / 32 % ; v2 = 46 / 23 / 32 %, v1 = 28 / 23 / 49 % (Roma favorite a
tort). Un match n'est pas une preuve : la vraie validation passe par les matchs logges (voir plus bas).

**Architecture.** Le modele vit dans `model.js` (objet global `Modele`, aussi chargeable sous Node).
**Seules v1 et v2 sont des modeles de reference.** `Modele.v1` = modele historique (`v1-poisson-k6`),
deplace a l'identique depuis `meilleurs-paris.html` (ecart 0 verifie), **conserve comme reference : ne pas
le modifier**. `Modele.v2` = `v2-elo-k13` (production du 2026-11-03 au 2026-11-05, reference).
**`Modele.v3` = EN PRODUCTION (Meilleurs Paris) depuis le 2026-11-05** : moyenne v1/v2 (`Modele.moyenneV1V2`,
`moy-v1v2-w50`), meme interface et memes metadonnees que la v2 (`prepare` / `matchProbabilities` /
`eloCoverage`), repli explicite sur la v2 (`v3Repli: true`, `version = v2-elo-k13`) si la v1 est
incalculable. `comparaison.html` affiche v1, v2 et v3 (meme calcul que la prod) pour continuer a tester.
`Modele.marche.demarginer([c1, cN, c2])` = probabilites du marche, marge retiree par la methode de la
puissance. `comparaison.html` = outil de diagnostic v1 / v2 / moyenne v1-v2 + marche (hors menu, non lie ;
classements du pre-filtre v1/v2 et v2/v3 cote a cote ; dans la page, « v3 » = moyenne v1/v2) : saisie des cotes 1/N/2 par match (`localStorage`, cle
`comparaison_cotes_v1`, par date + team_id), ecart max au marche en points (en or si >= 10), resume
"meme favori que le marche", export CSV pour journaliser (cotes, scores, marche, v1, v2, moyenne, versions).
**Resultats** (section de `comparaison.html`) : saisie du score final par match (`localStorage`, cle
`comparaison_scores_v1`), P(issue reelle) par modele, bilan Brier / log-loss / favoris pour v1, v2, v3 (et
le marche sur les matchs avec cotes), Europe vs championnats. **Le bilan utilise les predictions figees
avant le match** : d'abord `predictions-figees.json` (versionne, cle `date|team_id_dom|team_id_ext`,
`p1`/`p2`/`pm`), sinon le gel automatique du navigateur (`comparaison_figees_v1`, fait quand la page est
ouverte avant le coup d'envoi), sinon recalcul marque « recalculees » (biaise : apres le scrape de nuit,
les stats incluent le match). Ne jamais modifier une valeur deja figee ; ajouter les nouvelles soirees au
fichier (meme format) avant les matchs.
**Mon prono** (meme section) : probabilites 1/N/2 de l'utilisateur en %, normalisees, `localStorage`
`comparaison_prono_v1` = `{p, saisi_le}`. Compte dans le bilan comme un modele seulement si `saisi_le` est
avant `date_match` (sinon « apres coup », exclu) ; verrouille en lecture seule une fois le match commence.
But : mesurer si l'intuition « dynamique / forme » de l'utilisateur apporte quelque chose aux modeles.
`node model.tests.js` = tests chiffres (valeurs attendues calculees independamment, tolerance 0,005).
**Cache** : GitHub Pages sert `model.js` avec `max-age=600`. Les pages le chargent en
`model.js?v=<date>` : **a chaque modification de `model.js`, changer ce `?v=` dans `comparaison.html` et
`meilleurs-paris.html`**, sinon un navigateur garde l'ancien `model.js` avec la nouvelle page (vu le
2026-11-04 : `Cannot read properties of undefined (reading 'combiner')`, tableau vide).

**Formules v2 (figees).** `dE = eloDom + advDomLigue - eloExt` (avantage du terrain +65 Elo, par
championnat, jamais par equipe) ; `s = exp(2·k·dE)`, k = 0.00225 ; `T = mL·(attDom·defExt + attExt·defDom)`
(indices lisses K=13, **aucun** facteur 1,08/0,94) ; `λdom = T·s/(1+s)`, `λext = T/(1+s)`, plancher 0,25.
Pieges : `exp(k·dE)` ou `exp(k·dE/2)` = pente 2x trop faible ; remettre 1,08/0,94 dans T = double comptage
de l'avantage du terrain ; reintroduire la correction par Elo moyen de ligue = double comptage (l'Elo des
clubs est deja sur une echelle commune). Consequence assumee : en v2, **le 1X2 vient presque entierement
de l'Elo** (l'esperance P(1)+½P(N) reproduit `1/(1+10^(-dE/400))` a ±0,01) ; les stats de saison
n'agissent que sur T (Over/Under). Sur le 1X2, v2 ne battra donc pas les bookmakers (memes donnees
publiques) ; l'avantage eventuel est sur les marches de buts.

**`version_modele`** : chaque version est figee. Toute modification d'une formule ou d'une constante
= nouvelle valeur (`v1-poisson-k6`, `v2-elo-k13`, `v2-elo-k13-tirs`...), sinon un log melangeant
plusieurs versions est inexploitable pour une comparaison appariee.

**Elo des clubs — le piege du mapping des noms.** `elo-mapping.json` (team_id -> nom ClubElo, releve a
la main) + `elo-clubs.json` (instantane genere par `tools/build_elo_snapshot.py`). Le rapprochement
automatique des noms donnait **Inter Milan -> "Milan" et PSG -> "Paris FC"** : des Elo credibles mais
faux, sans aucune erreur (meme famille que les bugs bwin). D'ou : table explicite versionnee, controle
qu'aucun club ClubElo n'est attribue deux fois, fallback explicite (Elo moyen du championnat + prediction
`eloDegrade`) et compteur console des equipes sans Elo. Toute nouvelle equipe (promue, adversaire de
Coupe d'Europe en `-eu`) doit etre ajoutee au mapping. L'API ClubElo n'existe qu'en HTTP : inutilisable
depuis GitHub Pages (contenu mixte) -> cible = scraper backend + table Supabase ; l'instantane date du
2026-11-02 et 11 equipes absentes de la page d'accueil ClubElo sont en Elo degrade.

**Ecartes volontairement (ne pas reintroduire sans test)** : la forme des 5 derniers matchs comme
facteur (deja dans les totaux et dans l'Elo, sur-ajustement mesure), Dixon-Coles (le double Poisson donne
deja 25 % de nuls a T=2,8, dans la fourchette europeenne 24-26 % ; a reconsiderer si les nuls observes
passent sous 23 %), l'avantage du terrain par equipe (trop bruite sur une demi-saison), possession et
precision des passes (marqueurs de style, pouvoir predictif residuel quasi nul).

**Point ouvert : K_LISSAGE = 13.** Valeur imposee par la specification. Estimation empirique sur nos
192 equipes au 2026-11-03 (variance observee des taux de buts - variance Poisson attendue) : mediane
~7,5, de 3 (Liga) a 37 (Ligue 2) — estimation elle-meme bruitee (18-24 equipes par ligue). N'agit que
sur T en v2. A reestimer avec plus de journees.

**v3 — moyenne v1/v2 (décision de l'utilisateur, 2026-11-04), EN PRODUCTION sur Meilleurs Paris depuis
le 2026-11-05 (`Modele.v3`).** v1 et v2 restent les références, comparées à la v3 dans `comparaison.html`
(résultats, marché, « mon prono »). Bilan des deux premières soirées (23 matchs, avant mise en prod) :
Brier v2 0,543, v3 0,551, v1 0,569 — trop peu pour conclure, la décision repose sur le raisonnement
(erreurs complémentaires) et sera jugée sur les soirées suivantes.
- **Principe** : P = 0,5·P(v1) + 0,5·P(v2) issue par issue, poids figé avant mesure. Idée d'ensemble :
  v1 (buts de la saison + correction de ligue) et v2 (Elo des clubs) se trompent sur des cas différents
  (v1 : clubs dominants d'une ligue faible, ex. Galatasaray ; v2 : dynamique de la saison, ex. Derby en
  Championship, 2e plus faible sur la saison mais seulement 5e plus faible en ClubElo).
- **Cas Lens – Côme (C1, 2026-11-04)** : v1 28 / 24,5 / 47 (2 pts du marché), v2 43 / 24,5 / 32
  (17,5 pts), moyenne 36 / 24,5 / 40 (10 pts). Marché (cotes 3,60 / 3,80 / 1,95, sans marge) :
  26 / 24,5 / 49,5. ClubElo met déjà Côme devant (1827 vs 1801) : en v2, Lens n'est favori que par
  l'avantage du terrain (+65) ; même sans lui (34 / 25 / 41), la v2 reste loin du marché (dE implicite du
  marché ≈ −83 vs +39 en v2).
- **Man United – Roma (2026-11-03)** : moyenne ~37 / 23 / 40, Roma favorite, alors que le marché disait
  47 / 21 / 32 — moins bonne que la v2 face au marché.
- Remarque de l'utilisateur : les deux matchs ont été serrés sur le terrain (MU – Roma : Roma menait, MU
  est revenu en fin de match, 3-2), la moyenne, plus équilibrée, colle à ce ressenti. À garder en tête :
  un résultat ou une impression de match ne valide pas une probabilité (un 47 / 21 / 32 donne 53 % de ne
  pas voir le favori gagner) ; seule la calibration sur des dizaines de soirées tranche (écart au marché
  journalisé + Brier/log-loss sur les résultats). Variante à ne tester qu'ensuite (`version_modele`
  distincte) : autre poids.
- **Écarté (ne pas reintroduire sans nouvelle raison)** : mélange de l'Elo ClubElo avec un « Elo de la
  saison » (`Elo saison = Elo moyen du championnat + ln(att/def)/(2k)`, poids j/(j+J0)), testé le
  2026-11-03/04 puis supprimé du code à la demande de l'utilisateur. Appliqué à tous les matchs, il tirait
  les clubs dominants vers le niveau de leur ligue (PSG 56 % -> 44 %), le biais v1 que la v2 corrigeait ;
  restreint aux matchs internes à un championnat, son gain mesuré n'existait que sur la soirée qui avait
  servi à choisir la règle.

**Pistes à réfléchir pour la v3 (non implémentées, une `version_modele` chacune)** :
- **Alerte « écart au marché »** : sur Meilleurs Paris, signaler un match si l'écart max entre le modèle et
  le marché démargé dépasse ~10 pts, pour qu'il ne soit pas lu comme une « value » (43 % × 3,60 = 1,55
  d'espérance apparente sur Lens : c'est une erreur du modèle, pas une valeur). Prérequis : les cotes dans
  les données (aujourd'hui saisie manuelle dans `comparaison.html`) -> scraper de cotes côté backend.
  Seuil à choisir à partir des écarts journalisés.
- **Avantage du terrain réduit en Coupe d'Europe** : +65 partout est peut-être trop fort entre deux clubs
  proches en C1/C3/C4. À juger sur plusieurs soirées de matchs européens (écart au marché journalisé +
  résultats), pas sur Lens – Côme seul (ça ne corrige qu'une partie de l'écart).
- **Avantage du terrain par championnat** lissé vers 65 (mesuré le 2026-11-03 : Championship ~58,
  Serie A ~8, Eredivisie ~-24, Bundesliga ~97, bruit ±25) — jamais par équipe (6 matchs = bruit) ; et
  **K_LISSAGE plus faible** (~7,5 estimé).
- **Tirs cadrés** : attaque = 35 % buts + 65 % tirs cadrés (plus stables, moins de chance, se stabilisent
  plus vite ; principe des xG). Limite : pas de tirs cadrés concédés en base -> défense toujours sur les buts.
- **Mesure de la saison = buts seulement** (att/def lissés). Autres stats volontairement exclues du
  modèle : efficacité (composante des buts + forte régression vers la moyenne = double comptage),
  forme 5 matchs (déjà dans les totaux, bruit), possession (style, pouvoir prédictif résiduel ~nul),
  points réels vs attendus (mesure la chance : partir des buts l'ignore déjà), domicile/extérieur par
  équipe (6-7 matchs = bruit). Ces stats relèvent de l'analyse IA (contexte), pas du modèle.

**v2-tirs (`Modele.v2tirs`, `v2-elo-k13-tirs-sd2`) — candidat suivi depuis le 2026-11-07, PAS en prod.** v2 dont
l'attaque = tirs cadrés × conversion lissée vers celle du championnat (K = c(1−c)/0,02² ≈ 550 tirs). Mesure du
2026-11-07 (192 équipes) : écart réel de conversion entre équipes ~2 pts (0 dans 6 championnats sur 10, le reste
= bruit binomial) ; lien avec l'Elo faible (+1,5 pt pour +250 Elo, et biaisé vers le haut car l'Elo contient la
saison) -> cible = conversion du championnat, sans terme de niveau. Agit sur T (marché des buts), presque pas
sur le 1X2. Rétro-test reconstruit du 06/11 (15 matchs) : Brier +2,5 0,239 vs 0,256, paris buts 7/9 vs 3/6 —
trop peu pour décider. `comparaison.html` l'affiche (1X2 + « +2,5 v2 → tirs ») avec un bilan « Marché des buts » ;
`predictions-figees.json` stocke depuis le 07/11 `pt` (v2-tirs), `o2` / `ot` (P(+2,5) v2 = prod / v2-tirs) et
`conseil_probas`. Conséquence pour `lecture-contexte.js` : la phrase « transforme X % de ses tirs cadrés… ce rythme
devrait baisser » (seuil fixe 0,38) signale surtout du bruit (à ~50 tirs, ~16 % des équipes normales le franchissent).

**Ce qu'il ne faut pas attendre** : comparer v1 et v2 par Brier score apparie demande ~600 matchs
logges (6 a 8 semaines) ; la calibration par tranches ~400 matchs par tranche ; detecter un avantage
reel contre un bookmaker, plusieurs milliers de paris. Le pari n'est pas l'instrument de validation du
modele : les matchs logges (joues ou non pariés) le sont.

## Agent IA « IA modele » (prompt v10) — EN PRODUCTION depuis le 2026-11-06

Principe : **les chiffres et les decisions viennent du code, l'IA ne fait que rediger.** Lecon de deux jours de
tests : chaque reformulation du prompt corrigeait un cas et en deplacait un autre ; ce qui a marche, c'est de
sortir les decisions du LLM (comme la forme decodee en SQL).
- **Frontend** (`index.html`, `meilleurs-paris.html`, `confrontation.html`) : envoie un bloc `modele`
  (`Modele.payloadModele`, v3) dont `lignes` = lignes du verdict deja redigees (`lignesVerdict` : pronostic,
  nul, buts, conseil par etiquette, `conseil_probas`, equipe jugee).
- **Conseil** : par les seules probabilites (favori net >= 60 % -> victoire ; leger favori >= 45 % ->
  rembourse si nul, double chance si nul > 28 % ; match ouvert avec une equipe >= 40 % -> double chance ;
  sinon pas de pari ; + plus/moins de 2,5 buts si P(Over) >= 60 % / <= 40 %). **Couplage asymetrique** : un
  contexte DEFAVORABLE degrade d'un cran (solide -> fragile -> pas de pari), FAVORABLE / MITIGE ne changent
  rien — une etiquette fausse ne peut que faire manquer un pari, jamais en creer un.
- **Workflow n8n** (local : `prompts-n8n/workflow_football-analyze_2026-11-06_v10-prod.json`, sauvegarde v8
  sur le serveur `backup_football-analyze_2026-11-06_v8-avant-v10.json`) : Webhook -> Postgres (requete fixe
  AVANT l'IA, plus d'outil : 1 seul appel LLM) -> Code « Preparer » (`lectureContexte` : listes Pour / Contre et
  etiquette FAVORABLE / MITIGE / DEFAVORABLE calculees ; message a l'IA sans jsonb brut) -> AI Agent sans outil
  (gpt-4.1-mini depuis le 2026-11-06 soir, prompt v10b, exemples FICTIFS) -> Code « Lignes du verdict » (impose Pronostic / Conseil /
  Nul / Buts, retire les ```html) -> Respond.
- **Mesures (memes matchs)** : prod v8 ~6 630 tokens / 14,1 s ; v10b ~2 070 tokens / 5,2 s, 0 defaut
  automatique sur 6 matchs dont 4 jamais vus, etiquette stable.
- **Pieges** : ne pas ecrire les exemples du prompt sur un match de test (l'IA recopie l'exemple) ;
  CONFIRME / NUANCE / CONTREDIT etaient lus comme « contredire l'equilibre » du match ouvert -> etiquettes
  orientees vers l'equipe jugee ; l'IA recopiait mal les lignes (prefixes, mots changes) -> nœud Code.
  `indice_realisme` (buts / tirs cadres, non lisse) = surtout de la reussite : lu comme un signal de
  regression, jamais un atout.
- Meilleurs Paris : badge « Contexte : FAVORABLE / MITIGE / DEFAVORABLE » (lu dans le rapport, ancien format
  « Indice de confiance » encore lu pour le cache). Test d'un nouveau prompt : workflow de test, local
  `?n8n=test` -> `/webhook/football-analyze-ia-modele`.
- A faire : journaliser etiquette / score / conseil_probas / conseil final + resultat (table Supabase ecrite
  par n8n) ; seuils de `lectureContexte` relatifs au championnat (aujourd'hui absolus) ; Elo rafraichi chaque
  jour.

## Etat au 2026-11-07

- **Prod n8n = v10c** (deployee le 2026-11-07 au matin, test puis prod) : `lecture-contexte.js` sans le fait
  « transforme N % de ses tirs cadres… ce rythme devrait baisser » (bruit, declenche sur 18 matchs sur 43 le 07/11)
  ni l'exclusion attaque / conversion ; paragraphe de risque « n'est donne qu'a N % » seulement sous 50 % affiche,
  au-dessus « le modele donne N % de victoire a X, il reste M % pour le nul ou une defaite ». Prompt v10c : exemple 1
  sans conversion, « devrait » interdit sans exception. Effet mesure sur les 43 matchs du 07/11 : 6 etiquettes
  FAVORABLE <-> MITIGE, 0 conseil change. Sauvegarde serveur : `backup_football-analyze_2026-11-07_v10-avant-v10c.json`.
- `comparaison.html` suit la v2-tirs et le marche des buts ; 43 matchs du 07/11 figes dans `predictions-figees.json`.
- **Bug corrige le 2026-11-07 : 5 Elo impossibles dans `elo-clubs.json`** depuis le snapshot du 2026-11-03 (Deportivo
  112, Lorient 157, Atalanta 210, Gil Vicente 423, Benfica 554 : erreur de lecture de la page ClubElo, aucune erreur
  levee). Effet en prod v3 : Espanyol – Deportivo 63/19/19 au lieu de 37/27/36. Retires (Elo moyen du championnat,
  prediction « Elo approximatif ») ; valeurs gardees dans `elo_invalides_retires`. `build_elo_snapshot.py` refuse
  desormais un Elo hors 1000-2500. **A refaire** : snapshot complet quand ClubElo repond (403 Cloudflare / API 502
  le 07/11). Les predictions figees de ces equipes (03/11 -> 07/11) restent biaisees : a signaler dans les bilans.
- `equipe.html` : bloc « Style de jeu » (controle / percussion / volume de tirs, rapportes au niveau), descriptif.

## Etat au 2026-11-06 (soir)

- **Prod (deployee le 2026-11-06 au soir)** : IA modele v10 + correctifs des rounds 1 et 2, **gpt-4.1-mini**
  (mesure : 0 defaut sur 25 analyses, ~3,3 s, ~1 720 tokens en entree contre gpt-4o-mini 5,7 s et des
  confusions Pour / Contre). Message a l'IA sans donnees brutes (listes Pour / Contre titrees, palier de forme,
  un buteur par equipe) ; paragraphe « Ce qui peut faire mentir le pronostic » ecrit par le CODE
  (`lecture-contexte.js`, `paragrapheRisque`, chaque fait porte `{ texte, risque }`) et insere par le noeud
  « Lignes du verdict » ; libelles (niveau, equipe devant, nul, buts) calcules sur le pourcentage AFFICHE.
  Sauvegarde serveur avant deploiement : `backup_football-analyze_2026-11-06_v10-avant-round2.json`.
  Calendrier et Confrontation affichent les probabilites du modele.
- Workflow n8n de TEST (`?n8n=test` en local) : meme version que la prod, garde pour les prochains essais.
  Banc d'essai (local) : `prompts-n8n/banc-essai/` (build_wf.py, iter.sh, grilles reg.py / bench.py).
- `lecture-contexte.js` (racine) = source unique de la fonction du noeud n8n « Preparer » ; tests :
  `node lecture-contexte.js`. Toute modif doit etre reportee dans le noeud (le build l'integre tel quel).
- Scrape quotidien decale a 00h30 (le 06/11 a 00h00, footmercato affichait encore les matchs de la veille).

## Etat au 2026-11-05

- En production : modele **v3** (moyenne v1/v2) sur Meilleurs Paris ; prompt n8n **v8** (niveau + forme) ;
  scraper avec les nouveaux libelles « Niveau » et « Forme » ; page `equipe.html` (menu « Équipes »).
- Scrape complet relance a la main le 2026-11-05 vers 0h36 : **verifie** (termine, nouveaux libelles
  « Niveau » et « Forme » en base et sur `equipe.html`). Reste a tester : une analyse IA sur un match du
  week-end (le rapport doit parler de « niveau » et reprendre les chiffres de forme).
- Suivi des modeles : `comparaison.html` (v1 / v2 / v3, marche, scores, Mon prono), predictions figees
  dans `predictions-figees.json` (a completer avant chaque soiree si la page n'a pas ete ouverte avant
  les matchs).

## Etat au 2026-11-02

- Le modele Poisson (`dd9b9df`) est pousse et en ligne, ainsi que la page Championnats (`9da9c28`) et
  le passage a 20 joueurs sur Buteurs & Passeurs (`bfe9792`).
- Changement lie cote backend : les algorithmes du scraper (`scraper_league_team.py`,
  `scraper_detail_team.py`, voir le repo backend mentionne plus haut) ont ete revus le meme jour pour
  utiliser le meme principe (seuils relatifs au championnat + shrinkage, au lieu de seuils absolus fixes)
  — voir le CLAUDE.md de ce repo pour le detail et un piege important rencontre (le conteneur
  scraper-python doit etre redemarre apres toute modif de fichier `.py`, sinon l'ancien code reste actif
  en memoire). A valider et pousser en meme temps que ce repo, les deux changements partagent la meme
  philosophie (eviter de compter un signal deux fois entre labels qualitatifs et stats brutes).
- Si vous reprenez cette session : verifier d'abord l'etat du scrape de validation lance sur le VPS,
  puis tester les pages localement (`python3 -m http.server` a la racine du repo) avant de pousser quoi
  que ce soit.

## Historique git

L'historique de ce repo a ete force-push/reecrit a un moment (plusieurs versions du frontend ont
coexiste : un ancien widget `@n8n/chat` en chat libre, remplace par la version calendrier actuelle).
