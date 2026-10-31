# EnterpriseRAG-Bench — détail par catégorie

104 questions · limite 10 · politique(s) auto-speed

## auto-speed

| Catégorie | N | semantic hit@1 | semantic hit@10 | semantic MRR |
|---|---:|---:|---:|---:|
| basic | 41 | 27 % | 49 % | 0.326 |
| semantic | 29 | 0 % | 14 % | 0.029 |
| intra_document_reasoning | 4 | 50 % | 100 % | 0.708 |
| project_related | 2 | 50 % | 100 % | 0.583 |
| constrained | 11 | 45 % | 73 % | 0.561 |
| conflicting_info | 2 | 50 % | 100 % | 0.625 |
| completeness | 11 | 55 % | 82 % | 0.608 |
| miscellaneous | 4 | 50 % | 100 % | 0.688 |
| TOTAL | 104 | 27 % | 51 % | 0.337 |

Hit@k = au moins un document attendu parmi les k premiers fichiers. Plusieurs documents peuvent être attendus pour une question (completeness, project_related) : un seul suffit ici, ce qui est plus indulgent que le rappel complet.
