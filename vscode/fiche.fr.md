# Fiche Marketplace

[English version](fiche.md)

## Extension

- **Publisher :** AI-KIDO
- **Nom :** Kimono RAG MCP
- **Identifiant :** `ai-kido.kimono-rag-mcp`
- **Catégorie :** AI, Machine Learning, Other
- **Étiquettes :** `mcp`, `rag`, `semantic search`, `code search`, `local indexing`
- **Version minimale de VS Code :** 1.106

## Description courte

RAG local pour le code et la documentation, avec recherche lexicale et
sémantique via MCP.

## Présentation

Recherchez localement dans votre code avec Kimono RAG MCP. La recherche par
mots-clés et sémantique retrouve le code source et la documentation pertinents,
puis fournit à l'assistant MCP les fichiers et plages de lignes à lire.

Obtenez un contexte ciblé sans charger d'emblée des fichiers entiers.
L'indexation et les embeddings s'exécutent sur votre machine ; Kimono ne
modifie pas les fichiers du projet. Le client MCP contrôle les outils activés
et les contenus transmis au fournisseur de son modèle.

### Avantages

- Recherche lexicale, sémantique et hybride locale.
- Compatible avec les projets courants de code et de documentation, sans
  structure particulière.
- Résultats compacts avec fichiers et plages de lignes ; le contenu n'est lu
  que sur demande.
- Respecte `.gitignore` et exclut les répertoires courants de dépendances,
  build et cache.
- Inclut le serveur, le runtime Node.js, les moteurs de recherche et le modèle
  d'embedding.
- Panneau dans l'éditeur pour suivre l'index, configurer le corpus et tester
  une recherche.

Dans le benchmark Copilot actuel avec Gemini 3.8 Flash, Kimono RAG a mesuré :

| Tâche | Tokens d'entrée cumulée | Temps écoulé |
| --- | ---: | ---: |
| Recherche dans le dépôt | 323 368 → 105 223 (**−67,5 %**) | 111,212 → 79,077 s (**−28,9 %**) |
| Préparation d'un plan `maxDepth` | 454 796 → 130 244 (**−71,4 %**) | 175,224 → 84,034 s (**−52,0 %**) |

La comparaison oppose la recherche Copilot standard au RAG local Kimono. Voir les
[résultats du benchmark](https://github.com/lcalmejane/kimono-mcp-server/blob/main/benchmarks/results/current.md).

Le mode de connaissances AI-KIDO est disponible en option pour les utilisateurs
de cette méthode. En savoir plus sur
[www.ai-kido.fr](https://www.ai-kido.fr).

## Installation

Installer **Kimono RAG MCP** depuis le Visual Studio Marketplace. Ouvrir un
dossier de confiance, démarrer **Kimono** depuis **MCP: List Servers**, puis
activer ses outils dans le client de chat MCP.

Nécessite VS Code 1.106 ou ultérieur et un client compatible MCP.

## Informations complémentaires

- [README du projet](../README.fr.md)
- [Configuration et utilisation du RAG local](../docs/local-rag.fr.md)
- [Installation manuelle du VSIX](README.fr.md)
- [Construction et publication](../docs/vscode-distribution.fr.md)

Licence MIT. Les notices des composants inclus et des dépendances tierces sont
fournies dans l'extension.
