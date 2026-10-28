# Guide RAG local

[English version](local-rag.md) · [README du projet](../README.fr.md)

Ce guide décrit les modes disponibles, les fichiers indexés et la configuration
d'un client MCP.

## Choisir un mode

| Mode | À choisir pour | Corpus |
| --- | --- | --- |
| `rag` (défaut) | Rechercher dans le code et la documentation d'un projet courant | Code, documentation, texte Office/PDF et métadonnées des fichiers ; aucune structure AI-KIDO requise |
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

Kimono indexe les contenus texte correspondant à la liste d'extensions du mode.
RAG prend en charge des formats courants de code, documentation, build et
configuration, notamment TypeScript/JavaScript, Python, Java, Go, Rust, PHP,
C/C++, C#, Swift, SQL, HTML/CSS et shell. La liste AI-KIDO est plus limitée et
orientée documentation. Les valeurs exactes se trouvent dans
[`src/corpus-config.ts`](../src/corpus-config.ts).

Les deux modes respectent les `.gitignore` racine et imbriqués. Dépendances,
sorties de build, caches, répertoires de secrets et liens symboliques sont
exclus. Les exclusions intégrées ne peuvent pas être annulées par
un motif d'inclusion. Kimono ne recherche pas les secrets dans les contenus :
vérifier les fichiers du corpus avant l'indexation.

### Documents Office et PDF

| Format | Représentation recherchable |
| --- | --- |
| `.xlsx` | Une ligne de feuille remplie par ligne de texte, avec le nom de feuille et les adresses A1, par exemple `Coûts!A5=Budget \| B5=42`. Extraction des chaînes partagées, chaînes inline et valeurs enregistrées ; les formules sans résultat restent du texte de formule. |
| `.docx` | Paragraphes dans l'ordre du document, y compris le texte des cellules des tableaux. |
| `.pptx` | Paragraphes et cellules des tableaux dans l'ordre des diapositives, préfixés par `Slide N:`. Les notes du présentateur et le texte dans les images ne sont pas extraits. |
| `.pdf` | Texte extrait dans l'ordre de lecture par `pdftotext` de Poppler. |

Ces formats sont activés par défaut en RAG. En mode AI-KIDO, leur extraction
est activée explicitement dans la configuration `extensions` de l'hôte.
L'extraction Office s'exécute localement dans Node.js, sans exécuter de formule
ni de macro. Le PDF nécessite `pdftotext` dans le PATH du serveur. Docker inclut
Poppler ; pour un serveur natif ou un hôte d'extension, utiliser
`brew install poppler` sur macOS ou `sudo apt-get install poppler-utils` sur
Debian/Ubuntu. Les PDF numérisés nécessitent un OCR hors Kimono pour rechercher
leur contenu.

Les archives et le texte extrait sont bornés. `maxFileBytes` limite le document
source et son texte extrait ; les archives Office sont aussi limitées à 32 Mio
décompressés et 4 096 entrées. Les numéros de lignes désignent la représentation
extraite. Les snapshots figent ce texte sans modifier les originaux. Les
originaux Office/PDF sont exclus de la publication textuelle et de la
synchronisation distante AI-KIDO.

### Métadonnées lorsque le contenu est indisponible

En RAG, un fichier reste trouvable si son extension n'est pas prise en charge
ou si son contenu est binaire, trop volumineux, illisible ou impossible à
extraire. Kimono indexe le nom, le chemin relatif au ROOT, l'extension, la taille
et la date de dernière modification disponibles. Les résultats portent
`contentStatus: "metadata-only"` ; les lectures renvoient explicitement les
métadonnées et la raison, pas un faux contenu documentaire. Ces métadonnées sont
conservées dans les snapshots et indexées en recherche lexicale et sémantique.
Les valeurs système indisponibles sont signalées comme telles.

Les échecs de lecture du contenu sont tracés sur stderr et dans l'état du corpus
(`metadataOnly`, `skipped`, `skippedFiles`). Les chemins exclus, fichiers ignorés,
secrets et liens symboliques ne sont pas catalogués. `extensions` sélectionne
les contenus à lire ; `include`/`exclude` contrôle les chemins qui peuvent
apparaître. AI-KIDO conserve sa liste de fichiers plus restreinte.
Si un passage ne peut pas être vectorisé, `skippedChunks` le signale et la base
de l'index sémantique est marquée partielle ; la recherche lexicale et les
métadonnées restent disponibles.

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

## Moteur d'embedding et mémoire

Par défaut, `KIMONO_SEMANTIC_DEVICE=auto` compare le CPU et chaque fournisseur
CUDA/CoreML disponible au premier usage du modèle par le serveur. Chaque test
s'exécute dans un processus séparé : même modèle local, échauffement avec des
lots courts et longs, puis trois essais identiques courts/longs. Le temps médian
de vectorisation le plus bas détermine le choix. Les processus de test se
terminent avant l'indexation et libèrent leurs sessions de modèle. Un test en
échec ou expiré est signalé explicitement et exclu ; si aucun ne réussit,
l'opération échoue. Chaque test dispose d'un délai maximal de 30 secondes.

Le choix et les mesures sont réutilisés en mémoire pour les opérations et les
snapshots suivants du même processus serveur Kimono. Redémarrer le serveur pour
refaire la mesure après un changement de matériel, de runtime ou de modèle au
même chemin. `aikido_index`, `aikido_embed`, les informations du modèle et le
statut partagé exposent `runtime.executionProvider`, `runtime.benchmarks` et les
paramètres workers/threads/lot. Le panneau affiche le fournisseur choisi et les
temps mesurés.

