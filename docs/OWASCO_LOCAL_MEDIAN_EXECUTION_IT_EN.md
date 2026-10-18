# Owasco local LAD: implementation and execution / Implementazione ed esecuzione

## Italiano

Questa modifica implementa il [protocollo già congelato](OWASCO_LOCAL_MEDIAN_PROTOCOL_IT_EN.md)
della PR #20. È una candidata numerica distinta dalla regressione storica sul
Willamette. Mantiene otto ingressi, orizzonte esatto di un'ora, luglio per
addestramento, agosto per un controllo di sviluppo e MAE contro persistenza
come criterio principale. Settembre non è un ingresso del programma.

Il protocollo e la ricevuta preliminare rimangono byte per byte quelli della
loro preparazione: le diciture “protocol only” e “future implementation not
reviewed” descrivono quello stadio storico. Le ricevute di questa esecuzione
sono separate; non riscriviamo la storia per aggiornarne lo stato.

### Che cosa cambia nel codice

| Componente | Scopo e confine |
|---|---|
| `owasco_lad_core.py` | Calcola scale e pesi LAD soltanto dalle righe passate dal chiamante. Non scopre né apre file. |
| `owasco_lad_data.py` | Seleziona un solo ruolo prima della lettura: tre file luglio oppure tre file agosto, mai entrambi nel loader. |
| `owasco_lad_environment.py` | Registra versioni e hash dei file installati; non risolve alcun problema numerico e non legge osservazioni. |
| `owasco_local_median.py` | Separa congelamento, singolo fit, audit del training, score e verifiche senza fit. |
| `audit_owasco_local_median.py` | Ricostruisce i conti con sola libreria standard, senza importare i moduli di produzione o il solver. |

Per ogni ruolo il loader vincola l'evaluation originale e i due archivi gzip di
ossigeno e temperatura. Prima verifica tutti e tre gli hash; poi controlla
timestamp, identificativi e valori usati dalla coorte. Ricostruisce la storia
di ossigeno, l'ultima misura, il target e le due feature di temperatura dai
record originali. Una discrepanza ferma l'esecuzione: non cancella la riga,
non interpola e non cambia l'idoneità della coorte.

Le statistiche di addestramento si calcolano soltanto sulle 1.275 righe di
luglio. La formulazione LP e le opzioni restano quelle concordate. Il modello
salva media, varianza, scala, maschera delle colonne costanti, coefficienti,
diagnostica di training e risultato del solver. Salva separatamente le variabili
ausiliarie `u[N]`, gli slack delle `2N` disuguaglianze e i relativi marginals:
sono oggetti matematici differenti.

L'ambiente del fit deve essere Python 3.13.5, NumPy 2.3.5, SciPy 1.17.1 su
Windows AMD64, come fissato prima. Si registra anche la versione HiGHS inclusa.
I manifest controllano i file installati contro gli hash e le dimensioni RECORD
disponibili. L'hash dei metadati WHEEL **non** è l'hash dell'archivio `.whl`
originale: quest'ultimo rimane nullo se quell'archivio non è disponibile.
La ricevuta omette percorsi assoluti dell'installazione.

### Ordine obbligatorio

1. Test sintetici, revisione, commit e pubblicazione del codice.
2. Ricevuta `implementation-freeze.json`, poi suo commit e pubblicazione.
3. Un fit su luglio. Un marcatore esclusivo in `.runtime/` impedisce di
   ripeterlo automaticamente anche dopo un errore. I controlli di integrità
   degli input precedono il consumo del tentativo del solver.
4. Audit del modello e salvataggio di `training-audit.json`. Commit e
   pubblicazione dei pesi e di questa ricevuta **prima** di leggere agosto per
   il primo score della candidata.
5. Un solo score su tutte le 1.306 righe di agosto. La CLI richiede che la
   ricevuta dell'audit corrisponda esattamente al modello e sia già in Git.
6. Replay senza fit e audit separato del risultato. Nessuna promozione,
   variante o regolazione automatica in base al punteggio.

I marker locali prevengono ripetizioni accidentali della procedura canonica;
non sono una prova globale contro un operatore che copi o riscriva tutto il
workspace. Git e la pubblicazione documentano l'ordine procedurale, non
certificano da soli un orologio fisico o l'ignoranza umana dei target del 2020.

### Verificare il calcolo non significa verificare il lago

