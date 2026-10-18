# PostgreSQL reale: integrazione e verifiche / real database validation

Questo documento e le sue ricevute descrivono la PR #24 prima della correzione
temporale. La [regola comune e la migrazione successiva](TIMESTAMP_ORDER_IT_EN.md)
sostituiscono il limite di ordinamento qui documentato e ampliano la suite a 29 prove.
This document records PR #24 before the timestamp fix; see the linked update for
the current ordering contract, migration and expanded test suite.

## Italiano

Virdacora deve conservare prove ambientali riproducibili e rifiutare i replay
anche quando arrivano da processi diversi. Questo intervento verifica l'Oracle
contro PostgreSQL reale, dopo l'integrazione della PR #22. Non cambia analisi,
firme, regole TerraLex, contratti o diritti delle comunità.

### Dipendenze e merge verificati

| PR | Destinazione effettiva | Merge |
|---|---|---|
| #22, archivio e API Oracle | `main` | `337c7b2ed4f86c83ea2401a465f3f5b74f2a4d61` |
| #23, trasporto USGS | `feat/owasco-local-median-implementation` | `5d74baa290c8d5f388aac7aec8ebbc1cf5780be9` |

Le due CI precedenti erano verdi sugli head esatti e nessuna PR aggiungeva
pacchetti o modificava il lockfile. La #23 dipende dal modulo environmental-case
del ramo di ricerca, assente da `main`: non è stata spostata su `main`, scelta
che avrebbe portato anche 57 commit e 362 file a monte. Il suo merge non
promuove il risultato numerico Owasco e non integra l'intera ricerca in `main`.
I test PostgreSQL partono invece dal `main` aggiornato con la #22.

### Ambiente e isolamento

Il test locale usa PostgreSQL 18.6, in un nuovo container con immagine esatta
`postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`.
Porta dinamica su `127.0.0.1`, dati temporanei in tmpfs, nessun volume o database
esistente. L'immagine è la stessa del nuovo job CI, fissata al digest osservato.
Non vengono installati nuovi pacchetti Node.

Il runner richiede esplicitamente `VIRDACORA_TEST_DATABASE_URL`; non recupera
`DATABASE_URL`. Accetta solo host di loopback e nomi dedicati `virdacora_test`
o un suffisso consentito. Rifiuta parametri URL e frammenti, evitando override
di host o database da parte del parser di connessione.

Ogni caso crea uno schema casuale interno `virdacora_test_<32 cifre esadecimali>`.
Tutti i pool ricevono soltanto quello schema nel `search_path`, verificato
prima della migrazione. Si applica `services/oracle/db/001_init.sql` senza
modificarlo. La pulizia chiude i client e rimuove esclusivamente lo schema
generato e creato da quella fixture. Non si usa una transazione esterna per
simulare l'isolamento: l'Oracle apre pool e client propri.

### Cosa deve dimostrare il test

- Vincoli veri: ID univoco, coppia sensore/sequenza univoca e riferimento al
  sensore, senza scritture parziali dopo un rifiuto.
- Concorrenza fra due istanze: 16 invii concorrenti devono produrre una sola
  riga e 15 errori di replay. Non si presume quale richiesta vinca la corsa.
- Lettura: arrivi mescolati, timestamp uguali, offset equivalenti, regioni e
  metriche diverse devono produrre le code ordinate attese.
- Valutazioni: un risultato vecchio in ritardo non deve spostare il più recente;
  un ID già presente deve conservare il corpo originale.
- Riapertura: chiudere e ricreare i client non deve perdere sensori, misure o
  valutazioni. Questo non equivale a un riavvio del server o a crash recovery.
- API: firme Ed25519 generate per il test, acquisizione e rifiuto dei replay
  contro il vero database; una firma alterata non deve aggiungere righe.

I dati sono sintetici, anche quando firme e vincoli SQL sono reali. Un successo
verifica la conservazione e il percorso software, non la verità fisica di un
sensore, l'accuratezza delle previsioni o un beneficio ecologico.

### Un limite temporale già noto

