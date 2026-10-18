# Verifica delle prove archiviate / Archived evidence verification

## Italiano

Questo controllo rafforza il percorso originale di Virdacora: osservazione
firmata, analisi verificabile, policy esplicita e decisione contestabile.
Riguarda le prove selezionate per un nuovo calcolo nell'Oracle; non aggiunge
nuovi dati ambientali, addestramento, deployment o movimenti di fondi.

### Il problema concreto

La firma era verificata soltanto all'ingresso. Dopo aver archiviato cinque
osservazioni valide, un'alterazione del JSONB poteva sostituire il valore di una
misura lasciandone invariati ID e firma. Il calcolo successivo usava il numero
alterato. L'hash del risultato era riproducibile, ma non verificava nuovamente
l'autenticità delle osservazioni che lo avevano prodotto.

Esempio sintetico: una misura firmata vale 6 mg/L. Cambiare il suo valore
archiviato in 6000, senza una nuova firma, deve impedire una nuova valutazione.
Ricalcolare anche l'ID non basta: deve essere verificata separatamente la firma.

### Regola prima dell'analisi

Il token Oracle e il numero minimo di osservazioni mantengono i controlli
precedenti. Per la finestra selezionata, fino a 512 righe, l'Oracle poi:

1. Verifica rigorosamente struttura della riga e campi del payload firmato,
   senza correggere tipi, rimuovere campi inattesi o normalizzare i valori.
2. Crea copie dei dati definiti dal protocollo prima del primo accesso asincrono
   al registro: i numeri poi analizzati sono quelli effettivamente verificati.
3. Confronta territorio e metrica di ogni misura con la richiesta autorizzata.
4. Ricalcola l'ID dai campi originali e lo confronta con quello restituito
   dall'archivio. Respinge ID duplicati e coppie sensore/sequenza duplicate.
5. Legge il sensore registrato, controlla identità e territorio e verifica la
   firma del payload originale rispetto alla chiave attualmente registrata.
6. Passa le copie verificate all'analisi soltanto se l'intera finestra supera
   i controlli. La conversione mg/L/µg/L resta nel vettore numerico separato.

Un problema di integrità restituisce il messaggio statico:

```json
{"error":"INVALID_ARCHIVED_EVIDENCE","message":"archived observation evidence is invalid"}
```

Lo stato HTTP è 422. Nessuna nuova valutazione viene salvata, nessuna policy
viene valutata e nessuna bozza d'azione viene prodotta. L'Oracle non salta una
riga sospetta per arrivare comunque a un risultato e non ripara, cancella o
rifirma dati. Payload, firme e ID archiviati rimangono intatti.

Un errore di accesso al registro resta un problema di disponibilità: segue il
percorso generico 500 senza esporre eccezioni, query o credenziali. Non viene
presentato come una prova di alterazione dei dati. `/readyz` continua a indicare
la disponibilità dello store, non la validità di ogni osservazione ambientale.

### Dati storici e costo del controllo

Un sensore oggi inattivo non revoca automaticamente le sue vecchie firme.
Uno storico valido può essere analizzato; nuovi invii da quel sensore continuano
a essere respinti con 403. La finestra temporale di accettazione all'ingresso
non viene riapplicata alle osservazioni già archiviate.

La chiave viene letta una volta per ogni sensore distinto nello stesso calcolo;
il risultato non viene conservato fra richieste. Cambiamenti o ripristini del
registro vengono quindi riletti al calcolo successivo. Non esiste una cronologia
delle chiavi: la verifica usa il registro attuale e non ricostruisce quale
chiave fosse autorizzata in un momento passato. Le letture del registro e le
verifiche crittografiche hanno un costo; non viene promesso un miglioramento
di velocità o uno snapshot transazionale unico di tutte le chiavi.

### Garanzie separate

Il controllo rileva le incoerenze delle righe restituite rispetto ai payload
firmati e al registro letto. Non dimostra:

- che nessuna osservazione sia stata omessa o esclusa attraverso metadati SQL
  di selezione alterati;
- che una misura autenticamente firmata sia fisicamente corretta;
- che sensori o operatori siano indipendenti;
- che un attaccante capace di sostituire coerentemente registro, chiavi e prove
  venga riconosciuto senza un'autorità o un ancoraggio indipendente;
- che le valutazioni storiche già salvate o `GET /latest` siano state
  nuovamente verificate.

