# Guide RAG local

[English version](local-rag.md) · [README du projet](../README.fr.md)

Ce guide décrit les modes disponibles, les fichiers indexés et la configuration
d'un client MCP.

## Choisir un mode

| Mode | À choisir pour | Corpus |
| --- | --- | --- |
| `rag` (défaut) | Rechercher dans le code et la documentation d'un projet courant | Fichiers source et documentation UTF-8 éligibles ; aucune structure AI-KIDO requise |
| `aikido` | Exploiter une base de connaissances AI-KIDO existante | Nécessite `prompts/index.md` ou `index.md` dans le ROOT configuré |

RAG effectue une recherche locale en lecture seule. Kimono découvre les fichiers
éligibles, crée des index lexicaux et sémantiques et expose des outils MCP de
recherche et de lecture. Il ne modifie pas les fichiers du projet et n'effectue
pas de publication ni de collaboration AI-KIDO.

Le mode AI-KIDO ajoute la découverte structurée des connaissances et leur
activation, ainsi que les opérations explicites de publication, comparaison et
synchronisation Git existantes. Elles ne sont exécutées que sur demande.
Kimono n'est ni un éditeur, ni une interface de chat, ni un agent de
programmation autonome, ni un outil de commit/push Git.

Configurer le mode du corpus dans le client ou le serveur :

| Client | RAG | AI-KIDO |
| --- | --- | --- |
| VS Code | `kimono.corpusMode: "rag"` (défaut) | `kimono.corpusMode: "aikido"` |
| Environnement | `KIMONO_CORPUS_MODE=rag` (défaut) | `KIMONO_CORPUS_MODE=aikido` |
| CLI | `--corpus-mode rag` (défaut) | `--corpus-mode aikido` |

La présence d'un index AI-KIDO dans le dépôt ne change pas automatiquement le
mode.

## Fichiers indexés

Kimono indexe les fichiers texte correspondant à la liste d'extensions du mode.
RAG prend en charge des formats courants de code, documentation, build et
configuration, notamment TypeScript/JavaScript, Python, Java, Go, Rust, PHP,
C/C++, C#, Swift, SQL, HTML/CSS et shell. La liste AI-KIDO est plus limitée et
orientée documentation. Les valeurs exactes se trouvent dans
[`src/corpus-config.ts`](../src/corpus-config.ts).

Les deux modes respectent les `.gitignore` racine et imbriqués. Dépendances,
sorties de build, caches, répertoires de secrets, liens symboliques et fichiers
binaires sont exclus. Les exclusions intégrées ne peuvent pas être annulées par
un motif d'inclusion. Kimono ne recherche pas les secrets dans les contenus :
vérifier les fichiers du corpus avant l'indexation.

L'indexation et la création des embeddings s'exécutent localement avec le moteur
lexical intégré et le modèle d'embeddings multilingue. Aucune API d'embeddings
externe n'est appelée. Le client de chat peut néanmoins transmettre les extraits
retournés par MCP au fournisseur de modèle qu'il utilise. L'indexation locale
ne garantit donc pas que toutes les données restent sur l'appareil.

## Résultats de recherche

Par défaut, la recherche renvoie un résultat compact : chemins, plages de lignes
et identifiant du snapshot, sans le contenu des fichiers. L'assistant peut
demander explicitement uniquement les lignes utiles. Cela évite de charger dans
la conversation le contenu sans rapport avec la recherche et peut réduire les
allers-retours lorsque les recherches et lectures sont regroupées.

Pour effectuer une recherche en plusieurs étapes de manière cohérente :

1. Démarrer un snapshot avec `aikido_snapshot` (`operation: "begin"`).
2. Rechercher dans ce snapshot avec `aikido_search` ; utiliser `text` pour les
   termes exacts ou `hybrid` pour combiner recherche lexicale et sémantique.
3. Lire les plages utiles en un appel `aikido_file`
   (`operation: "ranges"`).
4. Terminer le snapshot avec `aikido_snapshot` (`operation: "end"`).

