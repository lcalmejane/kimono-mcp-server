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
Le [rapport lexical courant](../benchmarks/results/current.md) porte sur le runtime
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

## Rejouer les mesures (autre LLM, autre machine)

Les mesures de toute campagne, quel que soit le LLM, s'ajoutent à une base de
fiches JSON validées par un schéma : voir [benchmark-database.md](benchmark-database.md)
(modèle de configuration `benchmarks/external-template.json`, adaptateur
`benchmarks/adapters/adapter-template.mjs`, import `npm run bench:db`).

Trois rapports vivent dans `benchmarks/results/`, chacun avec son JSON :

| Rapport | Outil | Appelle un LLM |
| --- | --- | --- |
| [`current.md`](../benchmarks/results/current.md) : Copilot/Gemini, recherche lexicale | `npm run bench:harness -- benchmarks/copilot-gemini-compact.json DIR` | oui |
| [`copilot-gemini-auto-speed.md`](../benchmarks/results/copilot-gemini-auto-speed.md) : même harnais, recherche hybride `auto-speed` | `npm run bench:harness -- benchmarks/copilot-gemini-auto-speed.json DIR` | oui |
| [`embedding-policies.md`](../benchmarks/results/embedding-policies.md) : `e5` / `auto-balanced` / `auto-speed` | `node scripts/bench-embedding.mjs …` | non |

**Autre LLM.** Le runner mesure un harnais, pas un modèle précis : changer de LLM
revient à changer `harness` et `model` dans une copie du JSON de campagne.
Copilot CLI est le seul adaptateur fourni. Pour Claude Code, Codex, Zoo Code ou un
autre client, écrire un adaptateur `harness.kind: "external"` (section précédente).
Les tâches, le corpus, la politique d'inclusion et le protocole d'isolation restent
identiques, ce qui rend les paires comparables. Les compteurs de tokens de deux
fournisseurs n'ont pas forcément le même sens (cache inclus ou non) : ne pas les
comparer directement sans le vérifier.

**Campagne hybride `auto-speed`.** `copilot-gemini-auto-speed.json` lance l'image
Docker `tatami-core-kimono` (à construire ou à remplacer par une image publiée) et
monte en lecture seule `{server}/.bench-models`, ignoré par Git. Ce dossier a la
disposition de `KIMONO_MODELS_DIR` ; y copier les dossiers `code-…` et
`multilingual-fast-…` du volume d'état de Kimono (ou d'un téléchargement confirmé).
Rien n'est téléchargé pendant la mesure. Pour tester `e5` ou `auto-balanced`,
changer `KIMONO_EMBEDDING_POLICY` dans `mcp.args`, et `mcp.indexMode` en `literal`
pour une campagne lexicale.

**Politiques d'embedding.** Sans LLM, donc sans crédit :

```sh
node scripts/bench-embedding.mjs --corpus DIR --models DIR --out DIR \
  [--image tatami-core-kimono] [--policies e5,auto-balanced,auto-speed] \
  [--runs 5] [--limit 10] [--cases cases.json] \
  [--workers 2] [--modes text,semantic,hybrid]
```

`--workers N` fixe `KIMONO_SEMANTIC_WORKERS` dans le conteneur : sur un gros corpus,
le défaut (un worker par cœur) peut dépasser la mémoire de la VM Docker et le
processus sémantique est tué (`SIGKILL`). `--modes` limite les modes mesurés ; le
mode `text` est bien plus lent que `semantic` sur un grand corpus, les séparer permet
d'obtenir le sémantique rapidement. Le snapshot de recherche est renouvelé avant son
expiration (15 minutes par défaut), faute de quoi une longue passe lexicale invalide
les modes suivants.

`--corpus` désigne n'importe quel dossier (une copie du dépôt à mesurer), `--models`
le dossier de modèles ci-dessus, `--cases` un JSON `[{"query": "…", "expected":
["chemin/fichier.ts"]}]` pour remplacer les 16 requêtes par défaut. Chaque
politique tourne dans un conteneur jetable à cache vide ; le rapport indique la
première exécution de chaque requête (les suivantes passent par le cache de
recherche) et estime les tokens à octets / 4.

