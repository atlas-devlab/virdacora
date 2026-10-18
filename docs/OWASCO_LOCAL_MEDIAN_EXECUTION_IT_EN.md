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

### Italiano: esecuzione del 18 ottobre 2026

Il codice è stato pubblicato nel commit `c2c1e4e`, dopo 288 test locali passati
(95 nuovi test sintetici). La CI GitHub
[39126095374](https://github.com/atlas-devlab/virdacora/actions/runs/39126095374)
è passata prima del fit. La ricevuta di implementazione è stata creata alle
12:11:10 UTC e pubblicata in `0b3a1ab`. Il solo fit di luglio è iniziato alle
12:11:25 UTC. Il modello e l'audit di luglio sono stati pubblicati in
`3f1d8c41d8364a7552d2a486b57d74c02f46f311` prima dello score di agosto,
iniziato alle 12:11:50 UTC. Le ricevute conservano gli orari completi.

| Periodo e ruolo | Righe | MAE ultima misura P (mg/L) | MAE candidata L (mg/L) |
|---|---:|---:|---:|
| Luglio 2020, addestramento | 1.275 | 0,038666667 | 0,038666667 |
| Agosto 2020, controllo di sviluppo | 1.306 | 0,055513017 | 0,055513017 |

**Esito primario: STOP_CANDIDATE.** Il solver ha restituito intercetta e otto
pesi tutti `-0.0`, equivalenti a zero. Quindi `deltaHat = 0` e `L = P`.
Su agosto: zero previsioni cambiate, zero invalide, 1.306 pareggi contro P;
nessun caso in cui L aiuti o danneggi P. I campi degli esempi di miglioramento
e peggioramento sono correttamente nulli, non casi scelti a posteriori.

Rispetto alla regressione storica R, la cui MAE su agosto è 0,066183550 mg/L,
L evita correzioni complessivamente dannose in quella coorte. Tuttavia il
criterio concordato era battere P: il guadagno contro P è esattamente zero.
Non presentiamo questo ritorno alla baseline come nuova capacità predittiva.

Ecco due righe reali archiviate, riportate soltanto per capire il comportamento:

| Origine → target UTC | Ultima misura | L | Osservazione a un'ora | Errore L |
|---|---:|---:|---:|---:|
| 01/08/2020 05:30 → 06:30 | 9,2 | 9,2 | 9,2 | 0,0 mg/L |
| 15/08/2020 05:00 → 06:00 | 10,2 | 10,2 | 11,2 | 1,0 mg/L |

La prima è la prima riga cronologica: L evita la piccola correzione della
regressione storica (9,191086853), mentre l'osservazione pubblicata rimane 9,2.
La seconda è il primo massimo errore assoluto di L nel report: persistenza e L
non anticipano il cambiamento; R vale 10,228608925 e sbaglia leggermente meno
su quella singola riga. Sono esempi descrittivi, non nuovi criteri di selezione.
L'uguaglianza fra valori pubblicati non dimostra stabilità fisica del lago.

Il solver termina con successo dopo 807 iterazioni. L'auditor separato trova
obiettivi primale e duale entrambi 0,03866666666666664 e gap numerico zero;
massima violazione dei vincoli circa `2,97e-15`. Questo sostiene l'ottimalità
numerica sul training entro le tolleranze fissate. Non prova unicità dei pesi,
assenza generale di informazione negli ingressi o affidabilità futura.

Il replay senza pacchetti scientifici e l'audit del report completo passano.
I 53 file storici vincolati sono invariati. Non è stato eseguito un secondo
fit o uno score alternativo; settembre resta chiuso. La dimostrazione con
quattro repliche e nodo spento non è stata rieseguita: è separata e saltata
nella CI ordinaria della PR.

Conserviamo questa candidata come risultato negativo riproducibile e ci
fermiamo prima di scegliere un'altra ricetta. Il prossimo disegno va discusso
separatamente: non si cerca un altro ottimo o un ritocco guardando agosto.

### English: observed execution and outcome

Implementation commit `c2c1e4e`, 288 passing local tests (95 new synthetic
tests), and successful GitHub run 39126095374 preceded the fit. The
implementation receipt was published in `0b3a1ab`. One July fit started at
12:11:25 UTC on 18 October 2026; the exact model and July arithmetic audit
were published in `3f1d8c41d8364a7552d2a486b57d74c02f46f311` before the one
August score, which started at 12:11:50 UTC.

All nine fitted coefficients are zero. July training MAE equals persistence
at 0.03866666666666664 mg/L. All 1,306 August predictions also equal
persistence: both full-cohort MAEs are 0.05551301684532926 mg/L, with zero
changed or invalid predictions and zero gain. The primary outcome is
**STOP_CANDIDATE**. The older transferred regression's August MAE is
0.06618354966060074 mg/L; avoiding its aggregate excess error does not beat
the agreed persistence baseline or establish added predictive skill.

At the first August origin (05:30 UTC on August 1), P and L are 9.2 mg/L,
matching the archived one-hour observation; old R is about 9.191087. At the
first maximum-error origin (05:00 UTC on August 15), P and L are 10.2 but
the archived target is 11.2 mg/L. Their error is 1 mg/L; R, about 10.228609,
does slightly better on that row. These descriptive examples do not replace
the full-cohort criterion. Equal published values do not establish physical
stability. There are no helps/harms examples against P because every row ties.

The solver completed 807 iterations. The separate stdlib audit passes the
primal/dual certificate (both objectives about 0.038666667, numerical gap
zero) and verifies all August arithmetic, groups and days. Read-only replay
also passes without scientific packages. This supports the specified
sample-level numerical solution, not uniqueness, lack of information in the
inputs, sensor accuracy, future skill or independent environmental validation.
All 53 historical pinned files remain unchanged. No alternative fit, score,
September opening or operational promotion followed this result. The separate
four-replica outage demonstration was not rerun. A different recipe would
require a separately agreed experiment.

### Evidence / Prove

- [Implementation freeze](evidence/owasco-local-median/implementation-freeze.json)
- [Frozen model and environment](evidence/owasco-local-median/frozen-model.json)
- [July arithmetic audit](evidence/owasco-local-median/training-audit.json)
- [August summary](evidence/owasco-local-median/development-summary.json)
- [Complete August rows (gzip)](evidence/owasco-local-median/development.json.gz)
- [Full arithmetic audit](evidence/owasco-local-median/development-audit.json)
- [Execution receipt and artifact hashes](evidence/owasco-local-median/execution-receipt.json)
