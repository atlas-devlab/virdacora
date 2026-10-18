# Arresto controllato dell'Oracle / Controlled Oracle shutdown

## Italiano

La [PR #27](https://github.com/atlas-devlab/virdacora/pull/27) è integrata in
`main` a `d2a6f2bf4c8c81641d78d74c0ce815da472f46b4`; anche la
[CI successiva al merge](https://github.com/atlas-devlab/virdacora/actions/runs/39133170216)
è passata. Il controllo di disponibilità del database resta distinto dalla
vitalità del processo. Questo passo affronta un altro problema: fermare l'Oracle
durante una richiesta senza interromperla immediatamente.

### Difetto e regola annunciata prima della modifica

Prima, `server.ts` avviava il servizio senza gestire `SIGTERM` o `SIGINT`.
Il cleanup `onClose` del pool esisteva, ma il segnale non chiamava `app.close()`.
Una misura poteva quindi restare senza risposta mentre PostgreSQL la elaborava.
Non possiamo interpretare l'assenza di risposta come «misura non salvata».

La nuova regola è:

1. Il primo segnale avvia una sola chiusura; quelli successivi non la duplicano.
2. `app.close()` ferma l'accettazione di nuovo lavoro e lascia finire le richieste
   già iniziate, senza distruggere subito i loro socket.
3. Il cleanup esistente chiude l'archivio dopo le richieste. Solo dopo la
   conclusione della chiusura il processo termina con codice 0.
4. Se la chiusura fallisce o supera **20 secondi**, il processo termina con codice 1.
   I messaggi sono statici: nessun errore originale, URL o credenziale viene stampato.

Esempio: una misura è già in attesa del database quando arriva lo stop.
Se il database la completa entro il periodo disponibile, il client può ricevere
202 prima dell'uscita pulita. Una nuova connessione durante la chiusura viene
rifiutata, interrotta dal proxy Docker oppure riceve 503; gli esiti di trasporto
restano distinti dalle risposte HTTP. Non viene aggiunto alcun
retry automatico della scrittura.

Il marker `VIRDACORA_ORACLE_SHUTDOWN_STARTED` viene emesso una volta dopo la
chiamata a `app.close()`: segnala l'avvio, non il completamento. In Compose il
periodo esterno è **25 secondi**, superiore al limite applicativo. Questi sono
limiti configurati del prototipo, non SLA o garanzie contro un processo bloccato
che non riesca nemmeno a eseguire il proprio timer.

### Disegno della verifica

Il test reale usa il vero `server.ts` compilato dall'Oracle Dockerfile, con Node
come processo principale in Linux. Non usa `child.kill()` su Windows per provare
handler POSIX. Un PostgreSQL 18.6 separato e una rete Docker nuova contengono
soltanto dati sintetici e credenziali temporanee.

Per ciascuno dei segnali `SIGTERM` e `SIGINT`, la prova:

- registra un sensore Ed25519 e avvia una richiesta HTTP firmata;
- blocca l'`INSERT` con un lock esclusivo e ne verifica l'attesa tramite
  `pg_stat_activity`, prima di inviare il segnale al solo Oracle;
- controlla che l'Oracle aspetti la richiesta e non accetti nuovo lavoro;
- rilascia il lock, richiede la risposta 202 e l'uscita pulita, e verifica una sola
  osservazione con firma e identificativo originali;
- riavvia lo stesso container Oracle e controlla readiness 200, replay 409 e
  firma alterata 401.

La baseline è costruita da un archivio Git immutabile del commit dopo PR #27.
La stessa prova distingue l'assenza di una chiusura coordinata dal drenaggio
della correzione. Nella baseline Linux osservata, il vecchio Node come PID 1
resta attivo dopo il segnale; non è stato osservato un arresto immediato. Quando
il lock viene rilasciato, le richieste ricevono 202. Questo esito non dimostra
perdita di dati: mostra che il segnale non avvia la chiusura prevista.

La prima correzione con soli handler non basta: nella prova reale la richiesta
pendente riceveva `ECONNRESET`. Il percorso di chiusura della versione Fastify
installata, con l'impostazione predefinita, distruggeva anche le connessioni attive.
Impostiamo quindi esplicitamente `forceCloseConnections: false`. Un test su una
connessione HTTP reale riproduce il difetto prima della modifica e protegge il
drenaggio successivo; la prova Docker conserva gli stessi criteri.

Il primo tentativo del runner si era fermato prima dei segnali: controllava lo
script ENTRYPOINT invece del processo effettivo. Ora verifica `Config.Cmd` e
`/proc/1/cmdline`. Questo errore del test è archiviato separatamente e non viene
contato come riproduzione del difetto applicativo.

Un secondo controllo del runner era troppo restrittivo: il proxy della porta
Docker produceva `ECONNRESET` sulle nuove connessioni invece di `ECONNREFUSED`.
La richiesta già attiva completava correttamente 202. Il test distingue ora
entrambi gli errori di trasporto da HTTP 503 e invia una misura tardiva valida
con sequenza diversa: soltanto dopo l'uscita e il riavvio controlla che questa
seconda misura non sia nell'archivio. Un errore di rete da solo non prova un
commit mancante. La ricevuta di questo tentativo resta separata.
I test unitari verificano separatamente il limite dei 20 secondi con timer
simulati, errori sincroni e asincroni, segnali ripetuti, conclusioni tardive e
rimozione di listener e timer. Non sono una misura reale di 20 secondi su Linux.

Comando dalla radice, dopo aver costruito le dipendenze interne:

```sh
pnpm build
pnpm test:oracle:shutdown
```

Il runner costruisce l'immagine Oracle dalle sorgenti correnti e produce una
ricevuta sanitizzata. La prova usa solo risorse proprie: non arresta servizi
esistenti e non usa un URL di produzione. Le ricevute archiviate indicano gli
esiti realmente ottenuti e la pulizia effettuata.

### Risultati locali del 18 ottobre 2026

| Verifica | Esito |
|---|---|
| Build, check, TypeScript esplicito e configurazione Compose | Passati |
| Suite ordinaria | 141 passati; 32 casi DB esplicitamente saltati senza URL dedicato |
| Nuovi casi di chiusura | 11 unitari con runtime controllato e un test HTTP reale |
| Segnali Linux reali su PostgreSQL 18.6 | SIGTERM e SIGINT passati |
| Richiesta già iniziata | 202, identificativo e firma esatti, una sola riga |
| Misura tardiva distinta | Assente dopo uscita e riavvio; trasporto locale ECONNRESET |
| Chiusura e riavvio | Uscita 0, poi readiness 200 / replay 409 / alterazione 401 |
| Pulizia | Pool di ispezione, container, rete e credenziali rimossi |

Il test HTTP aggiunto è fallito prima della configurazione esplicita con
`ECONNRESET` ed è passato dopo. Le ricevute con hash delle sorgenti sono in
[evidence/oracle-shutdown](evidence/oracle-shutdown). I 32 casi DB della suite
dedicata e i tre scenari precedenti di recupero vengono rieseguiti dalla CI:
il comando ordinario non li conta come superati quando li salta.

### Limiti e missione

Un'uscita forzata, una disconnessione o un timeout non risolvono un esito di commit
sconosciuto. Non promettiamo exactly-once, alta disponibilità, recupero da perdita
di alimentazione o prestazioni di produzione. Il limite esterno di Docker può
ancora interrompere un processo che non termina. Il lavoro protegge il percorso
di acquisizione delle prove di Virdacora durante gli aggiornamenti; non cambia
modelli previsionali, firme, ordinamento, politiche comunitarie, contratti o fondi.
I dati sono sintetici: non è validazione ambientale indipendente.

## English

[PR #27](https://github.com/atlas-devlab/virdacora/pull/27) was merged at
`d2a6f2bf4c8c81641d78d74c0ce815da472f46b4`; its
[post-merge CI](https://github.com/atlas-devlab/virdacora/actions/runs/39133170216)
passed. This separate change addresses Oracle termination during an active request.
Previously the entry point did not handle SIGTERM/SIGINT, so the existing store
cleanup hook was not reached through an orderly `app.close()`.

The first signal starts one shutdown. Fastify stops accepting new work, drains
active requests and runs the existing store-close hook. Successful close exits 0;
a rejected close or the **20-second** application deadline exits 1 with a static
diagnostic. Repeated signals cannot start another shutdown. The static
`VIRDACORA_ORACLE_SHUTDOWN_STARTED` marker means close was started, not completed.
Compose allows **25 seconds** before forced termination. These configured values
are not availability guarantees or an SLA; a blocked event loop can delay a timer.

The real test runs the compiled server as Linux Node PID 1 from the Oracle
Dockerfile. For both SIGTERM and SIGINT, a signed HTTP observation waits on a
confirmed PostgreSQL INSERT lock before the signal. The test checks drain and
refusal/reset/503 for late work, releases the lock, requires 202 followed by clean exit,
and verifies exactly one stored row with its original signature and ID. Restarting
the same Oracle container must preserve that row, return ready 200, reject replay
409 and reject tampering 401. All data and resources are isolated and synthetic.

The immutable pre-fix image comes from the merged PR #27 commit. In that Linux
baseline, Node PID 1 remains alive after the signal instead of starting a
coordinated shutdown. After the lock is released the requests return 202; no
immediate exit or data loss was demonstrated. The initial handler-only correction
failed the real test with `ECONNRESET`: the installed Fastify close path destroyed
active connections under its default setting. Explicit
`forceCloseConnections: false` and a real-HTTP regression test address that
behavior without changing the Docker success criteria. A separate first harness
failure checked Docker's entrypoint script instead of the actual PID 1; it was
corrected using `Config.Cmd` and `/proc/1/cmdline`, and is not counted as an
application failure. These receipts remain distinct from the valid signal runs.
Another harness assumption accepted only refused connections or HTTP 503, while
Docker's published-port proxy reset new connections. That failed attempt is
retained. The test now reports reset/refusal as transport errors and sends a
distinct valid late observation; its absence is checked after clean exit and
restart, rather than inferred from the transport error alone.

Unit tests cover hung close with fake timers, synchronous/asynchronous failures, repeated signals,
late completion and timer/listener cleanup. Fake-clock deadline tests are not a
real-time Linux measurement. Archived receipts distinguish actual baseline and
fixed outcomes and record owned-resource cleanup.

Local build/check, explicit TypeScript and Compose validation passed, along with
**141 ordinary tests** (32 database cases visibly skipped without their dedicated
URL). The 12 new cases comprise 11 controlled-runtime tests and one real-HTTP
regression that failed with ECONNRESET before the explicit setting and passed
afterwards. **Both real Linux signal cases passed** against PostgreSQL 18.6:
the original request returned 202, the process exited 0, one exact signed row
remained and the distinct late observation was absent after restart. Locally,
the late connection produced a transport ECONNRESET. Restart checks returned
ready 200 / replay 409 / tampering 401. Owned containers, network, inspector pool
and temporary credentials were cleaned up. See the
[receipts and source hashes](evidence/oracle-shutdown). Dedicated database tests
and the previous three recovery scenarios are separate CI jobs, not ordinary
suite successes inferred from skipped cases.

Timeout, forced exit or a lost response does not establish that a write failed to
commit. This change adds no automatic write retries, exactly-once guarantee,
failover, power-loss durability or production-performance claim. It strengthens
Virdacora's evidence ingestion during controlled updates without changing
environmental models, signatures, ordering, community policies, contracts or funds.

## Primary references

- [Fastify close and connection handling](https://fastify.dev/docs/latest/Reference/Server/#close).
- [Fastify 5.10.0 close implementation](https://github.com/fastify/fastify/blob/v5.10.0/fastify.js#L373): explicit connection handling avoids the observed default close path.
- [Node.js signal events and platform differences](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events).
- [Compose stop_grace_period](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).