JavaScript `Date.parse` distingue i millisecondi; PostgreSQL distingue i
microsecondi. Un caso separato caratterizza `.1231Z` e `.1239Z`, senza chiamarlo
parità fra backend e senza riscrivere timestamp firmati. La precisione del
database è descritta nella [documentazione PostgreSQL 18](https://www.postgresql.org/docs/18/datatype-datetime.html).

## English

PR #22 was merged into main at `337c7b2`; PR #23 was merged into its existing
research base at `5d74baa`, not main. Both exact-head CI runs passed before
integration; neither changed package dependencies or the lockfile. Retargeting
#23 would have imported unrelated upstream research. Real database tests use
the updated main Oracle without promoting numerical experiments.

The local server is an isolated PostgreSQL 18.6 container, pinned to the same
image digest as CI, with loopback-only dynamic port and throwaway tmpfs data.
Tests require an explicit dedicated test URL and reject remote hosts, ordinary
database names, query overrides and fragments. Each case creates an internally
generated schema, verifies its exclusive search_path, applies the unchanged
migration, then closes owned pools and removes only its own created schema.
No existing database, volume, environmental observation or real fund is used.

The suite checks real uniqueness/foreign-key constraints, concurrent writers
from separate pools, rejected-write integrity, ordered bounded tails,
out-of-order assessments, duplicate IDs, persistence across client reconnection,
isolated read snapshots and signed API requests. Persistence here means closing
and reopening clients, not server restart, power failure or crash recovery.
An explicit characterization preserves the known JavaScript-millisecond versus
PostgreSQL-microsecond ordering difference; it does not normalize signed data.

Synthetic inputs with real signatures and SQL constraints validate software
behavior, not physical sensor truth, forecasting skill or ecological outcomes.
No forecast recipe, protocol, governance rule or contract changes.

## Commands / Comandi

Use only a throwaway local database named `virdacora_test` (or a supported test
suffix). Configure the dedicated environment variable without committing its
value. Then, from the repository root:

```sh
pnpm build
pnpm test:postgres
```

The dedicated command fails when configuration is missing or rejected.
The ordinary unit suite can visibly skip database cases when no URL is supplied;
that is never reported as successful database validation. The separate CI job
requires and runs the real database suite, following the
[GitHub service-container pattern](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers).
Connection-scoped options are described in the
[PostgreSQL connection reference](https://www.postgresql.org/docs/18/libpq-connect.html).

## Execution results / Risultati

The plan above was written before the first local integration-suite run.
Actual results and limitations are recorded below after execution.

### Italiano: esito locale

Il 18 ottobre 2026 la versione definitiva ha eseguito **15 prove reali:
15 passate, zero fallite, zero saltate**, contro PostgreSQL 18.6. Il runner
Node 24.18.0 su Windows x64 comunicava via TCP con il container Linux x64.
I controlli aggiuntivi di configurazione sono 37, tutti passati senza query.
Build, typecheck del workspace e dei nuovi file di test passano. La suite
ordinaria conta 84 test passati e 15 prove DB visibilmente saltate senza URL:
queste ultime sono state eseguite separatamente con il runner obbligatorio.

Sono passate le tre corse a 16 scrittori: registrazione sensore, osservazione
identica e ID diversi con la stessa sequenza. Ogni corsa conserva un solo
vincitore nel database e respinge gli altri 15. Passano anche i riferimenti al
sensore, la riutilizzabilità della chiave dopo un conflitto rifiutato, i
timestamp testuali originali nel JSONB, le code ordinate e la riapertura dei
client. L'API verifica firme Ed25519 effettive sui dati sintetici; una firma
alterata viene rifiutata e non consuma la sequenza libera.

Il caso temporale conferma la differenza già nota: due timestamp con frazioni
di millisecondo possono avere ordine e risultato “più recente” diversi nei due
backend. È un limite reale da risolvere con un contratto temporale esplicito,
non un successo di parità. Questa prova non riscrive osservazioni o firme.

Il runner senza URL dedicato fallisce con codice non zero anche se è presente
un `DATABASE_URL` ordinario. A fine prova: **zero schemi residui, zero tabelle
in public**; container e file temporanei di credenziali rimossi. Le CI successive
ai merge sono passate: #22 su main, run `39128299745`; #23 sul ramo di ricerca,
run `39128306447`.

La nuova CI aggiunge un job dedicato che richiede configurazione ed esecuzione effettiva su PostgreSQL. I nuovi
test non modificano codice produttivo, migrazione SQL, dipendenze, contratti o
esperimenti numerici. Non sono una misura di capacità produttiva, disponibilità
del servizio, recupero da crash o accuratezza ambientale.

### English: local outcome

The definitive local suite on 18 October 2026 passed **15 real database tests,
with zero failures or skips**, using PostgreSQL 18.6 in Linux x64 Docker and
Node 24.18.0 on Windows x64 over TCP. All 37 non-database configuration guards,
workspace build/typechecks and explicit fixture/runner/test typechecks passed.
The ordinary suite passed 84 tests and visibly skipped its 15 database cases
without a URL; the required database runner executed those cases separately.

Sixteen-writer races across separate pools, actual uniqueness/foreign-key
constraints, conflict atomicity, bounded ordering, JSONB snapshots, late
assessments, client reconnection and signed API ingestion passed. The known
submillisecond ordering/latest-result difference was reproduced and retained
as a limitation, without rewriting signed timestamps. Missing dedicated test
configuration fails rather than falling back to an ordinary DATABASE_URL.

Cleanup left no test schemas or public tables; the disposable container and
temporary credential files were removed. Both post-merge CI runs succeeded:
39128299745 for main after #22, 39128306447 for the research base after #23.
The new dedicated real-PostgreSQL CI job makes this check repeatable. Production
code, SQL migration, lockfile, contracts and frozen research inputs are unchanged.
No production performance, crash-recovery, field or forecasting claim follows.

[Sanitized local test results](evidence/postgres-real/local-results.json) ·
[Verification, exact hashes and cleanup receipt](evidence/postgres-real/verification.json).
