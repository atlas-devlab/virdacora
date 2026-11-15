# Compatibilità ed errata / Compatibility and erratum

## Italiano

Il primo replay territoriale del 15 novembre 2026 ha completato i tre percorsi
di pagamento/rimborso, ma il controllo incrociato ha trovato un'etichetta errata:
il riepilogo `scientificResult.replay.modelVersion` ereditato dal ramo di ricerca
era fissato a `terravoce-linear-risk-v1`. Il caso, la ricevuta Oracle e le
previsioni erano già prodotti dalla base corrente, identificata come
`terravoce-linear-risk-v2-oxygen-units`.

La correzione legge la versione dall'assessment realmente eseguito e rifiuta
versioni miste nel replay. Il test confronta il riepilogo con il caso e l'Oracle.
Non cambia formula, pesi, orizzonte, dati, soglie, criteri di consegna o importi.
La prima esecuzione e il suo elenco di hash vengono conservati come
`local-run-01` e `pre-run-inputs.json`; una nuova esecuzione separata verifica la
correzione. Non vengono riscritti per far apparire corretta la prima etichetta.

L'incarico attuale riutilizza le stesse misure, istanti e policy del vecchio caso
di ricerca. L'Oracle corrente ha una versione analitica diversa: perciò genera
nuovi `assessmentId`, `evidenceHash` e `caseHash`. L'hash storico resta conservato,
senza sostituzione: `0xc25e870824265b9c1a32bf929ec3f42cc54ebc86e52a4d2560ac1096c9212185`.
Il nuovo caso è
`0x3cee978fda3fd8e84c92e2b0a94dec7bdb5fe0c64560c4b13e8e3babd4414f84`.

Il confronto campo per campo con il caso pubblicato nel vecchio ramo trova
questi soli quattro cambiamenti. Fonte, manifest, policy e valori numerici sono
uguali. L'impegno del caso attuale è lo stesso nei tre scenari; i negativi non
possono sostituirlo con il proprio hash ricalcolato.

## English

The first local run completed all three settlement paths, but cross-checking
found an inherited replay-label error: its summary hardcoded v1, while the case,
Oracle and calculations already used the existing v2-oxygen-units base. The fix
derives metadata from the actual assessment, rejects mixed versions and adds a
cross-component assertion. It changes no prediction formula, weights, horizon,
observations, thresholds, acceptance criteria or compensation.

Run one and its pre-run hashes are retained unchanged. A separate run verifies
the repair. The historical case hash remains preserved; the current analytical
version correctly produces a new assessment ID, evidence hash and case hash.
Those four fields are the only differences in a field-wise comparison with the
archived research case; source, policy and all numerical fields agree. This is
versioned replay, not a replacement of historical signed evidence.