L'audit confronta obiettivo primale e duale, vincoli, stazionarietà delle
variabili libere, costi ridotti e complementarità. Usa tolleranza assoluta
`1e-7` per il certificato e `1e-9` per la ricomposizione delle MAE, fissate nel
codice prima del primo fit. È un controllo numerico, non un certificato
simbolico di unicità della soluzione. L'auditor è scritto separatamente, ma
proviene dalla stessa famiglia Codex: non è una validazione ambientale esterna.

Una previsione negativa resta visibile e impedisce il successo. Una previsione
non calcolabile rende nulla la MAE completa: non si fa la media sulle sole
righe valide e non si sostituisce di nascosto la persistenza. Giorni, gruppi e
primi esempi cronologici devono ricomporre il totale completo. Lo score
conserva il modello invariato e non richiama il fit.

Prevedere un incremento e sommarlo all'ultima misura non impone di per sé
correzioni piccole: con oxygenNow non costante e libero è una
riparametrizzazione di una previsione lineare del livello. Inoltre la nuova
ricetta cambia insieme luogo/coorte di training, loss e regolarizzazione
(ridge penalizzata contro LAD senza penalità). Un risultato non isola il
merito di un singolo ingrediente.

Agosto era già stato esaminato: un eventuale miglioramento è sviluppo, non
conferma indipendente. Le misure finalizzate di una posizione/profondità non
dimostrano disponibilità live, accuratezza fisica o previsione dell'intero
lago. Oracle, blockchain, consenso, governance e fondi non cambiano.

## English

This implements the exact PR20 protocol as a separate one-hour local oxygen
candidate. July alone supplies preprocessing and training; August is one
already-open development screen with full-cohort MAE versus persistence.
September is absent from the workflow. The original protocol/preflight retain
their historical labels and bytes; execution evidence is a separate layer.

The pure numerical core has no archive discovery or I/O. A role-isolated
loader binds evaluation plus raw oxygen/temperature for only one month,
checks all hashes first and reconstructs referenced histories, targets and
temperature features without changing cohort eligibility. Environment capture
records pinned versions and actual installed-file manifests, distinguishing
WHEEL metadata from unavailable original wheel-archive hashes.

Code and implementation receipt must be committed/pushed before the single
July fit. The model and its independent arithmetic-audit receipt must then be
committed/pushed before the first August candidate prediction. Exclusive local
attempt records prevent accidental retries; they are not global tamper-proof
execution history. A source-integrity failure never permits row deletion or
an alternative solver. Model publication/commit checks complement the algebra
audit; none establishes physical truth or historical as-of-origin availability.

The stdlib auditor imports neither production modules nor numerical libraries.
It reconstructs July scalers and training diagnostics and checks the numerical
primal/dual certificate (absolute tolerance `1e-7`, metric recomposition `1e-9`).
With `--report` it also checks every August prediction, metric, partition, day,
example and decision. This is a separate implementation from the same Codex
family, not independent environmental validation. LAD optima need not be unique.

Every accepted August origin remains in the denominator. Negative predictions
invalidate success; noncomputable errors yield a null full score, never
persistence substitution or a valid-only average. The adopted gain tolerance
is numerical, not ecological significance. Delta prediction alone is not
shrinkage, and the complete recipe changes training locality, loss and penalty.
No automatic alternative, tuning, unopened period or operational promotion
follows a result.

## Commands / Comandi

From the repository root. The first four evidence-producing commands are
exclusive and must not be rerun as a way to choose a better result:

```sh
python scripts/owasco_local_median.py freeze-implementation
# Commit and push the implementation receipt before training.
python scripts/owasco_local_median.py train
python scripts/owasco_local_median.py audit-model
# Commit and push the exact model and training-audit receipt before scoring.
python scripts/owasco_local_median.py score
```

Read-only reproduction uses no scientific packages and never invokes the LP:

```sh
python scripts/owasco_local_median.py verify-model
python scripts/owasco_local_median.py verify-report
python scripts/audit_owasco_local_median.py
python scripts/audit_owasco_local_median.py --report
```

CI installs the pinned scientific packages in an isolated virtual environment
for synthetic tests. Historical real-data evidence is replayed without a new
LAD fit. The existing workflow-dispatch-only four-replica outage demonstration
remains separate and is skipped on ordinary PR runs.

## Execution results / Risultati di esecuzione

No environmental fit or development score had been executed when this
implementation document was first committed. Subsequent sections and evidence
receipts will record actual stage results without rewriting the frozen recipe.
