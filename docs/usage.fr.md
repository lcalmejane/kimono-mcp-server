# Kimono : usage autonome et base de connaissance partagée

[README](../README.md) · [English version](usage.en.md)

## Ce que fournit Kimono

Kimono expose un ROOT AI-KIDO par MCP : documents, commandes, agents/personas,
skills et workflows. Des humains utilisant un client MCP et des agents connectés
peuvent retrouver les mêmes instructions, les rechercher et agir sur un projet
autorisé. Aucun chat ni LLM n'est embarqué : `activate` / `execute` chargent des
instructions pour le client, sans exécuter un workflow autonome dans le serveur.

| Besoin | Outil MCP |
| --- | --- |
| Découvrir/lire/activer les connaissances | `aikido`, ressources et prompts |
| Initialiser le ROOT configuré depuis un Git officiel/personnalisé | `aikido_root` |
| Recherche littérale, regex, sémantique ou par vecteur existant | `aikido_search` |
| Embeddings locaux et informations exactes sur le modèle actif | `aikido_embed` |
| Maintenir les index / suivre l'indexation sémantique | `aikido_index` |
| Éditer les documents / effectuer des opérations Git structurées | `aikido_file`, `aikido_git` |

L'inférence sémantique est locale, avec E5 multilingue et ONNX Runtime.
`aikido_embed` avec `{"operation":"info"}` retourne l'identifiant du modèle actif,
ses paramètres et les empreintes de ses fichiers. Une recherche vectorielle
exige cet identifiant ; le client reste responsable de la compatibilité réelle
du vecteur et de son prétraitement. Voir la
[référence complète](../README.md#local-semantic-search).

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
- Les recherches synchronisent l'index avant interrogation : ajouts,
  modifications et suppressions terminés avant la requête sont pris en compte,
  y compris les éditions externes. Seuls les chunks modifiés sont ré-embeddés.
  Ce mécanisme est à la demande, pas un watcher permanent.
- Une modification/suppression via `aikido_file` exige le contenu précédent
  exact dans `expected`. En cas de conflit, relire et réconcilier ; ne pas
  réessayer aveuglément l'écriture.
- Plusieurs appels **ne forment pas une transaction** : les séquences
  édition/add/commit de deux clients peuvent s'entrelacer. Index Git, branches
  et arbre de travail sont communs. Désigner un seul coordinateur Git pour un
  ROOT partagé en écriture, ou séparer les workspaces des agents indépendants.
- Éditeurs et processus Git externes contournent la file Kimono. Il n'existe
  ni verrou distribué, ni fusion collaborative du texte, ni rôles par client,
  ni attribution automatique des commits à chaque humain. `confirm=true`
  repose sur l'approbation explicite côté client, pas sur un écran serveur.

Le partage en lecture seule est la forme la plus simple de service centralisé.
L'écriture est réservée aux projets/forks de confiance et aux clients autorisés :
activer `AIKIDO_WRITABLE=true` et un montage inscriptible. L'origine officielle
AI-KIDO reste protégée. Tous les détenteurs du jeton HTTP ont les mêmes droits
sur l'instance ; les specs privées sont exclues par défaut, mais l'accès Git
n'est pas filtré par les exclusions de recherche. L'API Git n'est pas une sandbox.

**Ne jamais partager un cache entre processus indépendants.** Des caches
distincts évitent les collisions d'index, pas les écritures concurrentes sur un
ROOT commun. Pour isoler les écritures, séparer aussi les clones/workspaces.

## Intégration dans Tatami ou une autre plateforme

Topologie recommandée : **une instance par workspace autorisé** ; dans
l'organisation actuelle de Tatami, il s'agit du couple `(utilisateur, projet)`.
Plusieurs clients peuvent partager cette instance s'ils ont les mêmes droits.

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

Configuration, protections et limites : voir le
[contrat d'intégration du README](../README.md#integration-with-per-workspace-instance-managers).
