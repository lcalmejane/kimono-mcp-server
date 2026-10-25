# Référence de recherche MCP

[English version](retrieval.md) · [README du projet](../README.fr.md)

La recherche Kimono est progressive : créer un snapshot cohérent, rechercher
des emplacements, puis lire explicitement les seuls passages utiles. Par défaut,
la recherche compacte ne renvoie aucun texte source.

## Cycle de vie d'un snapshot

Commencer chaque recherche en plusieurs appels avec `aikido_snapshot` :

```json
{"operation":"begin"}
```

Transmettre le `snapshotId` retourné à chaque requête `aikido_search` et
`aikido_file`. Terminer le snapshot avec :

```json
{"operation":"end","snapshotId":"<snapshot-id>"}
```

Un snapshot fige le corpus afin que les recherches et lectures utilisent les
mêmes fichiers, même si les sources changent. En ouvrir un nouveau pour voir les
modifications. Les snapshots expirent après 15 minutes. Par défaut, 8 snapshots
peuvent être actifs ; les budgets d'octets globaux et par snapshot dépendent du
mode. `begin` accepte des `paths` relatifs au ROOT pour ne capturer que certains
fichiers ou répertoires. La réponse indique les limites effectives.

## Rechercher

`aikido_search` prend en charge les modes `text`, `semantic`, `hybrid`,
`literal`, `regex` et la recherche par vecteur existant. `hybrid` combine les
résultats lexicaux et sémantiques. `aikido` avec `operation: "search"` prend
également en charge ce contrat.

Une seule requête :

```json
{
  "snapshotId":"<snapshot-id>",
  "mode":"hybrid",
  "query":"configuration des snapshots",
  "limit":5
}
```

Ou plusieurs requêtes indépendantes regroupées :

```json
{
  "snapshotId":"<snapshot-id>",
  "mode":"text",
  "queries":["règles d'exclusion","configuration des snapshots","limites de taille"],
  "limit":5,
  "maxBytes":16384
}
```

`queries` accepte de 1 à 20 chaînes, chacune limitée à 8192 octets UTF-8. Les
requêtes d'un lot partagent le snapshot, le mode, les filtres, la limite de
résultats et le budget d'octets. Le serveur les exécute séquentiellement. La
réponse `searches` contient une entrée par requête terminée : `results: []`
signifie qu'aucun résultat ne correspond ; une erreur est indiquée séparément
et n'interrompt pas les autres requêtes.

Par défaut, `detail=compact` renvoie les chemins, les plages de lignes inclusives
et le `snapshotId` :

```json
{
  "results":[
    {"path":"src/index.ts","ranges":[[24,31],[48,50]]}
  ],
  "snapshotId":"<snapshot-id>"
}
```

Les résultats compacts ne contiennent pas de texte source. `detail=locations`
ajoute les diagnostics de recherche ; `detail=excerpts` inclut explicitement
des extraits pour le diagnostic.

Par défaut, une réponse de recherche est limitée à 16 Kio de JSON sérialisé.
Pour une recherche unique, le budget est configurable de 2048 octets à 256 Kio ;
un lot exige au moins 4096 octets. Si un lot est tronqué avant l'exécution de
toutes ses requêtes, la réponse contient `nextQuery`, l'index de la prochaine
requête à reprendre (indexation à partir de zéro) avec le même snapshot et les
mêmes options. Si une recherche individuelle omet des résultats, son indicateur
`truncated` s'applique à cette requête ; affiner la recherche ou ajuster son
budget. La reprise d'un lot ne récupère pas les résultats omis d'une requête
déjà exécutée.

## Lire les passages sélectionnés

Regrouper les plages pertinentes obtenues par recherche dans un seul appel
`aikido_file` :

```json
{
  "operation":"ranges",
  "snapshotId":"<snapshot-id>",
  "contextLines":1,
  "ranges":[
    {"path":"src/index.ts","startLine":24,"endLine":31},
    {"path":"src/config.ts","startLine":90,"endLine":95}
  ],
  "maxBytes":16384
}
```

Les plages sont inclusives et numérotées à partir de 1. Jusqu'à 50 plages
peuvent être demandées dans plusieurs fichiers ; les plages qui se chevauchent
ou sont adjacentes sont fusionnées dans chaque fichier. `contextLines` accepte
de 0 à 20 lignes et vaut 0 par défaut. Si le budget tronque la réponse, le champ
`remaining` indique les plages non retournées. Les chemins inconnus ou illisibles
sont indiqués dans `errors`.

Autres opérations de lecture :

```json
{"operation":"metadata","snapshotId":"<snapshot-id>","path":"src/index.ts"}
{"operation":"outline","snapshotId":"<snapshot-id>","path":"docs/guide.md"}
{"operation":"read","snapshotId":"<snapshot-id>","path":"docs/guide.md","section":"Configuration"}
{"operation":"read","snapshotId":"<snapshot-id>","path":"src/index.ts","startLine":24,"endLine":31}
```

Les numéros de lignes commencent à 1. `outline` renvoie les titres Markdown et
leurs plages. La lecture d'une section inclut ses sous-sections jusqu'au titre
suivant de même niveau ou de niveau supérieur. La lecture complète d'un fichier
est explicite ; elle n'est jamais un repli automatique de la recherche. En cas
de troncature, suivre `nextLine` et `remaining`.

## Filtres et limites du corpus

Les filtres sont appliqués avant la limite de résultats. `pathPrefix` sélectionne
un fichier relatif ou un sous-arbre de répertoire ; ce n'est pas un motif glob.
En mode AI-KIDO, `scope=memory` sélectionne la base de connaissances et
`scope=code` son complément. Les filtres `kind`, `type` et extension restreignent
les documents éligibles. Les opérations de liste `aikido` acceptent des filtres
et une pagination ; suivre `nextOffset`.

Les `.gitignore` racine et imbriqués et les exclusions intégrées s'appliquent à
la découverte, aux snapshots, à la recherche et à la lecture. Aucun chemin hors
du ROOT n'est accepté. Les identifiants secrets, les dépendances, les répertoires
de build/cache et les liens symboliques sont exclus. Voir le [guide RAG local](local-rag.fr.md)
pour la politique de corpus et les limites de fichiers.

## Conseils pour les clients

Les clients doivent vérifier `isError` dans la réponse MCP, analyser le JSON,
conserver `snapshotId`, `truncated`, `nextQuery`, `nextLine` et `remaining`, et
ne récupérer le texte complet que pour les passages sélectionnés. Regrouper les
requêtes et lectures indépendantes réduit les allers-retours. Les résultats
observés en entrée Copilot et temps écoulé figurent dans le
[benchmark actuel](../benchmarks/results/current.md).
