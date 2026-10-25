# Kimono : usage autonome et base de connaissance partagée

[README](../README.md) · [English version](usage.en.md)

## Ce que fournit Kimono

### Une base de connaissances pour votre équipe et vos agents

La valeur de Kimono ne se limite pas aux tokens : plusieurs clients MCP peuvent
retrouver des preuves dans un corpus commun, inspectable et maintenu par les
humains. Un service HTTP partagé donne un point d'accès commun ; des lancements
stdio indépendants restent des processus locaux distincts. Chaque snapshot
fige sa propre version, sans synchroniser les conversations ni les éditions.
Le RAG par défaut est en lecture seule. Le mode AI-KIDO explicite ajoute
comparaison, publication versionnée et traitement des conflits.

Le [pilote courant](../benchmarks/results/current.md) porte sur le runtime actuel.
Une base commune peut justifier ce compromis fonctionnel pour une équipe,
mais ce bénéfice n'est pas mesuré : les tâches sont mono-agent en RAG,
sans outil de collaboration exposé. Ce n'est ni un surcoût fixe, ni une
promesse d'économie ou de productivité collective chiffrée.

Sur la paire courante de préparation d'ajout, Kimono utilise 71,4 % d'entrée
cumulée et 52,0 % de temps en moins. Une répétition, revue humaine en attente ;
la réponse native de la tâche de recherche échoue au format JSON. Ces chiffres
restent exploratoires, sans économie validée à qualité équivalente.

### Support : pourquoi un MCP local peut-il consommer plus de tokens ?

Le transport local et l'indexation n'appellent pas de modèle. Le client peut
en revanche présenter au modèle les schémas/descriptions des outils, les
consignes serveur, les arguments/résultats et l'historique accumulé.
Les outils natifs ont eux aussi un schéma ; MCP ajoute une interface à décrire.

Moins d'octets de réponse ne garantit pas moins d'entrée cumulée : les
définitions et les résultats précédents peuvent rester dans le contexte des
requêtes suivantes. Cache-read, entrée hors cache et sortie restent distincts ;
le compteur diagnostic `tool_tokens` ne ventile pas exactement la facture.
Voir les [mesures et diagnostics courants](../benchmarks/results/current.md).
Dans ce pilote, le diagnostic vaut 680 par requête en natif, contre 1 903
avec Kimono. Les requêtes modèle passent de 21 à 9 en recherche et de 31 à 9
en planification ; la connexion prend 0,528/0,395 s. Une consommation cumulée
moindre peut donc coexister avec davantage de description d'outils par requête,
sans isoler ici la contribution causale du batching.
Ce n'est pas une taxe fixe du protocole. Limiter les outils activés, regrouper
les plages de lecture et cibler les snapshots sont des pistes à mesurer,
sans sacrifier qualité, erreurs explicites ou cohérence des sources.

### RAG local générique (v0.6.0)

Le mode RAG est le défaut, sans point d'entrée AI-KIDO requis. Les `.gitignore`
racine/imbriqués s'appliquent automatiquement ; `node_modules` et les sorties
de build restent exclus même sans règle Git.
Pour AI-KIDO, choisir explicitement `KIMONO_CORPUS_MODE=aikido`,
CLI `--corpus-mode aikido` ou `kimono.corpusMode: "aikido"` dans l'extension.
Le mode RAG ne publie aucun fichier
et refuse collaboration/sync Git ; les fonctions ci-dessous restent celles du
mode AI-KIDO. Voir le [guide RAG local](local-rag.md) pour les langages,
inclusions/exclusions, limites configurables, snapshots ciblés et branchements
Copilot, Claude Code, Codex et Antigravity. Les index/embeddings sont locaux ;
les extraits transmis au chat peuvent partir vers le fournisseur du modèle.

### Guidance Git en lecture seule et synchronisation distante