Il modello matematico resta una funzione pura di analisi; il nuovo controllo
è nel percorso HTTP che genera valutazioni e bozze. Chi richiama direttamente
la funzione matematica deve fornire dati già verificati. Non cambiano formule,
versioni del modello, policy, contratti o governance. Gli ingressi validi devono
produrre gli stessi risultati numerici e hash di prima.

### Verifica eseguita

Prima della correzione, 16 dei 18 casi mirati fallivano; dopo il controllo tutti
i 18 passano. La suite ordinaria completa passa 189 test; i 40 casi PostgreSQL,
saltati esplicitamente dal comando ordinario, sono stati eseguiti separatamente
su PostgreSQL 18.6 reale, tutti passati. Compilazione, controlli di tipo e controllo
TypeScript esplicito anche dei file di test sono passati.

I quattro nuovi casi database alterano soltanto uno schema di test isolato:
valore JSONB, ID della riga, chiave pubblica e stato attivo del sensore. Verificano
il rifiuto prima di nuovi assessment e il recupero dopo ripristino controllato
degli originali; il cambio di chiave avviene anche dopo un primo run riuscito,
per escludere un cache positivo tra richieste. Il container temporaneo in tmpfs
è stato rimosso dopo la prova. Nessun database o volume esistente è stato usato.

Le ricevute sanificate sono in `docs/evidence/archive-integrity/`. I test usano
misure sintetiche e chiavi effimere; accordo fra revisori Codex e test software
non costituiscono validazione ambientale indipendente.

## English

This change strengthens Virdacora's original evidence-to-decision path. It
verifies the selected archived observations before a new Oracle assessment,
without adding environmental data, training, deployment or fund movements.

Previously, signatures were checked on ingestion only. A later JSONB value
change retaining the original ID and signature could enter a new assessment.
A reproducible assessment hash alone did not verify its source signatures.

After authentication and the existing minimum-sample check, the Oracle validates
the selected window, up to 512 rows. It checks strict row/payload schemas,
snapshots protocol fields before the first asynchronous registry lookup, binds
every observation to the requested region and metric, recomputes its original
ID, rejects duplicate IDs and sensor/sequence pairs, and verifies its signature
against the matching sensor's current registered key and region. Only the
verified snapshots reach analysis, persistence and policy evaluation.

Any failed integrity check rejects the whole run with HTTP 422 and the static
`INVALID_ARCHIVED_EVIDENCE` response shown above. No assessment is saved, no
policy is evaluated, and no action draft is created. Suspect records are not
silently skipped, rewritten, deleted or re-signed. Valid original values,
units, IDs, signatures and timestamps remain unchanged. Oxygen conversion
still occurs only in the separate analytical numeric vector.

Registry access failures remain generic availability errors, not assertions
of tampering. Exceptions, queries and credentials are not included in client
responses. Store readiness is distinct from evidence integrity.

Historical observations remain eligible when a sensor is currently inactive,
provided their evidence verifies; new submissions remain forbidden. The live
ingestion age window is not reapplied to the archive. Registry lookups are
deduplicated per sensor within one run and are not cached between runs. Current
keys are used: this prototype has no historical key-authorization log and no
single transactional snapshot across all registry reads. Extra cryptographic
and registry work is not presented as a throughput improvement.

The gate does not prove completeness, physical accuracy, operator independence,
or resistance to an attacker who can coherently replace both the trust registry
and evidence. SQL metadata manipulation may omit valid records without changing
the returned signatures. Existing saved assessments and the latest-result read
endpoint are not retroactively reverified. Direct callers of the pure numerical
analysis function remain responsible for verifying their inputs.

The mathematical recipe, model versions, policy, contracts and governance stay
unchanged. Valid inputs must reproduce the same numerical results and evidence
hashes. Synthetic tests and real PostgreSQL mutation/recovery checks are
documented in the sanitized receipts under `docs/evidence/archive-integrity/`.
The local verification passed 189 ordinary tests and all 40 dedicated actual
PostgreSQL 18.6 cases, with no database skips in that dedicated run. The new
four database cases mutate only the isolated test schema and check rejection,
preservation and controlled recovery. The owned tmpfs container was removed.
Build, checks and explicit strict TypeScript including test files passed.
These are synthetic software checks, not independent environmental validation.
