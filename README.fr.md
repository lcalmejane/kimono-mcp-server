# Kimono RAG MCP

[English version](README.md)

**Un RAG local pour votre code et votre documentation.** Kimono indexe un
projet sur votre machine et fournit aux assistants compatibles MCP une
recherche lexicale et sémantique. Il indique d'abord les fichiers et plages de
lignes pertinents afin que l'assistant puisse lire des passages ciblés au lieu
de charger des fichiers entiers.

Dans le benchmark Copilot actuel, Kimono RAG a mesuré une baisse de l'entrée
cumulée et du temps écoulé par rapport à la recherche Copilot standard sur les
deux tâches évaluées :

| Tâche | Entrée cumulée | Temps écoulé |
| --- | ---: | ---: |
| Recherche sur l'indexation et les règles d'exclusion | 323 368 → 105 223 tokens (**−67,5 %**) | 111,212 → 79,077 s (**−28,9 %**) |
| Préparation d'un plan d'implémentation `maxDepth` | 454 796 → 130 244 tokens (**−71,4 %**) | 175,224 → 84,034 s (**−52,0 %**) |

Le benchmark utilise Gemini 3.8 Flash dans Copilot CLI 1.0.103. Kimono
recherche localement et lit des plages de lignes sélectionnées. Voir les
[résultats du benchmark](benchmarks/results/current.md). L'indexation et les
embeddings sont locaux ; le client peut transmettre les extraits récupérés à
son fournisseur de modèle.

## Choisir comment utiliser Kimono

| Utilisation | Adaptée à | Installation |
| --- | --- | --- |
| **Extension IDE — recommandée** | VS Code et IDE compatibles avec les extensions du Visual Studio Marketplace | Installer Kimono RAG MCP depuis le [Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp). L'extension inclut le runtime et les moteurs de recherche. |
| **Serveur Docker** | Un corpus partagé entre plusieurs clients MCP, dont GitHub Copilot cloud agent | Lancer l'image GHCR publiée ou construire le serveur avec Docker Compose, puis connecter les clients MCP à l'endpoint `/mcp`. |
| **Installation native depuis les sources** | Un serveur local pour un client qui prend en charge MCP stdio | Compiler le serveur et les moteurs natifs, puis configurer le client MCP avec la commande de lancement. |

Les IDE basés sur VS Code peuvent également utiliser l'extension lorsqu'ils
acceptent les extensions du Visual Studio Marketplace. La disponibilité dépend
du support des extensions et du Marketplace configuré par chaque IDE.

Les intégrations directes propres aux CLI LLM (Claude Code, Codex et autres)
sont prévues dans la roadmap. En attendant, utiliser un client compatible MCP
avec le serveur Docker HTTP ou l'installation native stdio.

## Installer l'extension dans VS Code et les IDE compatibles

### Marketplace — recommandé

1. Installer [Kimono RAG MCP](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp)
   depuis le Visual Studio Marketplace.
2. Ouvrir le dossier du projet et lui accorder la confiance.
3. Dans VS Code, lancer **MCP: List Servers**, démarrer **Kimono**, puis
   activer ses outils dans le sélecteur du client de chat.
4. Utiliser le panneau de gestion **Kimono** pour suivre l'indexation et
   modifier le dossier ou les paramètres du corpus.

Nécessite VS Code 1.106 ou ultérieur et un client de chat compatible MCP.

### Installation manuelle du VSIX

Télécharger depuis les [GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases)
le VSIX correspondant à la plateforme de **l'hôte d'extension** :

| Hôte d'extension | Paquet |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| Linux ARM64 (glibc) | `linux-arm64` |
| Linux Intel/AMD 64 bits (glibc) | `linux-x64` |
| Windows Intel/AMD 64 bits | `win32-x64` |

Dans VS Code, lancer **Extensions: Install from VSIX…** et sélectionner le
fichier téléchargé. En SSH distant, WSL ou Dev Container, installer sur l'hôte
distant. Le paquet inclut Node.js et les moteurs locaux ; aucune installation
séparée du runtime n'est nécessaire.

## Lancer un serveur Docker Compose partagé

Docker Compose convient lorsque plusieurs clients MCP doivent utiliser le même
corpus de projet. Installer Docker Engine avec le plugin Compose, puis depuis
ce dépôt :

```sh
cp .env.example .env
mkdir -p data/project
```

Placer le projet à indexer dans `data/project`. Dans `.env`, configurer :

```dotenv
AIKIDO_HOST_PARENT=./data
AIKIDO_DIR=project
KIMONO_CORPUS_MODE=rag
AIKIDO_VOLUME_MODE=ro
MCP_AUTH_TOKEN=replace-with-a-long-random-token
```

Générer un jeton, par exemple avec `openssl rand -hex 32`, et conserver le
fichier `.env` privé. Démarrer le serveur :

```sh
docker compose up --build -d
```

