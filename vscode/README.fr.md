# RAG local pour le code et la documentation — dans VS Code

Kimono fournit à votre assistant MCP un index de recherche local sur le projet
ouvert. Il combine recherche par mots-clés et recherche sémantique, indique
d'abord les fichiers pertinents et permet de lire uniquement les passages
nécessaires.

Retrouvez du code, des API, des configurations et de la documentation dans
l'ensemble du projet sans demander à l'assistant de charger d'emblée des
fichiers entiers. L'indexation et les embeddings s'exécutent localement.

Dans le benchmark Copilot actuel avec Gemini 3.8 Flash, Kimono RAG a mesuré :

| Tâche | Tokens d'entrée cumulée | Temps écoulé |
| --- | ---: | ---: |
| Recherche dans le dépôt | 323 368 → 105 223 (**−67,5 %**) | 111,212 → 79,077 s (**−28,9 %**) |
| Préparation d'un plan `maxDepth` | 454 796 → 130 244 (**−71,4 %**) | 175,224 → 84,034 s (**−52,0 %**) |

La comparaison oppose la recherche Copilot standard au RAG local Kimono. Voir les
[résultats du benchmark](https://github.com/lcalmejane/kimono-mcp-server/blob/main/benchmarks/results/current.md).

## Fonctionnalités

- **RAG local :** indexez et recherchez le code source et la documentation sur
  votre machine.
- **Recherche lexicale et sémantique :** trouvez des termes précis ou des
  notions similaires.
- **Documents Office :** recherchez les cellules Excel (`.xlsx`) et les
  paragraphes Word (`.docx`), ainsi que le texte et les tableaux PowerPoint
  (`.pptx`) avec les numéros des diapositives.
- **Catalogue de fichiers :** si le contenu est illisible, recherchez le nom,
  le chemin relatif au projet, l'extension, la taille et la date de modification
  lorsqu'elles sont disponibles.
- **Contexte ciblé :** obtenez les chemins et plages de lignes avant de
  demander le texte source.
- **Projet en lecture seule :** Kimono ne modifie pas les fichiers du projet.
- **Exclusions utiles :** les règles `.gitignore` s'appliquent et les
  répertoires courants de dépendances, build et cache sont exclus.
- **Runtime inclus :** l'extension embarque le serveur, Node.js, les moteurs
  de recherche et le modèle d'embedding. Aucun runtime séparé n'est à installer.
- **Progression et paramètres :** le panneau Kimono suit l'indexation et
  configure le corpus.

Le texte des PDF est recherchable si `pdftotext` (Poppler) est installé sur
l'hôte d'extension. Sinon, les PDF restent recherchables par leurs métadonnées
du système de fichiers.

## Installer depuis le Marketplace

1. Installer **Kimono RAG MCP** depuis le
   [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp).
2. Ouvrir le dossier du projet et lui accorder la confiance.
3. Lancer **MCP: List Servers**, démarrer **Kimono** et activer ses outils dans
   le sélecteur du client de chat MCP.
4. Demander à l'assistant de trouver du code ou de la documentation. Il peut
   lire les plages de lignes sélectionnées lorsqu'il a besoin du détail.

Nécessite VS Code 1.106 ou ultérieur et un client compatible MCP. Les IDE
basés sur VS Code peuvent aussi utiliser l'extension s'ils prennent en charge
les extensions du Visual Studio Marketplace ; la disponibilité dépend du
support et du Marketplace configuré par chaque IDE.

## Choisir le projet et le mode

Le mode par défaut est `rag` et le dossier ouvert est le projet indexé :

| Paramètre | Défaut | Quand le modifier |
| --- | --- | --- |
| `kimono.corpusMode` | `rag` | Sélectionner `aikido` uniquement pour une base de connaissances AI-KIDO. |
| `kimono.root` | Dossier ouvert | Indexer un autre dossier. |
| `kimono.mode` | `embedded` | Choisir `remote` pour un serveur MCP HTTP existant, ou `disabled` pour arrêter Kimono. |
| `kimono.url` | Vide | Définir l'endpoint HTTPS `/mcp` en mode `remote`. |
| `kimono.configFile` | Vide | Fournir un chemin absolu vers une configuration du corpus gérée par l'hôte. |
| `kimono.semanticDevice` | `auto` | Comparer le CPU aux fournisseurs CUDA/CoreML disponibles une fois par session, ou imposer un fournisseur. |
| `kimono.logLevel` | `error` | Activer `debug` uniquement pour un diagnostic ; Kimono ne crée aucun fichier de traces. L'hôte gère la conservation de stderr. |

Utiliser **Kimono: Open Management Panel** pour configurer le corpus, vérifier
l'état de l'index et lancer un test de recherche. Le mode RAG local n'exige
aucune structure particulière. Le mode optionnel AI-KIDO nécessite
`prompts/index.md` ou `index.md`.

L'embedding utilise une session du modèle par défaut et des lots de vecteurs
bornés en mémoire. Le panneau affiche le fournisseur d'exécution choisi et les
mesures au démarrage. Voir les
[paramètres du moteur et de la mémoire](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.fr.md#moteur-dembedding-et-m%C3%A9moire).

## Installation manuelle

Télécharger un VSIX par plateforme depuis les
[GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases),
puis lancer **Extensions: Install from VSIX…** dans VS Code :

| Hôte d'extension | Cible VSIX |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| Linux ARM64 (glibc) | `linux-arm64` |
| Linux Intel/AMD 64 bits (glibc) | `linux-x64` |
| Windows Intel/AMD 64 bits | `win32-x64` |

Choisir la plateforme de l'hôte d'extension. En SSH distant, WSL ou Dev
Container, installer sur l'hôte distant.

## Utiliser Kimono hors d'un IDE compatible VS Code

Pour partager un serveur MCP, lancer Kimono avec Docker Compose ou l'image
Docker publiée. Pour un serveur stdio local, compiler Kimono et les moteurs de
recherche natifs depuis les sources ; voir le
[guide RAG local](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.fr.md).
Le conteneur publié peut aussi fournir un endpoint MCP HTTP distant pour
GitHub Copilot cloud agent s'il est déployé sur un hôte accessible en HTTPS.
Les intégrations directes adaptées à certains outils CLI LLM sont prévues.

Kimono peut également rechercher dans une base de connaissances AI-KIDO, en
mode optionnel. Découvrir la méthode AI-KIDO sur
[www.ai-kido.fr](https://www.ai-kido.fr).