Le snapshot maintient la recherche et les lectures sur le même corpus capturé.
Il n'est pas mis à jour quand les fichiers changent ; créer un nouveau snapshot
pour voir les modifications. La [référence de recherche](retrieval.fr.md)
détaille les requêtes, limites et paginations.

### Utilisation des tokens

Le benchmark actuel compare la recherche Copilot standard (`grep`, `glob`,
`view`) au RAG lexical local de Kimono, avec recherches groupées et lectures de
plages de lignes ciblées. Avec Gemini 3.8 Flash dans Copilot CLI 1.0.103, la
recherche dans le dépôt mesure 323 368 → 105 223 tokens d'entrée cumulée
(−67,5 %) et 111,212 → 79,077 secondes (−28,9 %). La préparation d'un plan
d'implémentation `maxDepth` mesure 454 796 → 130 244 tokens d'entrée cumulée
(−71,4 %) et 175,224 → 84,034 secondes (−52,0 %). Voir les
[résultats du benchmark](../benchmarks/results/current.md).

## Installer et connecter

### VS Code et IDE compatibles

Installer [Kimono RAG MCP depuis le Visual Studio
Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp),
ou télécharger le VSIX correspondant à la plateforme depuis les
[GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases).
L'extension nécessite VS Code 1.106 ou ultérieur et fournit un serveur MCP local
intégré. Les IDE basés sur VS Code peuvent aussi l'utiliser s'ils prennent en
charge les extensions du Visual Studio Marketplace ; la disponibilité dépend
des extensions et du Marketplace configuré par chaque IDE. Accorder la confiance
à l'espace de travail et activer les outils Kimono dans le client MCP.
**Kimono: Open Management Panel** permet de configurer le corpus et de suivre
l'index. Voir le [guide VS Code](../vscode/README.fr.md).

### Serveur Docker