**Corpus de documents d'entreprise (avec et sans Kimono).** Pour mesurer le temps, les
tokens et la consommation d'un agent avec et sans Kimono sur un gros corpus de
documents, on utilise les documents du jeu public
[onyx-dot-app/EnterpriseRAG-Bench](https://github.com/onyx-dot-app/EnterpriseRAG-Bench)
(code MIT) **uniquement comme contenu** : ni ses questions, ni ses tests, ni son
évaluation. Les tâches sont les nôtres, dans
`benchmarks/enterprise-rag-docs.json` (trois tâches de recherche, une répétition,
Copilot CLI avec Gemini 3.8 Flash). Le jeu contient un GUID « canary » demandant de ne
pas l'inclure dans des corpus d'entraînement : le garder hors du dépôt et ne jamais le
committer ni le publier. `.bench-corpus/` est ignoré par Git.

Préparer le corpus (13 241 documents GitHub et Confluence) : extraire les archives de
la release du jeu sous `/tmp/erb/docs`, puis, depuis `kimono-mcp-server/` :

```sh
mkdir -p .bench-corpus/enterprise-rag/github .bench-corpus/enterprise-rag/confluence
for d in /tmp/erb/docs/github_slice_*/github;         do cp -R "$d/." .bench-corpus/enterprise-rag/github/; done
for d in /tmp/erb/docs/confluence_slice_*/confluence; do cp -R "$d/." .bench-corpus/enterprise-rag/confluence/; done
git -C .bench-corpus/enterprise-rag init -q && git -C .bench-corpus/enterprise-rag add -A \
  && git -C .bench-corpus/enterprise-rag -c user.name=bench -c user.email=bench@example.invalid commit -qm corpus
```

Le runner exige un dépôt Git propre comme corpus (commit et état `dirty` consignés).
Vérifier la campagne sans appeler de LLM, puis la lancer (plusieurs minutes, hors
`/tmp` si besoin) :

```sh
npm run bench:harness -- benchmarks/enterprise-rag-docs.json /tmp/erb/harness-dry --dry-run
npm run bench:harness -- benchmarks/enterprise-rag-docs.json /tmp/erb/harness-run
```

`KIMONO_SEMANTIC_WORKERS=2` est fixé dans la configuration MCP : sur ce corpus (89 Mo,
140 289 morceaux) le défaut d'un worker par cœur dépasse la mémoire de la VM Docker et
le worker est tué (`SIGKILL`) pendant le préchauffage. Le préchauffage et les 6
cellules (3 tâches × avec et sans Kimono) ont été validés jusqu'au lancement de
Copilot ; l'état au 2026-10-31 est que les cellules échouent en
`402 additional_spend_limit_reached` (limite d'usage supplémentaire du plan Copilot
atteinte), donc **aucune mesure n'a encore été obtenue** pour cette campagne. Après un
échec, supprimer le dossier de sortie avant de relancer : le runner refuse un dossier
existant. Importer ensuite le résultat avec `npm run bench:db -- import-harness DIR …`.

**Qualité de la recherche seule (sans LLM).** Cette mesure répond à une autre
question : la bonne source est-elle retrouvée, et en combien de temps ? Elle n'inclut
ni agent, ni bras sans Kimono, ni consommation de tokens, et ne répond donc pas à la
question « avec ou sans Kimono ». Elle utilise les questions du jeu et leurs documents
attendus :

```sh
# Questions : questions.jsonl ; archives GitHub et Confluence extraites sous DIR/docs
node scripts/enterprise-rag-cases.mjs --questions questions.jsonl --corpus DIR/docs \
  --out cases.json [--sources github,confluence] [--types basic,semantic] [--limit N]
node scripts/bench-embedding.mjs --corpus DIR/docs --models .bench-models --out OUT \
  --policies auto-speed --runs 1 --cases cases.json --workers 2
node scripts/enterprise-rag-report.mjs --results OUT/results.json --cases cases.json
```

`enterprise-rag-cases.mjs` associe les `expected_doc_ids` aux fichiers `dsid_<id>__…`
et ignore les questions sans document attendu (`high_level`, `info_not_found`), celles
d'une source absente du corpus et celles dont un document manque. Le rapport par
catégorie joint les lignes aux cas par le texte de la requête. Un seul document
attendu suffit pour compter un succès : c'est plus indulgent que le rappel complet
pour les catégories `completeness` et `project_related`. Le mode texte est très lent
sur ce corpus (environ 10 s par requête) : mesurer le sémantique à part avec
`--modes semantic`.

Toute campagne reste exploratoire tant que la revue humaine et au moins trois
répétitions manquent : le runner marque les paires non admissibles.

## Références

- [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- `copilot --help` : options réellement prises en charge par la version épinglée,
  notamment JSONL, `--usage-output-file`, permissions et isolation de configuration.
- [Benchmark lexical existant](../scripts/bench-search.ts) : comparaison de moteurs
  sans modèle, complémentaire mais différente du présent benchmark de harnais.
