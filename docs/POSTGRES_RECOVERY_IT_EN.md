# Interruzioni e recupero PostgreSQL / PostgreSQL interruption recovery

## Italiano

La PR #25 è stata integrata in `main` con commit
`8e7f02e48f6317be9592ef0e8b723714a33fa2ae`; la sua CI successiva al merge,
[39129955093](https://github.com/atlas-devlab/virdacora/actions/runs/39129955093), è passata.
Il passo seguente verifica cosa accade quando il database si ferma, riparte
oppure rimane acceso ma una scrittura viene bloccata.

### Difetto riprodotto prima della correzione

Con il codice precedente, il worker Oracle ha accettato sette osservazioni
sintetiche firmate e conservato una valutazione. All'arresto pulito del
database è terminato con codice 1: il pool aveva emesso un evento `error`
su una connessione inattiva, senza un gestore. Gli scenari successivi non
sono stati eseguiti nella baseline. Il programma padre ha comunque rimosso
il container, il volume e il file temporaneo delle credenziali.

Il difetto è stato osservato in un processo separato, senza installare un
gestore globale che nascondesse eccezioni. Anche quattro degli otto test
mirati fallivano prima della modifica; quattro già verificavano correttamente
assenza di retry e chiusura attesa del pool.

### Modifica al driver

Il pool gestisce ora l'errore inattivo con un warning statico
`POSTGRES_IDLE_CONNECTION_LOST`. Non pubblica errore originale, URL, password
o oggetto client. Il driver elimina già la connessione guasta; la successiva
operazione può crearne una nuova. Non riavviamo l'Oracle e non ripetiamo
automaticamente le scritture.

I valori iniziali del pool sono:

| Controllo | Valore |
|---|---|
| Numero massimo di connessioni | 10 |
| Attesa per una connessione | 5 secondi |
| Limite di esecuzione sul server | 10 secondi |
| Attesa della query sul client | 12 secondi |

Sono limiti tecnici del prototipo, non SLA misurati. Un timeout del client
non prova che una scrittura non sia stata salvata: per questo non aggiungiamo
retry automatici a operazioni dall'esito incerto. Gli errori delle richieste
continuano a produrre il corpo API generico `500 {"error":"INTERNAL_ERROR"}`.

### Tre prove reali dopo la modifica

Il runner crea un volume persistente **nuovo**, un container PostgreSQL 18.6
con immagine fissata e credenziali casuali temporanee. I dati sono sintetici.
Verifica `fsync=on`, `synchronous_commit=on`, `full_page_writes=on` e il segnale
di arresto effettivo dell'immagine, `SIGINT`.
Lo stesso processo Oracle, applicazione e pool attraversano tutti i casi.

| Caso | Verifica | Risultato locale |
|---|---|---|
| Arresto pulito SIGINT, poi riavvio | processo Oracle vivo, dati già confermati e firme/hash invariati | PASS |
| SIGKILL, poi riavvio | uscita PostgreSQL 137 e indicatori di recupero automatico nei log | PASS |
| Scrittura bloccata con database acceso | annullamento per `statement_timeout` sul server, sblocco e nessun inserimento tardivo | PASS |

Per ogni caso si controlla il corpo API generico durante il guasto, poi lo
snapshot originale prima di un invio esplicito: nuovo invio 202, duplicato
409, dato alterato 401. Le osservazioni passano da sette a dieci tramite tre
nuovi invii confermati. Ogni risposta del worker è associata allo stesso PID.

Il caso del lock blocca soltanto la tabella delle osservazioni: la lettura del
sensore resta disponibile. La risposta 500 da sola non basta a superare la
prova: è richiesto anche l'indicatore di annullamento per timeout del server.
Prima del reinvio, lo snapshot verifica che l'inserimento bloccato non sia
comparso dopo il rilascio del lock. La transazione del blocco viene sempre
annullata e il relativo pool chiuso.

Sono passati anche **112 test ordinari**, inclusi gli otto nuovi controlli,
oltre a build e typecheck. Le 29 prove DB del comando ordinario risultano
visibilmente saltate: il job PostgreSQL separato le esegue realmente.
La nuova CI aggiunge un terzo job dedicato ai tre scenari di recupero.
Le ricevute locali, inclusa la baseline fallita, sono in
`docs/evidence/postgres-recovery/`.

### Riproduzione e isolamento

```sh
pnpm install --frozen-lockfile
pnpm --filter @terravoce/protocol build
pnpm --filter @terravoce/terralex build
pnpm test:postgres:recovery
```

Serve Docker funzionante. Il runner crea le proprie risorse: non legge
`DATABASE_URL` e non punta a un database esistente. Usa una porta libera
locale ma esplicitamente fissata per tutti i riavvii. Una porta Docker
assegnata come `0` può cambiare fra gli avvii: un primo tentativo del
programma di prova ha rilevato questo problema, corretto prima di accettare
il risultato. La baseline del codice vecchio è stata ripetuta con la porta
corretta e ha confermato il crash del worker.

Le interruzioni avvengono in un worker separato: il padre conserva la
responsabilità della pulizia anche se il worker termina. Prima di arrestare
o rimuovere verifica ID, nome, label proprietaria, volume e porta; prima di
rimuovere il volume controlla che nessun altro container lo usi. Alla fine
sono stati rimossi tutti gli asset della prova e il file temporaneo delle
credenziali. Non si usano reset Docker, prune o volumi esistenti.

I tempi nei risultati sono diagnostici. I log grezzi del worker e del database
non vengono pubblicati: il report conserva soltanto i dati sintetici necessari,
gli hash e indicatori booleani del recupero.

### Limiti che restano aperti

- `SIGKILL` interrompe il processo nel container: non simula perdita elettrica,
  guasto del disco, riavvio della macchina host o della VM Docker.
- Sono verificati record confermati prima dell'interruzione. Non si attribuisce
  un esito certo alle richieste in volo senza risposta, né una garanzia exactly-once.
- `/healthz` misura la vitalità del processo e può rispondere 200 mentre il DB
  è fermo: non è un controllo di disponibilità del database.
- Non sono prove di replica, failover, carico produttivo o precisione dei sensori.
  Non cambiano modelli previsionali, firme, regole, contratti o diritti delle comunità.

## English

PR #25 was merged at `8e7f02e`; its post-merge CI passed. The next experiment
tests database interruption and recovery rather than repeating timestamp checks.

The pre-fix Oracle accepted seven synthetic signed observations and saved an
assessment, then exited with code 1 when PostgreSQL stopped cleanly. A failed
idle connection emitted an unhandled pool `error`. Later baseline scenarios
were not executed. The parent still removed its own container, volume and
temporary credentials. No global exception handler masked the failure.

The production pool now handles idle errors with a static, sanitized warning.
node-postgres discards the failed idle client; a later operation can obtain a
new connection. Defaults are max 10 connections, 5 s connection wait, 10 s
server statement timeout and 12 s client query wait. These are prototype
settings, not availability promises. Failed writes are not automatically retried
because a missing response does not establish whether a commit happened.

Three local PostgreSQL 18.6 scenarios passed using one Oracle process, app and
pool: clean SIGINT shutdown/restart; SIGKILL/restart with exit 137 and automatic
recovery indicators; and an exclusive observations-table lock producing a
verified server statement timeout. Each checks exact sanitized API failure,
unchanged acknowledged records, signatures, IDs and assessment hash before an
explicit submission. That submission returns 202, its replay 409 and a tampered
observation 401. The final dataset contains ten acknowledged observations.

The lock scenario releases its transaction and closes the blocker pool in
`finally`. Snapshot verification before resubmission would detect a late insert.
The generic 500 response alone cannot pass: a PostgreSQL server timeout marker
is also required. Eight focused unit cases and all 112 ordinary tests passed;
build and type checks passed. The ordinary command visibly skips 29 database
cases, which run in the separate real PostgreSQL CI job. Recovery has its own job.

Run `pnpm test:postgres:recovery` after building protocol and TerraLex, with
Docker available. It creates only fresh owned resources, pins the image, binds
an explicit stable loopback port, and reads no production DATABASE_URL. A test
harness port-reallocation problem was corrected and the pre-fix baseline rerun
before accepting the result. Cleanup verifies resource identity, ownership and
absence of other volume users. Reports omit raw child/database errors and
credentials. Measured durations are diagnostics, not benchmarks or SLAs.

This is not physical power-loss testing, host/VM/disk recovery, failover,
exactly-once delivery or production load validation. `/healthz` remains liveness
only, not database readiness. Synthetic software recovery does not demonstrate
environmental forecast skill or physical truth. Models, governance and funds
remain outside this change.

## Primary references

- [node-postgres pool errors](https://node-postgres.com/apis/pool#events): idle-client errors, automatic removal and unhandled-event risk.
- [node-postgres client configuration](https://node-postgres.com/apis/client): connection, statement and query timeout settings.
- [PostgreSQL shutdown modes](https://www.postgresql.org/docs/18/server-shutdown.html): clean shutdown versus immediate interruption.
- [PostgreSQL reliability](https://www.postgresql.org/docs/18/wal-reliability.html): storage and power-loss boundaries of durability claims.