Utiliser [Docker Compose](../README.fr.md#lancer-un-serveur-docker-compose-partagé)
ou l'image Docker publiée pour démarrer un serveur MCP HTTP authentifié. C'est
l'option recommandée lorsque plusieurs clients doivent partager le même corpus
et le même index.

L'image est publiée dans le
[GitHub Container Registry](https://github.com/lcalmejane/kimono-mcp-server/pkgs/container/kimono-mcp-server)
pour Linux AMD64 et ARM64. Le
[workflow de publication](../.github/workflows/publish-container.yml) s'exécute
à chaque tag `v*` et publie le tag de version ainsi que `latest`. Figer le tag
de version pour un déploiement stable ; `latest` suit la dernière version.

### GitHub Copilot cloud agent

GitHub Copilot cloud agent peut se connecter à un serveur MCP HTTP distant.
Pour utiliser l'image publiée, la déployer sur un hôte accessible par GitHub en
HTTPS, y monter ou synchroniser le dépôt à indexer, et définir `AIKIDO_ROOT`
sur ce checkout. L'image GHCR n'est pas un endpoint déjà démarré et un serveur
distant n'accède pas automatiquement à l'espace de travail temporaire de l'agent.

Dans le dépôt, ouvrir **Settings → Copilot → coding agent → MCP configuration**,
configurer l'endpoint HTTPS `/mcp` et enregistrer son jeton dans un secret
Agents nommé `COPILOT_MCP_AUTH_TOKEN` :

```json
{
  "mcpServers": {
    "kimono": {
      "type": "http",
      "url": "https://kimono.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${COPILOT_MCP_AUTH_TOKEN}"
      },
      "tools": ["aikido_snapshot", "aikido_search", "aikido_file", "aikido_index"]
    }
  }
}
```

La configuration MCP permet de n'activer que les outils utiles à l'agent.
L'endpoint doit être accessible depuis GitHub et protégé par HTTPS et
authentification ; Compose local écoute sur loopback et ne peut pas être utilisé
directement par l'agent cloud. Voir le
[guide GitHub de configuration MCP](https://docs.github.com/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

### Serveur natif depuis les sources

Pour démarrer un serveur MCP stdio local sans Docker, compiler le serveur et
les moteurs natifs depuis les sources. Node.js 24 ou ultérieur et Rust/Cargo
sont requis pour les moteurs natifs. Cet exemple cible Linux x64 ; choisir la
cible et la bibliothèque ONNX indiquées dans le `manifest.json` du bundle :

```sh
npm ci
npm run build
npm run bundle:native -- --target linux-x64 --output native-bundles/linux-x64
export FGR_BIN="$PWD/native-bundles/linux-x64/bin/fgr"
export KIMONO_SEMANTIC_BIN="$PWD/native-bundles/linux-x64/bin/kimono-semantic"
export KIMONO_MODEL_DIR="$PWD/native-bundles/linux-x64/model"
export ORT_DYLIB_PATH="$PWD/native-bundles/linux-x64/lib/libonnxruntime.so"
AIKIDO_ROOT=/absolute/path/to/project \
KIMONO_CORPUS_MODE=rag \
node dist/cli.js serve
```

Configurer le client MCP pour lancer cette commande avec le même environnement.
Définir `KIMONO_CORPUS_MODE=aikido` pour une base AI-KIDO. Les intégrations
directes adaptées à certains outils CLI LLM sont prévues dans la roadmap ;
l'utilisation actuelle passe par un client compatible MCP.

## Configurer le corpus

Un hôte ou administrateur de confiance peut fournir un chemin JSON absolu avec
`KIMONO_CONFIG_FILE`, `--config` dans la CLI ou le paramètre VS Code
`kimono.configFile`. Les fichiers de configuration ne sont jamais découverts
automatiquement dans le projet. Redémarrer le serveur après une modification.

```json
{
  "mode": "rag",
  "extensions": [".md", ".ts", ".tsx", ".js", ".py", ".go", ".rs"],
  "include": ["src/**", "docs/**", "README.md"],
  "exclude": ["**/*.generated.*", "**/fixtures/**"],
  "maxFileBytes": 4194304,
  "maxFiles": 100000,
  "maxCorpusBytes": 536870912
}
```

Tous les champs sont facultatifs. `extensions` remplace la liste d'extensions
par défaut ; `include` et `exclude` sont des motifs glob relatifs au ROOT. Les
règles d'exclusion, `.gitignore` et filtres de sécurité intégrés restent
applicables. Une configuration invalide renvoie une erreur au lieu d'être
ignorée.

Limites RAG par défaut : 4 Mio par fichier, 100 000 fichiers et 512 Mio par
corpus. Un snapshot peut contenir 256 Mio ; jusqu'à 8 snapshots partagent un
budget de 512 Mio et expirent après 15 minutes. Ce sont des limites de
protection, pas des garanties de performance. Les grands index sémantiques
nécessitent du disque, de la mémoire et du temps pour le premier calcul des
embeddings. Restreindre le corpus avant d'augmenter les limites.

## Dépannage

| Problème | Vérification |
| --- | --- |
| Aucun résultat | Vérifier le ROOT, le mode, la liste de fichiers, les règles `.gitignore`, motifs d'inclusion et limites de taille. |
| Erreur de point d'entrée AI-KIDO | Choisir RAG pour un projet courant ou ajouter le point d'entrée AI-KIDO au corpus. |
| Recherche sémantique indisponible | Interroger `aikido_index` avec `operation: "status"` et `mode: "semantic"` ; éviter de répéter à l'identique une recherche en échec. |
| Résultats anciens après modification | Ouvrir un nouveau snapshot ; les snapshots existants restent immuables. |
| Indexation lente ou gourmande en mémoire | Restreindre le corpus ou créer un snapshot ciblé avant d'augmenter les limites. |
| Extension impossible à démarrer | Accorder la confiance à l'espace de travail, consulter la sortie MCP de VS Code et vérifier que l'hôte possède un paquet compatible. |
| Le serveur distant utilise un autre corpus | Le ROOT, le mode et la politique sont configurés sur le serveur distant. |

### Sécurité et limites

Kimono indexe les fichiers autorisés par la politique du corpus ; il n'est ni
un bac à sable, ni un détecteur de secrets, ni un parseur de code, ni un système
de contrôle d'accès. Le client détermine les outils MCP activés et les extraits
envoyés à son fournisseur de modèle. Garder les fichiers de configuration privée
et les caches hors du dépôt.