| Variable d'environnement | Défaut | Signification |
| --- | --- | --- |
| `KIMONO_SEMANTIC_DEVICE` | `auto` | Comparer puis sélectionner, ou imposer `cpu`, `cuda` ou `coreml`. |
| `KIMONO_SEMANTIC_WORKERS` | `1` | Sessions CPU du modèle (1–32) ; les fournisseurs accélérés utilisent une session. |
| `KIMONO_SEMANTIC_THREADS` | `auto` | 1–2 threads par session selon les CPU disponibles ; réglage explicite 1–32. |
| `KIMONO_SEMANTIC_BATCH` | `8` | Passages par lot (1–256). |

CUDA nécessite un runtime ONNX contenant ce fournisseur et des pilotes GPU
compatibles ; les bundles Linux/Windows standards contiennent un runtime CPU.
CoreML est testé lorsqu'il est disponible dans le runtime macOS, avec les unités
CPU/GPU activées. Si un fournisseur imposé ne peut pas être enregistré,
l'opération échoue au lieu de basculer silencieusement sur le CPU. Un fournisseur
enregistré et son chronométrage ne prouvent pas l'exécution matérielle sur GPU :
`gpuExecutionVerified` reste à `false`.

L'extension autonome expose `kimono.semanticDevice` ; Tatami Agent expose
`tatami.kimono.semanticDevice`. La valeur par défaut des deux est `auto`.

Les lots triés par longueur alternent travail court et long pour éviter une fin
d'indexation systématiquement plus lente. Une file de résultats bornée applique
une contre-pression et chaque lot vectorisé est inséré directement dans l'index
en mémoire, puis libéré : aucun fichier temporaire de vecteurs n'est écrit et le
disque ne grossit pas pendant l'embedding. La nouvelle génération est écrite une
seule fois à la fin puis publiée atomiquement ; l'ancienne n'est supprimée
qu'après succès. Le hachage du modèle et la sérialisation de l'état sont
effectués en flux, sans copie sérialisée complète. La progression native expose
`batchMs`, affiché comme durée du dernier lot.

Une session du modèle est conservée par défaut, au lieu de créer automatiquement
jusqu'à quatre copies. Augmenter explicitement les workers CPU augmente la
mémoire du modèle. Le modèle et l'index en mémoire restent présents pendant le
traitement natif ; la taille de l'index augmente avec le nombre de passages.
La fin du processus natif libère sa mémoire.

## Diagnostics en production : aucun historique interne de traces

Kimono n'installe pas d'exporteur de télémétrie, ne conserve pas de traces de
profilage/benchmark et ne crée pas de fichiers de logs.
`KIMONO_LOG_LEVEL=error` est la valeur par défaut, production comprise. Les
détails par fichier et les messages de démarrage nécessitent `debug` ; les
avertissements de contenu indisponible sont limités à 32 raisons distinctes par
processus serveur. Les chemins concernés et compteurs restent dans le statut
du corpus. Activer explicitement `KIMONO_LOG_LEVEL=debug` pour le développement
ou le diagnostic ; l'extension autonome expose `kimono.logLevel`.

La progression native est un pipe interne pour le panneau, pas un journal
persistant. En mode normal, ces événements ne sont pas retransmis sur stderr
du serveur. Les diagnostics natifs sont bornés par opération à 20 lignes de
4 096 caractères plus un résumé d'omission ; debug peut ajouter 20 lignes de
progression. Seule une fin de stderr de 64 K caractères est retenue en mémoire
pour les échecs. Les erreurs restent visibles ; stdout reste réservé aux
résultats MCP/CLI.

Le statut sémantique courant est remplacé atomiquement, au plus toutes les
500 ms pendant la progression, avec mises à jour forcées des phases/fins.
Aucun historique n'est ajouté. Index, snapshots et temporaires d'extraction sont des
données de fonctionnement, pas des
archives d'observabilité. Les temporaires de requête et d'extraction sont
nettoyés en fin normale ou sur erreur ; un arrêt forcé du processus ou de
la machine peut laisser du travail temporaire.

Le service Compose fourni utilise le pilote Docker `local` avec rotation
(`max-size: 5m`, `max-file: 2`), soit environ 10 Mo par conteneur avant
compression/surcharge du pilote, pas un log JSON illimité. Recréer les conteneurs
existants pour appliquer ce réglage. Docker, VS Code ou un autre hôte MCP gère
la conservation extérieure à Kimono ; `docker run` exige ses propres options.

Pour **zéro conservation de logs Docker**, utiliser une surcharge Compose
(Compose 2.24.4+) :

```yaml
services:
  kimono-mcp-server:
    logging: !override
      driver: none
```

Pour un **flux extérieur paramétrable**, remplacer ce bloc, par exemple :

```yaml
services:
  kimono-mcp-server:
    logging: !override
      driver: syslog
      options:
        syslog-address: "${KIMONO_SYSLOG_ADDRESS:?Définir un endpoint syslog extérieur}"
        syslog-format: rfc5424
        mode: non-blocking
        max-buffer-size: "1m"
        cache-disabled: "true"
```

L'opérateur fournit l'endpoint et applique la surcharge avec `docker compose
-f docker-compose.yml -f <surcharge>.yml up -d`. Aucune destination distante n'est
activée automatiquement. `non-blocking` borne le tampon et peut perdre des logs
si le collecteur ne suit pas ; `cache-disabled` désactive le cache local Docker
de double journalisation. Ne pas rediriger stderr vers un fichier sans rotation.

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
