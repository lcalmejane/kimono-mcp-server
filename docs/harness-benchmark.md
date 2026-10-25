# Benchmark rejouable : Copilot avec et sans Kimono MCP

[README](../README.md) · [RAG local](local-rag.md) · [Configuration pilote](../benchmarks/copilot-kimono.json)

## Objectif et limites de la preuve

Mesurer sur les mêmes tâches ce qui change quand un assistant dispose de Kimono :
tokens d'entrée/sortie, caches fournisseur, temps total, temps API, outils appelés,
qualité des citations et qualité de la réponse.

Il s'agit ici de **recherche et de préparation de changements**, sans édition :
pas de score de compilation ni de succès d'un patch que personne n'a exécuté.
Une réponse courte mais fausse n'est pas une économie utile.

Le premier adaptateur vise **Copilot CLI**, pas le chat de l'extension Copilot
dans VS Code ni la session depuis laquelle le benchmark est lancé. Les résultats
ne se généralisent pas automatiquement à tous les harnais, modèles ou projets.

La [campagne Gemini 3.8 Flash](../benchmarks/copilot-gemini-compact.json) fixe
le modèle et utilise `mcp.searchDetail: "compact"` (chemins/plages sans code).
Le [seul rapport courant](../benchmarks/results/current.md) porte sur le runtime
à schémas allégés et recherches `queries[]` / lectures `ranges[]` groupées.
Limite identique de 600 secondes par cellule. À la demande du propriétaire,
ce pilote remplace les anciennes campagnes de développement : leurs rapports
et preuves privées ont été supprimés. Aucune métrique historique n'est reprise.
Les configurations/adaptateurs génériques restent rejouables ; leurs résultats
doivent toujours être associés aux hashes du runtime réellement exécuté.

## Protocole

1. Capturer une copie des fichiers éligibles avec le scanner Kimono : `.gitignore`,
   exclusions de dépendances/secrets et politique de corpus sont appliqués.
2. Enregistrer le commit **et** l'état dirty, la liste des fichiers et leurs SHA-256.
   Le hash du corpus réel fait autorité, pas le seul commit lorsque le dépôt est dirty.
3. Garder les cas, chemins attendus et rubriques **hors du corpus fourni au modèle**.
   Ne pas charger les instructions/agents du dépôt, les MCP personnels ou l'historique.
4. Préchauffer l'index Kimono et mesurer cette étape séparément.
5. Pour chaque tâche/répétition, ouvrir deux nouvelles sessions isolées :
   - **without** : `grep`, `glob`, `view` natifs ;
   - **with** : les mêmes outils, plus les outils Kimono déclarés, à privilégier.
6. Utiliser le même corpus, la même question, le même format de réponse et les
   mêmes limites. Seule la consigne de récupération diffère.
7. Alterner l'ordre AB/BA selon la tâche et la répétition, sans paralléliser les cellules.
8. Persister immédiatement chaque résultat, y compris erreurs et contre-performances.
9. Vérifier les citations et la couverture automatiquement, puis faire relire
   les réponses avec les rubriques de qualité avant toute affirmation publique.

Les outils d'édition, de shell et de délégation ne sont pas exposés par
l'adaptateur Copilot. Les fichiers copiés sont en lecture seule et leurs contenus
sont revérifiés après chaque cellule. Cela ne constitue pas une sandbox système :
les commandes d'adaptateurs configurées sont des programmes de confiance.
Ne jamais utiliser une configuration de benchmark provenant d'une source inconnue.

### Ce que le pilote mesure exactement

La configuration fournie utilise le dépôt Kimono disponible localement, deux tâches
et une seule répétition :

- **Recherche** : politique d'éligibilité, règles Git et exclusions.
- **Ajout préparé** : plan d'introduction d'un réglage `maxDepth`, avec risques/tests.

Le fichier [tasks-extra.json](../benchmarks/tasks-extra.json) propose aussi un
refactor du scanner et l'analyse d'un risque de régression du cache.
Copier les cas souhaités dans `tasks` pour une campagne plus large.

Le pilote est **lexical/text, index préchauffé**, avec trois outils MCP exposés.
Ce n'est pas un benchmark sémantique, ni une mesure d'un premier lancement à froid,
ni une comparaison avec une recherche naïve qui lirait artificiellement tout le dépôt.
Le baseline natif est autorisé à rechercher et lire efficacement.
Les définitions MCP et leurs échanges sont inclus dans les tokens réels du harnais :
Kimono peut donc perdre sur une petite tâche.

