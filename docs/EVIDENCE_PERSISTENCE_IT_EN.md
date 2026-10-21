# Conservare le prove / Retaining evidence

## Italiano

### Regola ed esempio

Una ricevuta esportabile aiuta soltanto se rimane disponibile. Il passo successivo
è conservarla insieme al risultato, senza cambiare le osservazioni firmate o la
regressione. Il risultato numerico conserva il suo `assessmentId`; il pacchetto
completo riceve un ID separato, restituito come `evidenceReceiptId`:

```text
receiptId = SHA-256("receipt:" + canonicalJson(evidenceReceipt))
```

Esempio: sei misure producono il risultato A e la ricevuta R. Domani arrivano
altre misure, il registro delle chiavi cambia o l'app viene riavviata. Con R
possiamo recuperare il pacchetto originale da PostgreSQL e verificarlo offline
contro le chiavi fidate conservate separatamente. Non viene rifatto il calcolo
usando la nuova finestra o le nuove chiavi.

L'hash del risultato non includeva firme e chiavi. Due pacchetti diversi possono
quindi accompagnare lo stesso risultato A: ricevono ID distinti R1 e R2 e vengono
conservati entrambi. Nessuno sostituisce silenziosamente l'altro. Stesso JSON
canonico significa stesso ID e salvataggio idempotente; l'ordine degli array è
significativo. Il formato della ricevuta resta `virdacora-evidence-receipt-v1`.

### Salvataggio congiunto

`POST /v1/assessments/run` usa `saveAssessmentWithReceipt` e restituisce
`assessment`, `decision`, eventuale `actionDraft`, `evidenceReceipt` ed
`evidenceReceiptId`. Prima di valutare la politica, PostgreSQL salva risultato
e ricevuta in una transazione su un solo client:

1. copia e valida il pacchetto prima di attendere una connessione;
2. inserisce il risultato se assente;
3. confronta il risultato persistito con quello della ricevuta;
4. inserisce la ricevuta e controlla il contenuto anche in caso di ID già presente;
5. esegue il commit e solo dopo prosegue con la politica.

Un errore accertato nell'inserimento della ricevuta fa annullare anche il nuovo
risultato. Un corpo incompatibile già presente sotto lo stesso `assessmentId`
produce `409 ASSESSMENT_CONFLICT`, senza riscrivere la storia. Il vecchio metodo
interno `saveAssessment` mantiene il comportamento precedente per i suoi chiamanti.
I risultati già esistenti possono ricevere una ricevuta fornita esplicitamente
soltanto se il loro corpo coincide; non c'è ricostruzione automatica.

Le righe sono aggiunte senza sovrascrittura dall'app. La concorrenza fra primi
inserimenti usa i vincoli univoci e `ON CONFLICT`; non richiede il privilegio
`UPDATE`. La chiave esterna impedisce ricevute senza un risultato associato.
In memoria, tutte le validazioni e copie precedono la pubblicazione sincrona
della coppia; le letture restituiscono copie profonde. **La memoria non sopravvive
alla terminazione del processo.**

### Recupero e verifica

```text
GET /v1/evidence-receipts/<receiptId>
x-oracle-token: <token configurato, non pubblicarlo>
```

Il recupero richiede lo stesso token Oracle dell'esecuzione: il pacchetto contiene
misure granulari. Restituisce la ricevuta direttamente, con `Cache-Control:
no-store`; token errato → 401, ID malformato autorizzato → 400, ricevuta assente
→ `404 EVIDENCE_RECEIPT_NOT_FOUND`. L'endpoint latest resta invariato e piatto.

Una singola lettura SQL collega ricevuta e risultato. Il deposito controlla che
l'ID corrisponda al contenuto e che il risultato coincida; una ricevuta archiviata
incoerente causa un errore generico 500, senza riparazione automatica o dettagli
del database. Non consulta le chiavi attuali né ricalcola una finestra diversa.

**Recuperare non significa autenticare l'ambiente.** Il controllo del deposito
non riesegue firme e modello e non rende fidate le chiavi incluse nel pacchetto.
Per la verifica completa resta necessario:

```sh
pnpm verify:evidence receipt.json trusted-registry.json
```

Il secondo file deve provenire da una fonte fidata separata. Il nuovo ID non è
una firma dell'Oracle e non cambia questa regola. Chi controlla coerentemente
database e registro può ancora selezionare o occultare prove: qui non si dimostra
completezza, calibrazione, verità fisica o resistenza globale alla censura.

### Migrazione, esiti incerti e controlli

La migrazione additiva `services/oracle/db/003_evidence_receipts.sql` crea
`assessment_evidence(receipt_id, assessment_id, body)` e un indice per risultato.
È rieseguibile; non riscrive dati o timestamp precedenti. Su un database esistente
va applicata dopo 001/002, con backup verificato, scrittori fermati e
`ON_ERROR_STOP`. Non è stata applicata a database esistenti durante questo lavoro.
Compose la usa soltanto nell'inizializzazione di volumi nuovi. Readiness richiede
nuova tabella, colonne e accessi SELECT/INSERT, senza scritture di prova.

