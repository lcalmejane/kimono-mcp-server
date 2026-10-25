# Utiliser Kimono

[English version](usage.en.md) · [README du projet](../README.fr.md)

Kimono propose deux modes de corpus via MCP :

- **RAG** est le mode par défaut pour le code source et la documentation de
  tout projet pris en charge. Il indexe localement les fichiers éligibles et
  fournit une recherche en lecture seule.
- **AI-KIDO** s'adresse à une base de connaissances contenant
  `prompts/index.md` ou `index.md`. Il ajoute la découverte des connaissances,
  l'activation explicite des consignes et les opérations de collaboration
  AI-KIDO.

Dans les deux modes, les résultats indiquent d'abord les emplacements, puis le
client peut demander le texte des extraits utiles. L'indexation est locale,
mais un client MCP peut transmettre les extraits au fournisseur de son modèle.

Le benchmark Copilot actuel avec Gemini 3.8 Flash mesure 67,5 % d'entrée
cumulée en moins et 28,9 % de temps en moins pour une recherche dans le dépôt,
puis 71,4 % d'entrée cumulée en moins et 52,0 % de temps en moins pour préparer
un plan `maxDepth`. Voir les [résultats du benchmark](../benchmarks/results/current.md).

## Choisir un mode

Choisir le mode dans la configuration du client ou du serveur :

| Configuration | RAG | AI-KIDO |
| --- | --- | --- |
| Variable d'environnement | `KIMONO_CORPUS_MODE=rag` | `KIMONO_CORPUS_MODE=aikido` |
| CLI | `--corpus-mode rag` | `--corpus-mode aikido` |
| VS Code | `kimono.corpusMode: "rag"` | `kimono.corpusMode: "aikido"` |

RAG est le mode par défaut. La présence d'un index AI-KIDO ne sélectionne pas
automatiquement ce mode.

## Rechercher et lire

Pour plusieurs étapes de recherche cohérentes, commencer un snapshot immuable
et réutiliser son identifiant pour chaque recherche et lecture :

1. Appeler `aikido_snapshot` avec `{"operation":"begin"}`.
2. Appeler `aikido_search` avec le `snapshotId` retourné. Utiliser `text` pour
   une recherche lexicale, `semantic` pour une recherche par sens ou `hybrid`
   pour combiner les deux.
3. Lire les plages sélectionnées avec `aikido_file` et
   `operation: "ranges"`.
4. Appeler `aikido_snapshot` avec
   `{"operation":"end","snapshotId":"..."}`.

Par défaut, la recherche renvoie les chemins et plages de lignes inclusives,
sans texte source. Regrouper les requêtes indépendantes dans un appel de
recherche et les plages retenues dans un seul appel de lecture. Un snapshot est
immuable ; en créer un nouveau pour voir les changements de fichiers. La
[référence de recherche](retrieval.fr.md) décrit les requêtes, budgets et
reprises de résultats tronqués.

## Opérations de connaissances AI-KIDO

Le mode AI-KIDO permet de lister et rechercher les connaissances, lire des
documents et activer explicitement des consignes ou workflows pour l'assistant
connecté. `activate` renvoie les instructions au client ; il ne lance pas de
modèle ni de workflow autonome sur le serveur.

`aikido_index` maintient les index lexicaux et sémantiques. Utiliser
`{"operation":"status","mode":"semantic"}` pour consulter la progression de
l'index sémantique. L'index reste local et peut être reconstruit depuis le ROOT.

Pour travailler sur plusieurs copies d'une base AI-KIDO,
`aikido_collaboration` propose les opérations explicites d'état, de comparaison,
de lecture d'une révision et de publication. Vérifier la version partagée avant
les modifications, examiner les conflits et ne publier qu'avec la version
attendue. La collaboration n'effectue aucun commit ni push Git.

L'outil `aikido_git` fournit les informations du dépôt et une synchronisation
distante en lecture seule après configuration explicite d'une cible. Il
n'effectue ni commit, ni push, ni merge, ni création de branche. Les opérations
Git locales restent à la charge du client.

## Construire un serveur stdio local

Pour un client compatible avec MCP stdio, compiler Kimono et ses moteurs de
recherche natifs depuis les sources. Suivre les
[étapes de construction native](local-rag.fr.md#serveur-natif-depuis-les-sources),
puis configurer le client pour lancer :

```sh
AIKIDO_ROOT=/absolute/path/to/project KIMONO_CORPUS_MODE=rag node dist/cli.js serve
```

Utiliser `KIMONO_CORPUS_MODE=aikido` et un ROOT AI-KIDO pour activer les
opérations AI-KIDO. Les intégrations directes adaptées à certains outils CLI
LLM sont prévues. Pour les IDE qui acceptent les extensions du Visual Studio
Marketplace, installer l'[extension Kimono](../vscode/README.fr.md).

## Servir plusieurs clients

Un serveur MCP HTTP peut fournir un corpus partagé à plusieurs sessions clientes.
Configurer un jeton bearer autorisé et connecter les clients à son endpoint
`/mcp`. Utiliser loopback en local ; un accès distant nécessite TLS et un
reverse proxy authentifié. Chaque processus de serveur indépendant doit avoir
son propre cache. Le [guide de distribution](vscode-distribution.fr.md) décrit
la construction de l'extension VS Code ; le README détaille la configuration du
serveur, l'image GHCR publiée et son utilisation avec GitHub Copilot cloud
agent ([français](../README.fr.md), [English](../README.md)).

## Limites et confidentialité

Kimono indexe les fichiers sélectionnés par la politique du corpus ; il ne
détecte pas les secrets et n'applique pas de contrôle d'accès par fichier.
L'indexation locale ne garantit pas que les contenus récupérés restent locaux :
le client MCP décide des extraits transmis au fournisseur de son modèle.
Vérifier les fichiers inclus et ne pas placer de secrets dans le corpus.