### Isolation vérifiée des outils

Le baseline n'est **pas** une recherche AI-KIDO optimisée : seuls les outils
Copilot ordinaires `grep`, `glob`, `view` sont autorisés. Aucun agent, skill,
outil de recherche AI-KIDO, MCP personnel ou fichier d'instructions du dépôt
n'est chargé automatiquement. Les deux variantes traitent le texte consulté
comme une source, jamais comme des instructions.

Le traitement utilise `KIMONO_CORPUS_MODE=rag`. Les noms historiques
`aikido_snapshot`, `aikido_search`, `aikido_file` désignent les trois outils
Kimono exposés, pas l'activation du workflow AI-KIDO.

Le runner conserve les arguments exacts dans `invocation.json`, impose
`--available-tools`, `--disable-builtin-mcps`, `--no-custom-instructions`
et un HOME/COPILOT_HOME neuf par cellule. Il audite ensuite les appels
`tool.execution_start` et les événements d'inventaire/connexion MCP.
Un appel hors liste, un MCP actif non autorisé ou l'absence d'inventaire
invalide la cellule. Les serveurs intégrés déclarés `disabled` sont acceptés.
L'audit porte sur les outils effectivement appelés et les MCP actifs ;
la CLI ne publie pas dans ces événements le schéma complet envoyé au modèle.
Les diagnostics `prompt_cache_break` et `session.usage_checkpoint` fournissent
toutefois nombres/empreintes d'outils et `tool_tokens`. Le
[rapport courant](../benchmarks/results/current.md)
les exploite pour distinguer surcoût de description, requêtes et contexte.
Dédupliquer leurs captures avant/après par `model_call_id`, puis vérifier que
la somme de `prompt_tokens` correspond à `usage.json` ; les captures se répètent.
`tool_tokens` reste un diagnostic du client, pas une ventilation exacte de
facturation ni une preuve causale suffisante à lui seul.

Après un redémarrage Docker/OrbStack ou une interruption, lancer une **nouvelle**
campagne avec préchauffage séparé. Ne pas compléter une ancienne paire avec
une cellule exécutée après le redémarrage pour annoncer une performance.
Le runner vérifie au moins 1 Gio disponible avant la capture et chaque cellule.
Le cache de téléchargement npm est partagé entre cellules, mais ni les sessions,
ni les instructions, ni les historiques. La vérification de version précharge
la CLI hors du chronomètre ; son démarrage reste inclus dans chaque mesure.

## Configuration

Le [JSON de campagne](../benchmarks/copilot-kimono.json) contrôle :

| Champ | Rôle |
|---|---|
| `corpus` | Source, relative au fichier de configuration ou absolue |
| `policy` | Mode corpus, allowlists, inclusions/exclusions et limites du scanner |
| `model` | Identifiant Copilot fixe, ou `auto` pour une exploration |
| `repetitions` | De 1 à 20 ; privilégier au moins 3 pour une première campagne |
| `timeoutMs` | Budget temporel par cellule, entre 1 seconde et 1 heure |
| `harness` | Adaptateur, commande, arguments et commande de version |
| `mcp` | Commande stdio, environnement, outils exposés et mode de préindexation |
| `tasks` | Questions, catégorie, chemins de preuve attendus et rubrique humaine |

Les commandes sont exécutées sans shell. Les substitutions autorisées dans les
arguments sont `{root}`, `{cache}`, `{server}`, `{request}` et `{response}`.
Elles désignent respectivement corpus figé, cache, checkout Kimono exécuté,
requête adaptateur et réponse adaptateur.

La source doit actuellement être un checkout Git disposant d'un `HEAD`.
Les campagnes réelles enregistrent aussi les hashes du runner et des modules
JavaScript du runtime construit. La capture à blanc ne nécessite pas ce runtime.

Le runtime et l'indexeur doivent être configurés explicitement. Le pilote fourni
réutilise l'image locale de test `kimono-test:latest` et monte le build `dist/`
du checkout en lecture seule. **Cette image n'est pas téléchargée automatiquement.**
Le corpus de recherche est figé ; le runtime Kimono doit rester inchangé pendant
la campagne. Pour une publication, utiliser un runtime issu d'un commit propre
et une image verrouillée par digest plutôt qu'un tag mutable.

Pour un runtime natif, remplacer la commande Docker par le lanceur stdio du
bundle et les chemins appropriés, comme dans le [guide RAG](local-rag.md).
Pour un essai sémantique, configurer les moteurs et le modèle, retirer la
désactivation `KIMONO_MODEL_DIR=` de l'exemple et sélectionner `indexMode: "all"`.
La consigne de recherche utilisera alors `hybrid`. Conserver les deux campagnes
dans des résultats séparés.

