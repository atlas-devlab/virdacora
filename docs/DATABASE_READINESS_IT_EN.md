# Database disponibile e recupero / Database readiness and recovery

## Italiano

La [PR #26](https://github.com/atlas-devlab/virdacora/pull/26) è integrata in
`main` con commit `7841611751f36f4555514ec6b3caaac7bdd7e5dc`.
La [CI dopo il merge](https://github.com/atlas-devlab/virdacora/actions/runs/39131349249)
è passata. Quella correzione permette al processo di sopravvivere alla perdita
di una connessione inattiva. Questo passo aggiunge un segnale pubblico distinto
per capire se l'Oracle può usare il suo archivio.

### Regola spiegata prima della modifica

| Richiesta | Risposta | Significato |
|---|---|---|
| `/healthz` | 200, corpo esistente e hash della policy | Processo vivo, senza interrogare il database |
| `/readyz` | 200 `{"status":"ready"}` | La verifica corrente dell'archivio è riuscita |
| `/readyz` | 503 `{"status":"not_ready"}` | Verifica fallita o deadline HTTP superata |

Esempio: il database si arresta ma il processo Oracle continua a funzionare.
`/healthz` resta verde; `/readyz` diventa rosso. Dopo il riavvio del database,
lo stesso Oracle può tornare pronto senza essere riavviato a sua volta.

Il corpo non contiene errori SQL, URL o credenziali. Ogni risposta di readiness
usa `Cache-Control: no-store`. La deadline HTTP è due secondi: è un limite
configurato del prototipo, non uno SLA né la promessa di cancellare una query
nel database in due secondi.

Le richieste concorrenti condividono una sola sonda finché termina realmente,
anche quando una risposta HTTP è già scaduta. Alla conclusione, successo ed errore
sono eliminati: la richiesta successiva fa una verifica nuova. Nessun retry
automatico delle scritture viene aggiunto.

### Cosa verifica la sonda

PostgreSQL esegue una sola query di lettura. I `SELECT ... LIMIT 0` risolvono
le colonne usate da sensori, osservazioni e valutazioni, comprese le chiavi di
ordinamento della migrazione 002, e richiedono i relativi permessi di lettura.
La query controlla inoltre `INSERT` su ciascuna tabella e che
`transaction_read_only` sia `off`. Non legge righe e non inserisce osservazioni
di prova. Il client applica un `query_timeout` di due secondi; i limiti generali
del pool e il `statement_timeout` server di dieci secondi rimangono invariati.
Una risposta HTTP scaduta non dimostra che il lavoro server sia già terminato.

Nel backend memoria la verifica è immediata; non certifica persistenza su disco.
In Compose l'healthcheck dell'Oracle interroga `/readyz`, ogni dieci secondi con
i retry già configurati. Lo stato può quindi arrivare dopo il guasto; Docker
non riavvia automaticamente un container solo perché diventa `unhealthy`.

### Prove locali del 18 ottobre 2026

- `pnpm build`, `pnpm check`, controllo TypeScript Oracle e `docker compose config --quiet`: passati.
- `pnpm test`: **129 passati**; i **32 casi PostgreSQL** risultano esplicitamente
  saltati se manca l'URL di test dedicato. Non sono contati come passati da quel comando.
- `pnpm test:postgres`: **32 casi reali passati**, nessuno saltato, su un
  container tmpfs separato. La suite comprende lo schema legacy prima/dopo la
  migrazione 002, una colonna richiesta temporaneamente rinominata e una sessione
  di sola lettura. Non è una prova di revoca dei singoli privilegi con ruoli distinti.
- Il runner reale di recupero ha passato tre scenari: arresto pulito `SIGINT`,
  arresto forzato `SIGKILL` e lock esclusivo che blocca una scrittura.

In tutti e tre i casi `/readyz` ha restituito **200 → 503 → 200**, con
`/healthz` sempre 200 e lo stesso processo Oracle, app e pool. Dopo il recupero
sono stati verificati dati già confermati, firme, ID e hash delle prove;
una nuova osservazione dà 202, un replay 409 e una firma alterata 401.
Nel caso bloccato il log associa il timeout all'`INSERT` sullo stesso PID server,
distinguendolo dal timeout della successiva sonda.

Le ricevute sono in [evidence/postgres-readiness](evidence/postgres-readiness).
Il runner usa un volume nuovo, dati sintetici firmati e PostgreSQL 18.6 con
immagine fissata. Container, volume e credenziali temporanee sono stati rimossi
dopo la prova. Per ripetere il recupero: `pnpm test:postgres:recovery` con Docker.
Per la suite di storage serve l'URL locale dedicato descritto nella
[guida PostgreSQL](POSTGRES_VALIDATION_IT_EN.md).

### Limiti e obiettivo originale

Readiness è un controllo istantaneo, non la garanzia che qualsiasi scrittura
futura riesca: trigger, RLS, disco pieno o guasti successivi possono ancora
impedirla. La prova non simula una perdita di alimentazione del computer né
richieste interrotte dall'esito di commit sconosciuto. Non certifica alta
disponibilità, replica, failover o prestazioni in produzione.

Il vantaggio per Virdacora è rendere esplicito quando il percorso delle prove
ambientali non può usare l'archivio. Nessuna nuova osservazione ambientale,
regressione, previsione, firma, regola comunitaria, contratto o fondo viene
cambiato. Revisione e test software non sono validazione ambientale indipendente.

## English

[PR #26](https://github.com/atlas-devlab/virdacora/pull/26) was merged at
`7841611751f36f4555514ec6b3caaac7bdd7e5dc`, and its
[post-merge CI](https://github.com/atlas-devlab/virdacora/actions/runs/39131349249)
passed. This separate change exposes database readiness while preserving process
liveness. `/healthz` retains its existing 200 response and policy hash without
querying storage. `/readyz` returns 200 `{"status":"ready"}` or 503
`{"status":"not_ready"}`, always with `Cache-Control: no-store` and no SQL,
connection details or credentials.

The HTTP deadline is two seconds. Concurrent requests share a single pending
probe until it actually settles, including after HTTP expiry. Its result is then
discarded so the next request checks afresh. HTTP expiry does not establish that
the server query has ended. The per-probe client timeout is two seconds; existing
pool limits and the ten-second server statement timeout remain unchanged.
There are no automatic write retries or changes to write-outcome semantics.

The PostgreSQL probe is one read-only query: `SELECT ... LIMIT 0` resolves required
columns and checks read access without reading records; separate checks require
`INSERT` on each table and writable session mode. Memory mode only indicates
in-memory readiness, not persistence. Compose now probes `/readyz`; its ten-second
interval and existing retries can delay unhealthy status, which does not itself
restart the container or provide failover.

Local build, workspace checks, Oracle typechecking and Compose validation passed.
The ordinary suite passed **129 tests**, visibly skipping **32 database cases**
without the dedicated URL. The separate real database run passed **32/32** with
no skips on its own temporary container. Cases include legacy/current schema,
a missing column and a read-only session; individual privilege revocation with
separate roles was not tested. See the
[receipts and source hashes](evidence/postgres-readiness) for dedicated-run results.

Real PostgreSQL 18.6 recovery passed clean `SIGINT` shutdown, `SIGKILL` and an
exclusively locked write. Each observed `/readyz` **200 → 503 → 200** with
`/healthz` 200, the same Oracle process/app/pool, preserved acknowledged records,
signatures, IDs and evidence hashes. Post-recovery responses were 202 for a new
observation, 409 for replay and 401 for tampering. The blocked-write log ties the
server timeout to the actual `INSERT` on the same server PID, separately from
the probe. Owned test resources and temporary credentials were cleaned up.

Readiness is an instantaneous check, not a guarantee for every future write:
triggers, RLS, disk space and later failures remain outside that guarantee.
These synthetic tests do not prove host power-loss durability, unknown commit
outcomes, production performance, high availability or environmental forecast
skill. Environmental inputs, models, signed evidence, community governance,
contracts and funds are unchanged. The purpose is to report storage availability
honestly within Virdacora's evidence pipeline.

## Technical references

- [PostgreSQL 18 information and privilege functions](https://www.postgresql.org/docs/18/functions-info.html): a comma-separated privilege list means any listed privilege, not all.
- [node-postgres client options](https://node-postgres.com/apis/client): client query and server statement timeouts are distinct.
- [Compose healthcheck](https://docs.docker.com/reference/compose-file/services/#healthcheck): health status configuration and timing.
