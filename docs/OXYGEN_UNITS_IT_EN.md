# Unità dell'ossigeno e prove firmate / Oxygen units and signed evidence

## Italiano

La correzione riguarda il modello illustrativo TypeScript dell'Oracle su `main`,
non gli esperimenti di previsione Owasco. È una prova sintetica di correttezza
dell'interpretazione delle misure, non una nuova dimostrazione di abilità
previsionale o validità ecologica delle soglie.

### Regola prima del calcolo

Per la sola metrica `water.oxygen.mg_l`, i numeri dell'analisi sono espressi in
mg/L. Il registro ammette esattamente:

| Unità originale firmata | Numero usato nell'analisi |
| --- | --- |
| `mg/L` | valore originale |
| `ug/L` | valore originale / 1000 |
| `µg/L`, segno micro U+00B5 | valore originale / 1000 |
| `μg/L`, lettera greca mu U+03BC | valore originale / 1000 |

Quindi `6 mg/L` e `6000 µg/L` producono lo stesso valore analitico: **6 mg/L**.
La conversione avviene in un vettore numerico separato, prima della regressione,
dell'anomalia e del rischio. Anche valore corrente e pendenza usano questo
vettore; la pendenza è in mg/L per ora. Non si costruiscono oggetti con una firma
originale associata a valori sostituiti.

Nessun trim, cambio di maiuscole o normalizzazione Unicode viene applicato al
payload. `ppm`, `%`, `g/L`, `mg/l` e unità con spazi non sono conversioni
implementate: vengono respinte, senza tentare di indovinare il significato.
Non è un sistema universale di unità: le altre metriche mantengono il precedente
comportamento e la versione `terravoce-linear-risk-v1`.

### Cosa resta intatto

L'API verifica prima la firma del messaggio originale. Controlla poi tempo e
unità, e archivia quel messaggio senza modificarne valore, stringa dell'unità,
firma, timestamp, sequenza o ID. Un'unità dell'ossigeno non supportata ma firmata
correttamente restituisce `422 INVALID_OBSERVATION_UNIT` prima dell'inserimento;
non riserva la sequenza. Una modifica di valore o unità senza nuova firma resta
un errore `401 INVALID_SIGNATURE`.

Le righe già archiviate con unità supportate sono interpretate alla lettura,
senza UPDATE o nuova firma. Se la finestra selezionata contiene anche una sola
unità dell'ossigeno non supportata, il calcolo restituisce 422: niente nuova
valutazione, esame della policy o bozza d'azione. La riga non viene ignorata né
cancellata. Una firma valida dimostra l'autenticità del messaggio rispetto alla
chiave, non l'accuratezza fisica del sensore.

### Versioni e lettura dell'ultimo risultato

La nuova interpretazione dell'ossigeno è identificata da
`terravoce-linear-risk-v2-oxygen-units`. La formula della regressione e la policy
restano le stesse; cambia l'interpretazione delle unità in ingresso.

I risultati storici v1 non vengono riscritti o ricalcolati automaticamente.
L'endpoint pubblico `/latest` dell'ossigeno cerca soltanto la versione corrente.
Se esistono soltanto risultati vecchi, risponde `404 ASSESSMENT_NOT_FOUND` finché
un operatore autorizzato esegue con successo un nuovo `/assessments/run`.
La data di misura non viene sostituita con l'ora di esecuzione per forzare
l'ordinamento. Un v1 con ID maggiore, o con data più recente, non nasconde un v2.

Dentro la versione richiesta si mantiene l'ordinamento per millisecondi della
misura, poi ID esadecimale. La chiamata interna allo store senza filtro mantiene
il contratto precedente, anche se vince un v1. PostgreSQL filtra il campo versione
del JSONB con un parametro; memoria conserva un indice separato per versione.
Nessuna migrazione SQL. Il filtro non ha un nuovo indice SQL dedicato: su archivi
molto grandi il costo della ricerca per versione va misurato, non promesso.

Misure fisicamente equivalenti con payload originali diversi hanno gli stessi
risultati numerici e decisioni deterministiche, ma **ID, firme e hash delle prove
restano distinti**. L'hash continua a riferirsi agli ID originali e alla versione
che li interpreta. Stessi payload, stesso ordine temporale e stessa versione
devono invece riprodurre lo stesso hash, anche se cambia l'ordine d'arrivo.