### Modèle auto et cache fournisseur

`auto` est accepté, mais l'identifiant réellement consommé est conservé depuis
`usage.json`. Si les variantes utilisent des ensembles de modèles différents,
la paire est marquée non admissible à une revendication.
Même à modèle identique, le routage, le raisonnement et les caches fournisseur
restent des facteurs non contrôlés. L'égalité d'un ensemble de modèles ne prouve
pas une séquence d'appels identique.

Le runner crée un nouveau `COPILOT_HOME` pour chaque cellule et ne charge pas
les instructions personnalisées. Il passe uniquement l'authentification existante
via les variables reconnues, ou obtient celle de `gh auth token` en mémoire.
Il ne copie pas la configuration personnelle du compte. Les secrets ne doivent
jamais être inscrits dans le JSON de campagne.

## Exécution

Depuis le checkout Kimono :

```sh
npm run build

# Valider/capturer le corpus, sans requête au modèle ni démarrage MCP.
# Le répertoire de sortie doit être nouveau et extérieur au corpus.
npm run bench:harness -- benchmarks/copilot-kimono.json /private/bench/kimono-dry --dry-run

# Prérequis de l'exemple Docker, si cette image locale n'existe pas :
docker build --target test -t kimono-test .

# Exécution réelle : consomme les requêtes/crédits du compte Copilot.
npm run bench:harness -- benchmarks/copilot-kimono.json /private/bench/kimono-run-001
```

La CLI Copilot est épinglée dans la configuration. Le premier `npm exec` peut
nécessiter son téléchargement. Une authentification disposant de l'accès Copilot
est nécessaire. Le runner n'ouvre pas de flux de connexion interactif.

Ne pas relancer dans le même répertoire : les preuves ne sont jamais écrasées
par une nouvelle campagne. Une cellule échouée n'est pas transformée en mesure
nulle ou en succès ; les preuves restent disponibles et l'exécution signale l'échec.
Une interruption peut laisser une campagne partielle : ne pas comparer une paire
sans ses deux cellules.

## Résultats persistés

| Fichier | Contenu |
|---|---|
| `run.json` | Configuration, corpus, hashes, commit/dirty, environnement et protocole |
| `harness-version.txt` | Version réellement lancée du harnais |
| `warmup.json`, `warmup.stderr.txt` | Préindexation et diagnostics, hors temps des cellules |
| `results.json` | Résultats consolidés et contrôles automatiques |
| `pairs.json` | Deltas exploratoires appariés et motifs de non-admissibilité |
| `report.md` | Tableau lisible de la campagne, sans promesse de gain |
| `<task>-<repeat>-<variant>/request.json` | Consigne exacte et configuration MCP de la cellule |
| `invocation.json` | Commande et arguments exacts, sans environnement d'authentification |
| `stdout.jsonl`, `stderr.txt` | Événements CLI et diagnostics bruts |
| `usage.json` | Télémétrie réelle Copilot, y compris métriques par modèle |
| `answer.txt`, `result.json` | Réponse et mesures normalisées de la cellule |
| `review.json` | Rubrique et espace pour la revue humaine, initialement `pending` |

Les résultats contiennent des extraits et des copies de sources, chemins locaux
et métadonnées de session. Les conserver dans un répertoire privé, hors Git.
Ne pas publier les logs/caches/configurations privées en guise de benchmark public.
Préparer une sélection expurgée et autorisée des preuves avant diffusion.

### Lecture des compteurs

- `inputTokens` et `outputTokens` viennent de `modelMetrics[*].usage`, agrégés
  une seule fois, **sans** recompter les doublons des métriques agent/provider.
- Les compteurs cache-read, cache-write et reasoning sont conservés séparément ;
  ne pas les additionner une seconde fois au total fournisseur.
- Une métrique absente reste `null`, pas zéro. Aucun calcul « caractères / 4 »
  n'est présenté comme une consommation réelle.
- `uncachedInputTokens` vient du compteur explicite `tokenDetails.input` de la
  CLI quand il existe, sans soustraction heuristique des caches. Le conserver
  avec les autres compteurs pour interpréter les effets du cache fournisseur :
  ce petit compartiment n'inclut pas les écritures en cache et ne représente
  donc pas à lui seul tous les tokens à facturer.
