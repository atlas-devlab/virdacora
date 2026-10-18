# Ordinamento temporale comune / Shared timestamp ordering

## Italiano

La PR #24 ha introdotto i test su PostgreSQL reale ed è stata integrata in
`main` con commit `c204caeb2fbba78350898d73898cf58765185e08`.
La sua CI successiva al merge, [39129257085](https://github.com/atlas-devlab/virdacora/actions/runs/39129257085), è passata.
Quella suite ha documentato un difetto: memoria e analisi usavano millisecondi,
mentre PostgreSQL ordinava al microsecondo. Con un limite di lettura potevano
quindi scegliere prove diverse dagli stessi ingressi.

### Regola spiegata prima del codice

1. La chiave temporale è l'istante UTC espresso in millisecondi interi,
   secondo `Date.parse` nel runtime Node.js del progetto. Le cifre dopo la
   terza frazione di secondo sono ignorate, senza arrotondamento.
2. A parità di chiave, decide l'ID esadecimale minuscolo in ordine ASCII.
   JavaScript confronta con `<`/`>`; PostgreSQL usa `COLLATE "C"`.
3. La lettura sceglie le ultime N coppie `(millisecondi, ID)` e le restituisce
   in ordine crescente. La valutazione più recente è la coppia massima.
4. Timestamp non interpretabili sono rifiutati con `INVALID_TIME` prima di
   scrivere, consumare una sequenza o riservare un ID.

| Osservazione | Timestamp originale | Chiave nel secondo | Ordine |
|---|---|---|---|
| ID ...01 | `12:00:00.1239Z` | 123 ms | prima |
| ID ...02 | `12:00:00.1231Z` | 123 ms | seconda |

Con limite 1 viene scelta ...02. Non significa che le misure siano fisicamente
simultanee: il sistema assegna pari priorità temporale entro il millisecondo.
Questa scelta mantiene la risoluzione dell'analisi esistente. Un'analisi futura
al microsecondo richiederebbe un contratto esplicito e nuove verifiche.

### Implementazione e integrità delle prove

`timestamp-order.ts` centralizza chiave e spareggio. Memoria e analisi lo
condividono; le formule numeriche e la versione del modello non cambiano.
PostgreSQL aggiunge `observed_at_ms` e `generated_at_ms`, entrambi `BIGINT`, e
indici per regione, metrica, chiave e ID. Le query limitate possono usare questi
indici senza ricalcolare una funzione sul JSONB a ogni lettura.

Il testo originale, il corpo JSONB, le firme, gli ID e le colonne `TIMESTAMPTZ`
restano intatti. La chiave aggiunta serve solo a selezione e ordinamento.
La parità dell'evidence hash è verificata quando i due archivi selezionano gli
stessi ingressi; una selezione PostgreSQL corretta può invece cambiare il
risultato rispetto al suo precedente comportamento difettoso.

Non basta `date_trunc('milliseconds', observed_at)`: PostgreSQL può aver già
arrotondato `.1239999` a `.124000`. Il backfill della migrazione 002 legge il
testo originale, tronca prima del cast e calcola `floor(epoch * 1000)`. Gestisce
anche istanti precedenti al 1970: `1969-12-31T23:59:59.9999999Z` dà -1 ms.

### Verifiche eseguite

- PostgreSQL 18.6 reale, container locale temporaneo: **29 prove passate,
  zero fallite e zero saltate**.
- Suite ordinaria: **104 prove passate**, con le 29 prove DB visibilmente
  saltate ed eseguite separatamente dal runner obbligato alla configurazione.
  Build, controlli TypeScript e configurazione Compose riusciti.
- Parità di osservazioni e latest assessment: submillisecondi, 7/9 decimali,
  passaggio di giorno, epoca negativa, offset equivalenti, formato senza
  secondi, ID contenenti cifre e lettere, limiti 1/2/N e arrivi invertiti.
- Migrazione di un archivio 001 popolato con osservazioni firmate: backfill
  esatto anche sotto fuso non UTC, originale e firma validi dopo l'upgrade,
  riesecuzione idempotente. Due casi legacy incompatibili verificano errore
  e rollback completo di colonne, indici e dati.
- Stesse prove selezionate nei due archivi e stesso risultato dell'analisi,
  incluso `evidenceHash`; firme Ed25519 e replay verificati attraverso l'API.
- `EXPLAIN` con `enable_seqscan=off` verifica che gli indici corrispondano alle
  query, senza sort aggiuntivo. È un controllo di disponibilità dell'indice,
  non un benchmark del piano scelto normalmente o della latenza.

Le ricevute di questa modifica sono in `docs/evidence/timestamp-order/`.
Quelle in `docs/evidence/postgres-real/` rimangono la fotografia storica della
PR #24, prima della correzione.

### Installazione e archivi preesistenti

Su un volume **nuovo**, Compose applica 001 e 002 nell'ordine. I file di init
PostgreSQL non aggiornano automaticamente un volume già popolato.

Per un archivio esistente: verificare un backup, arrestare tutti i writer,
applicare 002 con arresto al primo errore, poi avviare la versione nuova.
Esempio per il Compose di sviluppo, dalla radice del repository:

```sh
docker compose stop oracle
docker compose exec -T postgres psql -X -U terravoce -d terravoce -v ON_ERROR_STOP=1 < services/oracle/db/002_timestamp_order.sql
docker compose up -d --build oracle
```

La migrazione è transazionale e prende lock sulle tabelle: pianificare una
finestra di manutenzione per archivi grandi. Se il corpo legacy manca del
timestamp ISO con offset esplicito o contiene un valore incompatibile, si
interrompe: non inventa un fuso né riscrive una prova per completare l'upgrade.
Non si riavviano i writer finché la verifica della migrazione non è riuscita.
Il vecchio writer non popola le nuove colonne `NOT NULL`: un rollback deve
quindi usare codice compatibile con le chiavi oppure ripristinare uno stato
coerente dal backup, con i writer arrestati. Non basta cambiare l'immagine.

Qui sono stati modificati esclusivamente database di test temporanei.
Il dominio di input completo non è stato ampliato: lo schema ISO attuale può
ammettere casi che PostgreSQL rifiuta, per esempio anno 0000 o offset estremi.
La parità verificata riguarda i timestamp validi per entrambi i backend.

Questi sono controlli software su dati sintetici. Non dimostrano accuratezza
dei sensori, abilità previsionale, recupero dopo crash o prestazioni operative.
Rafforzano la riproducibilità delle prove, mantenendo separati analisi,
intervento limitato e diritti delle comunità.

## English

PR #24 was merged into `main` at `c204cae`; its post-merge CI passed. It exposed
a selection mismatch: memory and analysis used milliseconds, while PostgreSQL
sorted at microsecond resolution. Bounded reads could select different evidence.

The rule was explained before implementation: order by UTC epoch milliseconds,
then lowercase hexadecimal ID in ASCII order. Fractional digits after the third
are ignored without rounding. Return the latest N pairs in ascending order;
the latest assessment is the maximum pair. Invalid parsed times fail before
reserving an ID or sequence. Equal ordering priority is not physical simultaneity.

For example, ID ...01 at `.1239Z` precedes ID ...02 at `.1231Z`: both have key
123 ms. A limit of one selects ...02. This preserves the existing analysis
resolution; adopting microseconds would require a separately verified contract.

A shared helper drives memory and analysis. PostgreSQL stores separate BIGINT
ordering keys with matching time-and-ID indexes. Original signed text, JSONB,
IDs, signatures and TIMESTAMPTZ columns remain unchanged. Numerical formulas
and model version are unchanged. Correcting the old PostgreSQL selection may
change assessments compared with its previous behavior; equal selected inputs
are tested to produce equal evidence hashes across backends.

Migration 002 derives legacy keys from original JSONB text, truncating the
fraction **before** PostgreSQL can round to microseconds, then using
`floor(epoch * 1000)`. This handles excess precision, offsets and negative
epochs. It is transactional, repeatable, and rejects incompatible legacy text.

Local PostgreSQL 18.6 passed **29 real database tests with no failures or
skips**: bounded tails, latest assessments, submillisecond boundaries, offsets,
negative epochs, signed legacy upgrade, repeat application, two rollback cases,
index availability, identical selected evidence/hashes, API signatures and
replay rejection. Forced EXPLAIN index checks are not production benchmarks.
The ordinary suite passed 104 tests; its 29 visibly skipped database cases were
run separately with the dedicated runner. Build, type checks and Compose
configuration checks also passed.

Fresh Compose volumes run both init files. Existing volumes require a verified
backup, stopped writers, explicit migration with `ON_ERROR_STOP`, and the new
writer only after successful migration. The migration takes table locks. The
old writer omits the new NOT NULL keys; rollback needs compatible code or a
coherent restore with writers stopped. No existing user database was modified.

These synthetic software checks do not validate physical observations,
forecast skill, crash recovery or production performance. The full accepted
timestamp domain remains a separate issue: some ISO values accepted by the
protocol, such as year 0000 or extreme offsets, are rejected by PostgreSQL.

## Primary references

- [ECMAScript time values](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-time-values-and-time-range): integer millisecond time values; project tests pin actual Node.js parsing behavior.
- [PostgreSQL 18 date/time types](https://www.postgresql.org/docs/18/datatype-datetime.html): microsecond timestamp resolution and UTC handling.
- [PostgreSQL collations](https://www.postgresql.org/docs/18/collation.html): explicit deterministic C ordering for protocol IDs.
- [Official PostgreSQL image](https://hub.docker.com/_/postgres): initialization scripts apply to an empty data directory.