L'endpoint MCP est `http://127.0.0.1:3000/mcp`. Configurer chaque client avec
le transport HTTP Streamable et le jeton bearer. Par défaut, Compose écoute
uniquement sur la machine locale. Pour un accès depuis d'autres machines,
utiliser TLS et un reverse proxy authentifié ; ne pas exposer directement le
port du conteneur à Internet.

Pour utiliser l'image publiée plutôt que construire localement :

```sh
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
docker pull ghcr.io/lcalmejane/kimono-mcp-server:latest
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -e AIKIDO_ROOT=/workspace \
  -e KIMONO_CORPUS_MODE=rag \
  -e MCP_TRANSPORT=http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=3000 \
  -e MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
  -v "$PWD:/workspace:ro" \
  -v kimono-cache:/home/node/.cache/kimono \
  ghcr.io/lcalmejane/kimono-mcp-server:latest
```

L'image est publiée dans le
[GitHub Container Registry](https://github.com/lcalmejane/kimono-mcp-server/pkgs/container/kimono-mcp-server)
pour Linux AMD64 et ARM64. Chaque tag de version `v*` lance le
[workflow de publication du conteneur](.github/workflows/publish-container.yml),
qui publie le tag correspondant (par exemple `v0.6.4`) et met à jour `latest`.
Utiliser un tag de version pour figer un déploiement ; utiliser `latest` pour
suivre la dernière version publiée. Docker Compose reste l'option la plus simple
pour gérer un service local persistant.

### Connecter GitHub Copilot cloud agent

Le paquet GHCR est une image conteneur, pas un endpoint MCP déjà démarré. Pour
l'utiliser avec GitHub Copilot cloud agent, déployer l'image sur un hôte
accessible par GitHub en HTTPS, le configurer en serveur MCP HTTP et monter ou
synchroniser le dépôt à indexer. `AIKIDO_ROOT` doit désigner un checkout
accessible au serveur ; un serveur distant ne voit pas automatiquement
l'espace de travail temporaire de l'agent.

Dans le dépôt, ouvrir **Settings → Copilot → coding agent → MCP configuration**
et ajouter un serveur distant. Enregistrer le jeton bearer dans un secret
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

L'endpoint doit être accessible depuis GitHub et protégé par HTTPS et
authentification. Docker Compose local écoute sur loopback et n'est pas
directement accessible depuis l'agent cloud. Consulter le
[guide GitHub de configuration MCP](https://docs.github.com/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)
et le [guide RAG local](docs/local-rag.fr.md) pour configurer le serveur et le
corpus.

Pour utiliser le mode AI-KIDO, définir `KIMONO_CORPUS_MODE=aikido` et choisir
un ROOT contenant `prompts/index.md` ou `index.md`. Pour un checkout AI-KIDO
existant, définir `AIKIDO_DIR` sur le nom du dossier dans
`AIKIDO_HOST_PARENT`.

## Installer le serveur natif depuis les sources

Pour exécuter Kimono sans Docker, construire le serveur et ses moteurs natifs
depuis les sources. Exemple pour Linux x64 ; choisir la cible correspondant à
la machine dans [`docs/native-bundles.md`](docs/native-bundles.md).

```sh
npm ci
npm run build
npm run bundle:native -- --target linux-x64 --output native-bundles/linux-x64
```

Configurer l'environnement à partir des chemins présents dans le
`manifest.json` du bundle natif, puis lancer le serveur stdio avec la racine du
projet :

```sh
export FGR_BIN="$PWD/native-bundles/linux-x64/bin/fgr"
export KIMONO_SEMANTIC_BIN="$PWD/native-bundles/linux-x64/bin/kimono-semantic"
export KIMONO_MODEL_DIR="$PWD/native-bundles/linux-x64/model"
export ORT_DYLIB_PATH="$PWD/native-bundles/linux-x64/lib/libonnxruntime.so"
AIKIDO_ROOT=/absolute/path/to/project \
KIMONO_CORPUS_MODE=rag \
node dist/cli.js serve
```

Configurer le client MCP pour lancer cette commande avec cet environnement.
Le détail des cibles, bibliothèques ONNX et variables est décrit dans le
[guide des bundles natifs](docs/native-bundles.md). Pour partager un seul index
entre plusieurs clients, utiliser plutôt le serveur HTTP Docker.

## Utiliser le RAG

Le mode RAG est activé par défaut et fonctionne avec les projets courants de
code source et de documentation ; aucune structure particulière n'est requise.

1. Activer les outils MCP de Kimono dans le client.
2. Demander à l'assistant de rechercher dans le projet les fichiers ou notions
   utiles.
3. Laisser l'assistant lire les plages de lignes retournées lorsqu'il a besoin
   du contenu source.

La recherche combine des approches lexicales et sémantiques. Les résultats
indiquent les fichiers et lignes avant toute lecture du code. Les règles
`.gitignore` sont respectées ; les répertoires courants de dépendances, build
et cache sont exclus. Kimono ne modifie pas les fichiers du projet.

### Documents Office, PDF et métadonnées des fichiers

Le RAG extrait aussi le texte des documents **Excel `.xlsx`**, **Word `.docx`**, **PowerPoint `.pptx`**
et **PDF**. Les résultats Excel conservent le nom de la feuille et les adresses
des cellules, par exemple `Coûts!A5=Budget | B5=42`. Les résultats Word suivent
l'ordre des paragraphes, y compris les cellules des tableaux. Le texte PowerPoint
suit l'ordre des diapositives, tableaux inclus, avec leur numéro (`Slide 1: …`).
Les notes du présentateur et le texte dans les images ne sont pas extraits. Les numéros de
lignes désignent le texte extrait, pas la mise en page du document. Les
formules utilisent leur résultat enregistré lorsqu'il existe ; Kimono
n'exécute ni formules ni macros.

L'extraction PDF utilise `pdftotext` de Poppler. Docker l'inclut ; en
installation native ou avec l'extension embarquée, installer Poppler séparément
(`brew install poppler` sur macOS, `sudo apt-get install poppler-utils` sur
Debian/Ubuntu) et rendre `pdftotext` accessible dans le PATH du serveur. Les PDF
numérisés ne sont pas traités par OCR.

**Un fichier reste trouvable même si son contenu n'est pas lisible.** Pour les
formats non pris en charge, fichiers binaires, trop volumineux, illisibles ou
en échec d'extraction, Kimono indexe le nom, le chemin relatif au ROOT,
l'extension, la taille et la date de dernière modification disponibles. Les
résultats indiquent explicitement `contentStatus: "metadata-only"` et la raison
de l'absence de contenu. Cela s'applique aussi lorsque l'extraction PDF n'est
pas disponible. Les originaux ne sont jamais remplacés par le texte extrait
ou les métadonnées.

Les règles `.gitignore`, include/exclude et exclusions de sécurité restent
appliquées aux métadonnées. Exclure un chemin pour retirer entièrement un
fichier ; la liste d'extensions contrôle l'extraction du contenu, pas le
catalogue des fichiers du RAG.

## Configurer le corpus

Dans VS Code, utiliser **Kimono: Open Management Panel** ou configurer :

| Paramètre | Défaut | Rôle |
| --- | --- | --- |
| `kimono.corpusMode` | `rag` | `rag` pour un projet courant ; `aikido` pour une base de connaissances AI-KIDO. |
| `kimono.root` | Dossier ouvert | Dossier à indexer. |
| `kimono.mode` | `embedded` | `embedded` pour un serveur local, `remote` pour un serveur MCP HTTP existant, ou `disabled`. |
| `kimono.url` | Vide | URL HTTPS `/mcp` du serveur distant quand `kimono.mode` vaut `remote`. |
| `kimono.configFile` | Vide | Chemin absolu facultatif vers une configuration du corpus gérée par l'hôte. |

Consulter le [guide de l'extension](vscode/README.fr.md) pour les paramètres
VS Code. Les jetons distants sont saisis avec **Kimono: Set Remote Token** et
stockés dans SecretStorage de VS Code.

Pour une installation serveur, `KIMONO_CORPUS_MODE` sélectionne le mode et
`AIKIDO_ROOT` désigne le dossier du projet. Une configuration JSON facultative
peut restreindre les types de fichiers ou chemins et ajuster les limites :

```json
{
  "mode": "rag",
  "extensions": [".md", ".ts", ".tsx", ".js", ".py"],
  "include": ["src/**", "docs/**"],
  "exclude": ["**/*.generated.*", "**/fixtures/**"]
}
```

Le chemin de configuration est choisi par l'hôte serveur ; les fichiers du
projet ne sont pas chargés automatiquement comme configuration. Par défaut,
le corpus est limité à 100 000 fichiers et 512 Mio, avec une taille maximale de
4 Mio par fichier en mode RAG. Voir le [guide de configuration RAG](docs/local-rag.fr.md)
pour les paramètres et limites.

## Mode AI-KIDO en option

Kimono peut aussi rechercher dans une base de connaissances AI-KIDO existante
lorsque le mode `aikido` est sélectionné. Le RAG local reste utilisable dans
n'importe quel projet ; le mode AI-KIDO ajoute des opérations dédiées aux
connaissances et à la collaboration. Découvrir la méthode et les outils sur
[www.ai-kido.fr](https://www.ai-kido.fr).

## Pour aller plus loin

- [Configuration RAG et connexion des clients](docs/local-rag.fr.md)
- [Utilisation des fonctionnalités MCP](docs/usage.fr.md)
- [Recherche et lecture ciblée](docs/retrieval.fr.md)
- [Installation et paramètres VS Code](vscode/README.fr.md)
- [Détails de distribution Docker et extension](docs/vscode-distribution.fr.md)