Le ricevute legacy mancanti restano mancanti: il solo hash non recupera la vecchia
finestra. Servono conservazione e backup del database e degli ID. Il successivo
[catalogo limitato](RECEIPT_CATALOG_IT_EN.md) permette ora di trovare gli ID delle
ricevute partendo da un risultato noto. Nessuna replica, distribuzione o pubblicazione
on-chain viene introdotta. Un rollback del codice può mantenere la tabella;
cancellarla distruggerebbe le ricevute conservate.

Una risposta COMMIT persa o un timeout lascia un esito da accertare: non prova
mancato salvataggio o annullamento. Non ci sono retry automatici né garanzie
exactly-once. Se l'ID è noto si può interrogare il deposito; altrimenti occorre
ricostruire cosa è accaduto, senza inventare una risposta.

I test aggiunti coprono copie profonde, varianti, idempotenza, accesso, errori,
concorrenza fra pool, errore reale della seconda scrittura con rollback e recupero,
riapertura di client/app, cambiamenti di archivio/chiavi, conflitti legacy e
alterazione delle ricevute nel deposito. Gli esiti effettivi sono riportati nelle
ricevute sanificate e nella PR; casi saltati non valgono come test PostgreSQL.
Sono controlli software sintetici: previsioni, dati ambientali reali, governance,
contratti e fondi restano invariati.

## English

An exported receipt must remain available. Successful assessment runs now retain
the exact packet together with the assessment and return `evidenceReceiptId`.
The ID is SHA-256 of `"receipt:" + canonicalJson(fullPacket)`: unlike existing
assessment/evidence IDs it commits signatures and public-key bindings too.
Distinct packets for one assessment get distinct immutable identities; identical
canonical packets are idempotent. Array order matters. The v1 format, original
signed observations, numerical recipe and previous hashes are unchanged.

For example, six readings produce assessment A and receipt R. Later readings,
key-registry changes or an application restart do not replace R. Retrieve R from
PostgreSQL and verify it offline with separately retained trusted keys.

PostgreSQL writes on one client within a transaction: snapshot before pool wait,
insert assessment if absent, compare its full existing body, insert/check receipt,
then commit. A confirmed receipt-insert failure rolls back a newly inserted
assessment. An incompatible historical assessment body gives
`409 ASSESSMENT_CONFLICT` without overwriting it. The legacy internal
`saveAssessment` method keeps its original behavior. Explicitly supplied receipts
may attach to identical historical bodies; missing historical packets are never
fabricated. Unique constraints handle concurrent inserts without requiring UPDATE
permission; the foreign key prevents orphan receipts. In-memory storage publishes
the pair synchronously after validation and deep copies; it is not persistent.

`GET /v1/evidence-receipts/:receiptId` requires `x-oracle-token`, returns the packet
directly and sets `Cache-Control: no-store`. Wrong token → 401; malformed authorized
ID → 400; absent packet → `404 EVIDENCE_RECEIPT_NOT_FOUND`. A single SQL statement
reads receipt and parent assessment. Content-ID/parent inconsistency gives static
500 without leaking database details or repairing records. Retrieval does not
select a new window, reread current keys, verify signatures or rerun the model.

The offline command remains `pnpm verify:evidence receipt.json trusted-registry.json`.
Its external trusted registry is mandatory. Retrieval consistency and a content
ID are not an Oracle signature, independent key authority, physical truth,
calibration, completeness or global censorship resistance.

Additive migration `003_evidence_receipts.sql` creates `assessment_evidence` and
an assessment lookup index without changing historical rows. Apply it after
001/002 to the intended database, with verified backup, stopped writers and
`ON_ERROR_STOP`. This work does not migrate existing user databases. New-volume
Compose initialization and isolated test runners include it; readiness requires
its columns and SELECT/INSERT access. Code rollback can retain this additive
table; dropping it destroys evidence. PostgreSQL/client reopening is tested;
in-memory shutdown still loses the store.

Retain IDs, backups and preferably external copies. Legacy missing receipts stay
missing. The subsequent [bounded catalog](RECEIPT_CATALOG_IT_EN.md) now discovers
receipt IDs from a known assessment ID. There is no replica
or automatic on-chain publication. Lost COMMIT replies/timeouts leave uncertain
outcomes, with no automatic retries or exactly-once claim. A known ID can be
looked up; otherwise the outcome needs investigation.

New tests cover copies, packet variants, idempotence, authentication and errors,
cross-pool concurrency, actual second-write rejection/rollback/recovery,
application/client reopening, archive/key changes, legacy conflicts and corrupted
stored packets. Actual results are recorded separately; skipped cases are not
database validation. These are synthetic software checks. Virdacora's original
mission remains checkable environmental evidence supporting accountable community
decisions, without changing forecasts, governance, contracts or funds.