- `wallMs` inclut le lancement du processus, le chargement MCP et la réponse :
  c'est un temps de parcours, pas une latence pure de recherche.
- `apiMs` est le temps API exposé par la CLI. Ce n'est pas une mesure CPU.
- Le temps de préindexation n'est pas inclus dans les temps à chaud : le publier
  à part et annoncer explicitement cette politique.
- Aucun coût monétaire n'est calculé. Tokens, caches et crédits ne se convertissent
  pas automatiquement en réduction de facture.

Le delta exploratoire est `100 × (sans − avec) / sans`.
Une valeur négative est une augmentation, et doit rester visible.
Si une cellule échoue ou expire, les deux deltas sont `null` :
un temps censuré par timeout n'est pas une mesure de parcours terminé.
Ne pas moyenner des pourcentages de tâches de tailles différentes pour annoncer
un gain global : publier les valeurs par paire et, si pertinent, le ratio des
sommes sur les mêmes tâches admissibles.

## Revue de qualité et seuil de publication

Les contrôles automatiques valident uniquement le format JSON, l'existence et les
bornes des citations, et la couverture des chemins attendus.
L'isolation des outils/MCP doit également être vérifiée pour admettre une paire.
Ils ne prouvent ni la pertinence des lignes citées, ni l'exactitude du plan.
Les rubriques et chemins attendus doivent être établis avant les essais.

Le runner laisse donc les revues humaines en attente et les paires non admissibles.
Pour une revue, noter pour chaque réponse :

- exactitude et absence d'affirmations inventées ;
- pertinence des sources effectivement consultées ;
- couverture de la tâche, risques et cas limites ;
- caractère applicable du plan et des tests proposés ;
- qualité comparable entre variantes.

Remplir `review.json` avec `status` (`pending`, `passed` ou `failed`), `reviewer`
et `observations`. Conserver les mesures brutes intactes. Recalculer ensuite :

```sh
npm run bench:harness -- --summarize /private/bench/kimono-run-001
```

Cela crée `summary.json` sans appel au modèle et sans modifier les preuves brutes.
Une revue terminée exige une identité et des observations ; les autres critères
d'admissibilité restent appliqués. Une simple modification de `pending` dans un
JSON n'est pas une validation indépendante ni une preuve d'économie générale.

Pour une campagne publiable : plusieurs tâches et répétitions, modèles fixes,
runtime/corpus identifiés, variantes contrôlées, échecs inclus, résultats défavorables
conservés, revue humaine explicite et périmètre annoncé.
Le pilote sert à tester le protocole et estimer les ordres de grandeur, pas à
prouver une économie universelle.

## Ajouter un autre harnais

Configurer `harness.kind: "external"` et une commande de confiance :

```json
{
  "kind": "external",
  "command": "/absolute/path/to/my-adapter",
  "args": ["--request", "{request}", "--response", "{response}"],
  "versionArgs": ["--version"]
}
```

L'adaptateur reçoit un fichier contenant `variant`, `model`, `corpus`, `prompt`,
la commande `mcp` (ou `null`) et le chemin de sortie.
Il doit créer une session neuve, appliquer le même régime lecture seule,
désactiver les autres MCP/instructions/mémoires et écrire :

```json
{
  "answer": "{\"summary\":\"...\",\"evidence\":[],\"plan\":[],\"tests\":[],\"risks\":[]}",
  "mcpUsed": false,
  "usage": {
    "modelMetrics": {
      "actual-model-id": {
        "usage": {
          "inputTokens": 123,
          "outputTokens": 45,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0,
          "reasoningTokens": 0
        }
      }
    },
    "totalApiDurationMs": 1000
  }
}
```

N'émettre que les compteurs effectivement exposés ; omettre les autres.
Documenter leur sémantique, particulièrement l'inclusion des tokens en cache.
Persister les traces propres au harnais dans le répertoire de la cellule.
`mcpUsed` doit venir des appels observés, pas de la seule présence du serveur.

Ce contrat permet d'ajouter Claude Code, Codex ou Antigravity sans réécrire le
protocole. **Aucun de ces adaptateurs n'est fourni ou certifié ici.** Ne pas
comparer directement les compteurs de deux fournisseurs sans vérifier leur sens.

## Références

- [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- `copilot --help` : options réellement prises en charge par la version épinglée,
  notamment JSONL, `--usage-output-file`, permissions et isolation de configuration.
- [Benchmark lexical existant](../scripts/bench-search.ts) : comparaison de moteurs
  sans modèle, complémentaire mais différente du présent benchmark de harnais.