### Test e limiti

Il controllo iniziale ha riprodotto 13 fallimenti su 19 casi: valori micro usati
come milligrammi, ingressi incompatibili accettati e valutazioni legacy prodotte.
Un secondo controllo ha riprodotto quattro fallimenti del filtro per versione.
Le nuove prove includono serie non costanti, ultima misura in microgrammi,
permutazioni, input congelati, firme Ed25519 reali, memoria e PostgreSQL reale.

Il caso piatto `6 mg/L` / `6000 µg/L` deve restituire valore corrente 6,
previsione a un'ora 6, pendenza 0 e anomalia 0. Un altro caso sintetico confronta
`2 mg/L` / `2000 µg/L` nella policy illustrativa: la decisione deve essere la
stessa. Si produce soltanto una bozza reversibile; nessuna azione o fondo reale
viene eseguito. La confidence resta un'euristica non calibrata.

Esecuzione: `pnpm build`, `pnpm check`, `pnpm test`; per il database occorre
`pnpm test:postgres` con l'URL di un database locale di test dedicato. Il comando
ordinario salta esplicitamente la suite PostgreSQL senza quell'URL: i test
saltati non contano come test reali passati. Le ricevute sanificate sono in
`docs/evidence/oxygen-units/verification.json`.

## English

This change concerns the illustrative TypeScript Oracle model on `main`, not
the Owasco forecasting experiments. It tests measurement interpretation with
synthetic data; it does not establish new forecasting skill or ecological
validity of the example thresholds.

For `water.oxygen.mg_l` only, analysis uses mg/L. The exact accepted strings are
`mg/L`, `ug/L`, `µg/L` (U+00B5) and `μg/L` (U+03BC). The three microgram spellings
are divided by 1000 in a separate numeric vector. Current value, regression,
slope, anomaly and risk all consume that vector. No signed observation object
is rewritten, even on a copy. No trimming, case folding or Unicode rewriting
of evidence is performed; ppm, saturation percentages and other conversions are
not inferred. Other metrics retain their previous behavior and v1 identity.

The API first verifies the original signature, then checks time and the unit
contract before inserting the original record. Unsupported oxygen units return
`422 INVALID_OBSERVATION_UNIT` without consuming a sequence. Changing raw value
or unit without re-signing still returns `401 INVALID_SIGNATURE`. Raw values,
unit spelling, signatures, observation IDs and timestamps remain unchanged in
memory and JSONB, including after analysis and reopening the database client.

Supported legacy observations are converted only when read for analysis. If any
selected legacy oxygen record has an unsupported unit, the whole assessment run
fails with 422 before saving an assessment, evaluating policy or drafting an
action. Records are never silently skipped or deleted.

The oxygen interpretation is versioned as
`terravoce-linear-risk-v2-oxygen-units`. Existing assessments are not rewritten
or automatically recalculated. Oxygen `/latest` selects only the current
version; an archive containing only old assessments returns 404 until an
explicit authorized current-version run succeeds. This prevents a larger old
ID at the same timestamp, or a newer old-version timestamp, from hiding the
corrected result. Measurement time is not replaced by execution time. Within a
version, the established millisecond/hex-ID ordering remains unchanged. The
internal unfiltered store method keeps its old behavior. No schema migration
or dedicated SQL version index is introduced; large-history query cost remains
to be measured.

Equivalent physical values must yield equal numerical assessments and policy
decisions, but different original messages must retain different evidence IDs
and hashes. Reordering the same originals must reproduce the same result/hash.

Tests cover all accepted micro spellings, nonlinear series with a microgram
latest value, frozen inputs, real Ed25519 signatures, incompatible units,
sequence reuse, legacy archives, current-version latest selection, and actual
PostgreSQL JSONB round trips. The flat 6/6000 case yields current and one-hour
forecast 6 mg/L, slope 0 and anomaly 0. A synthetic critical 2/2000 case compares
the same illustrative policy decision; it creates a reversible draft only.
No physical action, funding, September data or new model training is involved.
Confidence remains an uncalibrated demonstration heuristic.

Run build/check/test normally and the dedicated PostgreSQL suite against an
isolated local test database. Ordinary skipped database cases are not evidence
of real database validation. Sanitized verification receipts are kept alongside
this document.
