# Distribution VS Code

[English version](vscode-distribution.md) · [README du projet](../README.fr.md)

Les sources de l'extension se trouvent dans [`vscode/`](../vscode/). Les fichiers
VSIX pour chaque plateforme sont construits par GitHub Actions. Consulter le
[guide d'installation](../vscode/README.fr.md).

## Source du texte Marketplace

Le texte affiché sur le Marketplace provient du paquet de l'extension :

- `displayName`, `description` et `keywords` viennent de
  [`vscode/package.json`](../vscode/package.json).
- La présentation Marketplace est le fichier `README.md` du VSIX. Le script
  d'empaquetage copie [`vscode/README.md`](../vscode/README.md) à la racine du
  paquet.
- [`vscode/fiche.md`](../vscode/fiche.md) est une référence éditoriale ; elle
  n'est pas incluse dans le VSIX et ne modifie pas à elle seule la page
  Marketplace.

Le workflow de publication envoie un VSIX de release existant ; il ne le
reconstruit pas. Une modification du texte nécessite donc une nouvelle version,
une nouvelle release GitHub et une publication Marketplace.

## CI et releases

Le workflow [CI](../.github/workflows/ci.yml) teste le serveur et l'extension
à chaque push et pull request. Une exécution manuelle depuis **Actions → CI →
Run workflow** ou la création d'un tag `v*` produit également les paquets :

1. Construction des quatre cibles natives sur les runners adaptés.
2. Assemblage des composants natifs et du modèle épinglés, du serveur MCP, de
   Node.js 24 et de sa licence spécifique dans les VSIX par plateforme.
3. Tests d'intégration du serveur MCP stdio empaqueté : handshake, liste des
   outils, état du ROOT, recherche lexicale et embeddings ONNX réels. Les tests
   couvrent aussi le mode RAG générique et le lanceur `stdio.cjs`.
4. Publication des artefacts `kimono-vscode-<target>` (VSIX et provenance) et
   des bundles natifs. Leur rétention est de trente jours.

Une exécution manuelle ne crée pas de release. Pour publier une release :

1. Mettre à jour les versions du serveur et de l'extension dans
   [`package.json`](../package.json) et [`vscode/package.json`](../vscode/package.json),
   puis mettre à jour le lockfile et le changelog.
2. Committer et pousser les changements.
3. Pousser le tag correspondant, par exemple `v1.2.3` pour la version `1.2.3`.
4. Après réussite des tests serveur, extension, construction native et
   empaquetage, la CI crée une release brouillon, ajoute les VSIX, fichiers
   `.build.json`, archives natives et `SHA256SUMS.txt`, puis publie la release.
5. Après publication de la release, la CI appelle directement le workflow
   Marketplace réutilisable avec ce même tag et le secret de dépôt `VSCE_PAT`.

Les releases publiées sont immuables. Une correction nécessite une nouvelle
version et un nouveau tag. La création de release utilise `GITHUB_TOKEN`
avec `contents: write` ; les autres jobs ont des permissions en lecture seule.
La publication Marketplace nécessite le secret décrit ci-dessous.
Open VSX n'est pas publié automatiquement.

## Publication Marketplace

La publication Marketplace est automatique après réussite de la release par tag, avec le
workflow [Publish VS Code Marketplace](../.github/workflows/publish-marketplace.yml).
Il envoie les quatre VSIX de la release publiée, sans les reconstruire.
L'appel direct depuis la CI évite de dépendre d'un nouvel événement de release
créée par `GITHUB_TOKEN`. Avant de pousser un tag de release :

1. Vérifier l'identifiant du publisher Marketplace : `ai-kido`.
2. Ajouter un Personal Access Token VSCE autorisé par ce publisher comme secret
   de dépôt `VSCE_PAT`. Ne jamais placer ce jeton dans le dépôt, les paramètres
   du workflow ou une conversation.
3. Vérifier le profil du publisher, la fiche Marketplace et le contenu du paquet.
4. Considérer le push du tag de version comme l'autorisation de publier le paquet
   sur GitHub Releases et sur le Marketplace.

Pour une reprise, lancer **Actions → Publish VS Code Marketplace → Run workflow**
depuis `main`, saisir le tag de release existant et confirmer la vérification
de la fiche. Aucune nouvelle version ni reconstruction n'est nécessaire.
Les PR, push ordinaires de branche et exécutions manuelles de la CI ne publient
pas sur le Marketplace.

Le workflow vérifie que le tag correspond aux versions des paquets, que la
release GitHub publiée n'est pas une préversion, que `SHA256SUMS.txt` est valide
et que les quatre cibles VSIX sont présentes. Il envoie les quatre paquets avant
de vérifier leur visibilité : le délai d'indexation d'une plateforme ne bloque
plus les suivantes. Les relances ignorent les versions déjà acceptées.
Les publications sont sérialisées ; une nouvelle exécution n'annule jamais une
publication en cours. La visibilité est vérifiée jusqu'à soixante fois, avec
vingt secondes d'attente et reprise des requêtes en échec.
Si elle n'est toujours pas confirmée, le workflow échoue explicitement ; les
paquets acceptés restent publiés et le même tag peut être relancé manuellement.
Pour une reprise manuelle, la case de confirmation autorise la publication :
aucune confirmation Marketplace supplémentaire n'est demandée.

## Provenance et reproductibilité

Chaque fichier `.build.json` indique le commit source, l'état de propreté du
checkout (`sourceDirty`), la version, la cible, la version réelle de Node.js,
l'empreinte SHA-256 du lockfile npm, celle du VSIX et le manifeste des composants
natifs. Les téléchargements de runtime et du modèle sont épinglés. Les mises à
jour des runners et outils hébergés ainsi que les horodatages ZIP empêchent de
garantir une reproduction octet pour octet. Considérer un artefact CI comme
candidat tant que l'exécution complète n'a pas réussi.

## Construction locale

Utiliser Node.js 24 ou ultérieur et un système correspondant à la cible native.
Installer Rust/Cargo pour compiler les moteurs natifs :

```sh
npm ci
npm run typecheck
npm run test:vscode
npm run bundle:native -- --target darwin-arm64 --output native-bundles/darwin-arm64
npm run package:vscode
npm run test:vscode:integration
```

`BUILD_TARGET` utilise la plateforme de l'hôte par défaut ; l'empaquetage
croisé est refusé. `KIMONO_BUNDLE_DIR` peut désigner un bundle natif déjà vérifié.
Le VSIX et sa provenance sont générés dans
`vscode/kimono-rag-mcp-<version>-<target>.vsix`. Le répertoire temporaire ignoré
`vscode/.package/` doit être vide avant l'empaquetage.

L'empaquetage bundle les dépendances JavaScript avec esbuild, conserve les
mentions de licence, vérifie les empreintes des fichiers natifs et inclut les
notices du runtime et du modèle. Le VSIX n'inclut ni les données du workspace,
ni `.env`, secrets, tests, sources ou `node_modules` de développement. Internet
est requis durant la construction pour les dépendances, composants épinglés et
licence Node.js ; la recherche locale après installation ne télécharge pas de
composants.

Les cibles natives actuelles sont macOS ARM64, Linux ARM64/x64 (glibc) et
Windows x64. Une autre plateforme exige l'ajout préalable de ses composants
épinglés, d'un job de construction et de tests réels. Les tests simulés ne
valident pas l'interface VS Code : l'installation manuelle dans un hôte pris en
charge reste la dernière vérification interactive.