`aikido_git` expose `infos`, `sync` et `retarget`. Le ROOT peut être un dossier
sans `.git` ; `infos` indique alors `repository.available:false`.
`retarget` valide et stocke dans le cache externe une URL sans identifiants et
une branche existante facultative ; il ne contacte pas le dépôt. Après ce
retarget explicite, `sync` lit la branche demandée (ou HEAD par défaut), publie
et indexe les connaissances, et préserve les connaissances locales non publiées
en copies seed/conflit. Aucune création de branche, commit, push ou merge n'est
effectuée. L'URL du manifeste de politique est informative et ne devient jamais
une cible implicite. Les dépôts publics anonymes sont pris en charge ; l'accès
privé utilise un résolveur de credentials injecté par l'hôte ou un profil stdio sécurisé. Les
credentials ne sont ni des arguments MCP ni des données persistées dans la base
partagée.
Voir le [contrat complet](../README.md#repository-guidance-and-read-only-remote-synchronization).

### Indexation ciblée (v0.3.0)

Appeler `aikido_index` avec `{"operation":"update","mode":"all","paths":["src/fichier.ts","prompts/concepts","supprime.md"]}`.
`paths` accepte aussi une chaîne unique. Seuls les contenus sélectionnés sont lus ;
les répertoires respectent les frontières exactes, les cibles absentes suppriment
les anciennes entrées et chaque moteur expose ses tableaux indépendants
`indexes.literal/semantic.changes` (`added`, `modified`, `deleted`).
Les exclusions gitignore/privées et les liens symboliques restent exclus.
Un cache ciblé froid reste partiel, sans indexation implicite du reste du corpus.
Sans `paths`, la synchronisation reste globale ; les recherches utilisent le
catalogue immuable du snapshot. En créer un nouveau pour voir les changements.
Les clients en lecture
seule peuvent entretenir les caches hors ROOT sans obtenir de droits d’écriture.
CLI : `kimono index --mode all --paths '["src/fichier.ts"]' --root ./projet`.
`paths` ne s’utilise qu’avec `update` ; chemins dangereux et erreurs des moteurs
sont explicites. `all` est séquentiel, non transactionnel entre moteurs.

Kimono expose un ROOT AI-KIDO par MCP : documents, commandes, agents/personas,
skills et workflows. Le MCP ne modifie pas arbitrairement les fichiers et ne
réalise aucune mutation Git (commit, push, merge, création de branche ou
configuration d'un distant). La synchronisation Git en lecture seule est
explicite via `aikido_git` ; la publication de révisions de connaissances est
séparée via `aikido_collaboration` et n'écrit ni le workspace client ni un
distant Git. Préparer le dossier avant le démarrage ; après des changements locaux, utiliser
`aikido_index update`. Aucun chat ni LLM n'est embarqué : `activate` / `execute`
chargent des instructions pour le client, sans exécuter un workflow autonome.

| Besoin | Outil MCP |
| --- | --- |
| Découvrir/lire/activer les connaissances | `aikido`, ressources et prompts |
| Recherches multi-appels cohérentes | `aikido_snapshot` |
| Recherche littérale, regex, sémantique ou par vecteur existant | `aikido_search` (`snapshotId` requis) |
| Embeddings locaux et informations exactes sur le modèle actif | `aikido_embed` |
| Maintenir les index / suivre l'indexation sémantique | `aikido_index` |
| Collaborer entre copies de connaissances distinctes | `aikido_collaboration` |
| Lire des documents depuis le même snapshot | `aikido_file` (`snapshotId` requis) |

L'inférence sémantique est locale, avec E5 multilingue et ONNX Runtime.
`aikido_embed` avec `{"operation":"info"}` retourne l'identifiant du modèle actif,
ses paramètres et les empreintes de ses fichiers. Une recherche vectorielle
exige cet identifiant ; le client reste responsable de la compatibilité réelle
du vecteur et de son prétraitement. Voir la
[référence complète](../README.md#local-semantic-search).

Pour une recherche multi-appels, commencer par `aikido_snapshot {"operation":"begin"}`.
Passer le `snapshotId` retourné à `aikido` list/search/read/activate/execute,
`aikido_search` et `aikido_file`, puis terminer avec
`aikido_snapshot {"operation":"end","snapshotId":"…"}`. Les réponses incluent
l'identifiant ; `begin` fournit la `version` et la `provenance`, non répétées
dans les recherches compactes. Durée maximale :
15 minutes, 8 snapshots actifs, 256 Mio au total par défaut en mode AI-KIDO.
Les limites deviennent configurables ; `begin` peut limiter la capture avec
`paths`. Voir les [budgets RAG](local-rag.md#grands-dépôts--large-repositories).

Pour un harnais économe en tokens, suivre le [contrat JSON progressif](retrieval.md) :
regrouper les questions indépendantes dans `aikido_search queries:[...]`
(1–20 chaînes), puis les passages retenus de toutes les recherches dans un
seul lot `aikido_file` `ranges` (1–50 plages, chevauchements fusionnés),
et une section ou un fichier complet seulement si nécessaire. Le MCP publie aussi
ce protocole dans ses `instructions` d'initialisation pour tout client MCP.
Les options de recherche sont communes ; un budget global (minimum 4096 octets)
couvre réponses ordonnées, erreurs par requête et reprise `nextQuery`.
Les lectures tronquées indiquent les plages `remaining`. Les recherches unitaires
et vectorielles restent disponibles. Les fichiers complets restent une demande explicite ;
suivre les indications de pagination/troncature plutôt que charger toute la base.

## Modes explicites de collaboration

`aikido_collaboration` fonctionne uniquement via MCP, sans API Tatami ni Git.
Pour un client stdio embarqué qui a vérifié qu'il édite exactement le ROOT
configuré, utiliser le mode **répertoire partagé** : modifier avec les outils
de fichiers du client puis appeler `aikido_index update`, sans réconciliation
ni publication d'une réplique. Ne jamais inférer ce mode depuis HTTP.
Pour HTTP distant ou un workspace distinct, utiliser le mode **réplique
personnelle** : appeler `status` avant les éditions et conserver `sharedVersion`
comme `baseVersion`, comparer les empreintes locales, lire les changements
partagés puis publier explicitement. Chaque conflit exige un choix explicite
local/partagé ; une version périmée impose une nouvelle comparaison. La
publication des connaissances est distincte de la publication Git. `status` et
`publish` actualisent d'abord la révision partagée depuis le ROOT éligible
courant ; les éditions directes et syncs Git en lecture rendent donc une
publication basée sur une ancienne version périmée. Passer une ancienne
`sharedVersion` à `status` retourne son `requestedRevision.manifest` sans
déplacer le pointeur courant. Une publication réussie synchronise les documents
acceptés dans le `AIKIDO_ROOT` configuré : les nouveaux snapshots et recherches
les voient, mais les snapshots déjà ouverts restent immuables. Aucun commit ni
push Git n'est effectué.

## Utilisation autonome

**Docker Compose est recommandé** : Git, outils de recherche Rust, runtime et
modèle d'embedding sont inclus.

```sh
cp .env.example .env
# Modifier .env : MCP_AUTH_TOKEN fort, AIKIDO_HOST_PARENT et AIKIDO_DIR.
docker compose up --build -d
```

Le dossier configuré doit contenir `prompts/index.md` ou `index.md`. S'il
n'existe pas encore, cloner explicitement la source officielle ou personnalisée :

```sh
docker compose --profile install run --build --rm install-aikido
docker compose up --build -d kimono-mcp-server
```

Connecter les clients MCP à `http://127.0.0.1:3000/mcp` avec le jeton Bearer de
l'instance (adapter le port si configuré). Compose n'expose que l'interface
locale ; un accès distant exige TLS et un reverse proxy avec autorisation.
Ne jamais versionner les jetons dans Git.

Pour un seul client, le **mode stdio natif** est aussi disponible après
installation des [prérequis natifs](../README.md#requirements) :

```sh
node dist/cli.js serve --root /absolute/path/to/aikido
```

Configurer le client pour lancer cette commande. Stdio est une connexion dédiée :
la lancer séparément depuis plusieurs clients crée plusieurs processus, pas
plusieurs sessions d'un serveur HTTP commun. Le mode sémantique natif exige
aussi le helper, le modèle et la bibliothèque ONNX décrits dans le README.

## Centraliser une base pour plusieurs clients concurrents

Utiliser **un processus Kimono HTTP, un ROOT et un cache persistant**, avec
plusieurs sessions MCP sur cette instance. Agents et humains partagent alors
le même arbre de travail et les connaissances, plutôt que des clones divergents.

- Les opérations d'outils passant par la file du runtime sont sérialisées entre
  sessions ; les lectures/ressources indépendantes ne constituent pas des
  transactions globales. Une indexation longue peut retarder les travaux en
  attente. La consultation du `status` sémantique contourne cette file.
- Commencer un snapshot avant la recherche et réutiliser son identifiant pour
  toutes les lectures. Une synchronisation ultérieure ne modifie jamais cet
  instantané ; le terminer explicitement.
- Éditions, commits, pushes, merges et créations de branches sont hors MCP,
  même avec l'ancien paramètre `AIKIDO_WRITABLE=true`. Les agents utilisent
  leurs outils Git puis demandent une synchronisation explicite.
- Les éditeurs externes contournent la file Kimono. Ne pas éditer le dossier
  partagé pendant la publication ; la synchronisation refuse d'écraser une
  source modifiée pendant sa préparation.

Tous les membres autorisés voient les mêmes connaissances, y compris celles
d'un dépôt privé récupérées avec l'autorisation d'un membre. Les identifiants
Git restent personnels et limités à la requête ; la plateforme contrôle les droits.

**Ne jamais partager un cache entre processus indépendants.** Des caches
distincts évitent les collisions d'index, pas les écritures concurrentes sur un
ROOT commun.

## Intégration dans Tatami ou une autre plateforme

Topologie recommandée : **une instance par projet**, hors des espaces utilisateurs.
Tatami expose une URL commune aux membres autorisés, avec jetons MCP personnels
et connexions Git résolues uniquement pour la requête de synchronisation.

```text
Clients -> authentification/autorisation plateforme -> Kimono du workspace
                                                      |-- ROOT monté
                                                      `-- cache privé persistant
```

Le gestionnaire de la plateforme doit créer/démarrer/arrêter les instances,
vérifier les associations aux projets, router les sessions MCP, gérer secrets
et quotas, puis conserver/supprimer les données selon le cycle de vie du projet.
Monter uniquement le workspace choisi, adapter UID/GID, séparer jetons/caches et
éviter les ports de conteneur publics. Même avec `/knowledge` dans chaque
conteneur, les caches doivent rester distincts. Les couches image/modèle peuvent
être communes sur disque ; mémoire d'inférence et CPU ne sont pas mutualisés.

Kimono fournit déjà les points d'intégration côté serveur :

| Endpoint / action | Rôle |
| --- | --- |
| `GET /healthz` | Vivacité minimale publique |
| `GET /readyz` | ROOT disponible, authentification ; 503 si indisponible/en arrêt |
| `GET /statusz` | État/erreurs du ROOT et de l'index sémantique, authentification |
| `aikido_index` : `{"operation":"status","mode":"semantic"}` | Progression en mémoire non bloquante, sans inférence |
| SIGTERM / SIGINT | Termine les appels/réponses acceptés ; délai de 30 secondes |

La disponibilité du ROOT ne signifie pas que l'index sémantique est construit.
Pré-indexer les bases importantes ou prévoir un délai client suffisant ;
la progression compte les chunks modifiés embeddés, pas toute la préparation/
sauvegarde. Accorder plus de 30 secondes à l'arrêt du conteneur (40 dans Compose).
Après redémarrage, la recherche suivante valide/réutilise l'index persistant ;
les clients MCP doivent se reconnecter et créer de nouvelles sessions.

**Kimono ne provisionne ni ne route les instances de plateforme** ; le
gestionnaire dynamique Tatami reste une étape d'intégration distincte.
Kimono n'est pas actuellement un serveur multi-tenant acceptant des chemins
de projets arbitraires dans un même processus.

### Comptes Git et rotation

Configurer `KIMONO_GIT_PROFILE_FILE` avec le chemin d'un fichier JSON privé hors
ROOT (0600/0400, lisible par le runner). Il contient `transport` (`ssh` ou
`https`), `host`, `username`, `secret` et, pour SSH,
`knownHosts` avec les clés serveur vérifiées. Voir le
[schéma et l'exemple Compose](../README.md#dynamic-per-instance-git-profile).
La plateforme récupère les identifiants du compte autorisé et fournit ce fichier ;
ne jamais placer clés privées ou jetons dans les arguments MCP ou le dépôt.
Monter son répertoire en lecture seule et remplacer le fichier atomiquement
pour la rotation. Les commandes Git le relisent sans redémarrage ; les commandes
en cours gardent leur instantané. Les fichiers temporaires sont nettoyés ;
utiliser un tmpfs `/tmp` privé en cas d'arrêt brutal du conteneur.

SSH utilise la clé choisie (sans passphrase/agent), vérifie strictement le
serveur et utilise le port 22 ; HTTPS utilise un jeton sur le port 443, sans
redirection. Autres serveurs, transports, ports et dépôts distants par chemin
local sont refusés dans ce mode. Le fichier concerne le stdio autonome.
En HTTP partagé, chaque requête reçoit son propre profil après authentification,
sans fichier global ni réutilisation du profil d'un autre membre. Sans profil,
l'accès est anonyme ; un profil configuré invalide provoque une erreur explicite.
Commit et push ne sont jamais des opérations MCP.

Configuration, protections et limites : voir le
[contrat d'intégration du README](../README.md#integration-with-per-workspace-instance-managers).
