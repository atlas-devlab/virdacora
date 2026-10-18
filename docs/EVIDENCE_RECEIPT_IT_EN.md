# Ricevuta delle prove / Evidence receipt

## Italiano

### Il problema e la modifica

Un hash permette di controllare un contenuto disponibile, ma non di recuperarlo.
Il risultato conservato dall'Oracle contieneva l'hash delle prove senza l'elenco
delle osservazioni selezionate. Rileggere domani le ultime 512 osservazioni può
selezionare una finestra diversa da quella usata oggi.

Una risposta riuscita di `POST /v1/assessments/run` aggiunge ora `evidenceReceipt`.
La ricevuta conserva la finestra precisa e permette di riprodurre il risultato
senza interrogare il database. Non cambia la regressione o la politica.

Esempio: oggi il risultato usa sei misure firmate, alcune in mg/L e altre in
microgrammi/L. Domani il database riceve nuove misure. La ricevuta di oggi contiene
ancora le sei misure originali: il verificatore controlla firme e chiavi, converte
le unità soltanto nel calcolo e deve ricostruire lo stesso risultato e gli stessi
hash. Alterare `6000 µg/L` in `6000 mg/L` senza una nuova firma viene respinto.

### Contenuto e conservazione

Il formato `virdacora-evidence-receipt-v1` contiene:

| Campo | Contenuto |
| --- | --- |
| `formatVersion` | Identificatore esatto del formato |
| `assessment` | Risultato completo, con ID, hash e conteggio |
| `evidenceCore` | Oggetto preciso usato dal produttore per gli hash, con gli ID delle osservazioni in ordine cronologico e poi per ID |
| `observations` | Da 5 a 512 coppie `observationId` / `observation`, con valori, unità, timestamp e firme originali |
| `sensors` | Per ogni sensore utilizzato: solo `sensorId`, `regionId`, `publicKeyDerBase64` |

Le chiavi sono copiate dalla verifica delle firme prima del salvataggio del
risultato. Non vengono rilette per costruire la ricevuta: un cambiamento successivo
del registro non può sostituire le chiavi effettivamente usate da quella verifica.
Non sono inclusi etichette dei sensori, chiavi private, token o credenziali DB.

La ricevuta viene restituita al chiamante: **va salvata**. Questa modifica non
aggiunge persistenza, distribuzione o registrazione della ricevuta sulla blockchain.
La tabella dei risultati e `GET .../latest` conservano il formato piatto precedente;
non è necessaria una migrazione SQL. Un vecchio hash senza la finestra esportata
non basta a ricostruire una ricevuta storica.

Per estrarre soltanto la ricevuta da una risposta API salvata in UTF-8:

```sh
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const response=JSON.parse(readFileSync("assessment-run.json","utf8")); if (!response.evidenceReceipt) throw new Error("missing receipt"); writeFileSync("receipt.json",JSON.stringify(response.evidenceReceipt,null,2)+"\n");'
```

### Verifica offline e fiducia

Con Node.js 24 o successivo, le dipendenze del repository già installate e i
pacchetti protocollo/TerraLex compilati (`pnpm build`), eseguire dalla radice:

```sh
pnpm verify:evidence receipt.json trusted-registry.json
```

Il secondo file è obbligatorio. Contiene un array JSON di chiavi pubbliche
verificate attraverso un canale fidato separato, per esempio:

```json
[
  {
    "sensorId": "sensor-example",
    "regionId": "region-example",
    "publicKeyDerBase64": "REPLACE_WITH_INDEPENDENTLY_TRUSTED_ED25519_SPKI_DER_BASE64"
  }
]
```

Il segnaposto non è una chiave valida. Copiare le chiavi dalla stessa ricevuta e
chiamarle "fidate" annullerebbe il controllo contro la loro sostituzione.
Il registro esterno può contenere altri sensori; nella ricevuta devono apparire
esattamente quelli usati. ID di sensore duplicati vengono respinti.

Il verificatore controlla schema, ID originali, firme, unicità ID/sequenze e
associazioni sensore/territorio/metrica. Usa poi lo stesso produttore numerico
per confrontare l'intero core e risultato, inclusi conteggio, versione e hash:

```text
evidenceHash = SHA-256("evidence:" + canonicalJson(evidenceCore))
assessmentId = SHA-256("assessment:" + canonicalJson(evidenceCore))
```

Il modello dell'ossigeno resta `terravoce-linear-risk-v2-oxygen-units`; gli altri
profili illustrativi restano `terravoce-linear-risk-v1`. Valori e formule non
cambiano. Il replay supporta le ricette predefinite attuali; versioni sconosciute
o risultati di ricette personalizzate non vengono accettati per supposizione.

Successo: uscita 0 e JSON con `valid: true`, ID, hash, versione e conteggio;
`scope` vale `signed-observations-and-assessment-replay` e `trust` vale
`caller-supplied-registry`. Fallimento: uscita 1 e messaggio statico, senza dati
dell'input o credenziali. La funzione di libreria restituisce il risultato oppure
`INVALID_EVIDENCE_RECEIPT`. L'uso errato del comando mostra la sintassi.

Il comando legge soltanto i due file indicati, senza modificarli, consultare il
DB o caricare URL. Richiede JSON UTF-8 valido, file regolari di massimo 64 MiB
per la ricevuta e 1 MiB per il registro; rifiuta stdin, URL, percorsi UNC espliciti
e symlink finali. Non identifica un filesystem remoto eventualmente nascosto
dietro un disco mappato o una junction del sistema operativo.

### Prove e limiti

I test includono ricevute autentiche sintetiche, dati/unità/firme/ID alterati,
righe rimosse o duplicate, core riordinato, versioni sconosciute e risultato
numerico contraffatto anche dopo avere ricalcolato entrambi gli hash.
Un test sostituisce insieme chiave e firme lasciando invariati i dati non firmati
e quindi gli ID delle osservazioni: la fiducia esterna originale lo respinge.
Se si sostituisce anche il registro fidato, la verifica può riuscire: il controllo
dipende dall'autorità delle chiavi scelta dal verificatore.

Le prove API controllano una sola lettura per sensore e conservazione del formato
persistito. Due casi su PostgreSQL reale controllano il replay dopo modifiche
dell'archivio e chiusura dei client, e il cambio di chiave durante il salvataggio.
I test CLI controllano anche UTF-8, limiti dei file, errori statici e file immutati.
Sono controlli software con dati sintetici, non validazione ambientale indipendente.

Verifica locale: build, controlli e TypeScript strict inclusi test e CLI superati;
227 test ordinari e 42 su PostgreSQL 18.6 passati. I 42 casi DB vengono saltati
nella suite ordinaria e sono stati eseguiti separatamente senza salti, in un
container temporaneo proprio, poi rimosso. Le ricevute sanificate sono in
[`docs/evidence/evidence-receipt/`](evidence/evidence-receipt/verification.json).
Il primo controllo API aveva due fallimenti attesi per la ricevuta assente.
Durante lo sviluppo è stata corretta una parametrizzazione del test CLI per
eseguire davvero il caso senza argomenti; la suite finale lo include.

La ricevuta **non certifica** verità fisica, calibrazione dei sensori, completezza
della finestra, indipendenza degli operatori o autorizzazione storica delle chiavi.
L'Oracle non firma questa ricevuta: chi dispone di misure autentiche può calcolare
un'altra aggregazione coerente. Il verificatore controlla la coerenza presentata,
non l'identità dell'Oracle che avrebbe scelto finestra e orizzonte. Non verifica
la decisione TerraLex, l'eventuale bozza d'azione o una decisione comunitaria.

L'obiettivo originale resta prove ambientali verificabili al servizio delle
comunità: la ricevuta facilita la contestazione e il ricalcolo. Non promuove
previsioni operative e non cambia consenso, governance, fondi o contratti.

## English

### Problem and change

A hash can check available content; it cannot retrieve that content. The stored
assessment included an evidence hash without retaining its selected observation
IDs. Tomorrow's latest 512 rows may differ from today's analysis window.

A successful `POST /v1/assessments/run` now adds `evidenceReceipt`: the exact
window and analytical core needed for offline replay. Regression, policy,
persisted assessment shape and existing hashes are unchanged.

For example, today's six signed observations may mix mg/L and micrograms/L.
Tomorrow's new rows do not change an exported receipt. The verifier checks its
original signatures and trusted keys, converts units only in the calculation,
then reproduces the same result and hashes. Changing `6000 µg/L` to `6000 mg/L`
without a new signature is rejected.

### Format and export

`virdacora-evidence-receipt-v1` contains `assessment`, the exact `evidenceCore`
including chronologically ordered observation IDs (ID breaks ties), 5–512 original
signed `observations`, and `sensors` with only `sensorId`, `regionId` and
`publicKeyDerBase64`. Key bindings are captured by the archive gate before
persistence, with one lookup per used sensor and no second lookup for export.
Labels, private keys, tokens and DB credentials are not included.

**Save the returned receipt.** It is not persisted, distributed or recorded on
chain by this change. The assessment table and latest endpoint remain flat;
no SQL migration is required. Old unexported windows cannot be reconstructed
from their hash alone. The extraction command above saves only `evidenceReceipt`
from an API response stored as UTF-8 JSON.

### Offline verification

With Node.js 24+, installed repository dependencies and built packages
(`pnpm build`), run from the repository root:

```sh
pnpm verify:evidence receipt.json trusted-registry.json
```

The second file is mandatory: a JSON array of independently trusted three-field
sensor-key bindings, as shown above. The placeholder is not a valid key.
Copying a receipt's own keys into the trust file provides no protection against
their replacement. Extra trusted registry sensors are allowed; the receipt must
contain exactly its used sensors. Duplicate sensor IDs are rejected.

Verification checks schemas, original observation IDs, signatures, ID/sequence
uniqueness and sensor/region/metric associations. It reuses the producer to
compare the complete analytical core and assessment, including count, version
and both domain-separated hashes shown above. Oxygen remains
`terravoce-linear-risk-v2-oxygen-units`; other illustrative profiles remain
`terravoce-linear-risk-v1`. Only current default recipes are supported; unknown
versions or custom recipes are not silently accepted.

Success exits 0 with JSON containing `valid: true`, assessment ID, evidence hash,
version, count, scope `signed-observations-and-assessment-replay` and trust
`caller-supplied-registry`. Failure exits 1 with a static message; bad invocation
shows usage. The library verifier returns the assessment or
`INVALID_EVIDENCE_RECEIPT`, without exposing input or registry details.

The CLI reads but does not modify the two explicit files. It does not query a DB
or load URLs. It requires valid UTF-8 JSON and regular files bounded to 64 MiB
for receipts and 1 MiB for registries; stdin, explicit URL/UNC inputs and final
symlinks are refused. It does not identify remote filesystems hidden behind
mapped drives or parent junctions.

### Tests, trust and original mission

Synthetic signed fixtures cover authentic replay, tampering with values, units,
signatures and IDs, omitted/duplicate rows, reordered core IDs, unknown versions,
and forged numerical results even after recalculating hashes. Replacing keys and
signatures together is rejected against the original external trust registry,
even though unsigned observation IDs remain unchanged. Replacing the external
trust authority as well can make that packet pass: trust selection is explicit.

API tests check captured keys, single lookups and unchanged persisted shape.
Two real PostgreSQL cases verify a detached receipt after archive changes and
client shutdown, and a registry change during persistence. CLI tests cover file
immutability, malformed UTF-8/JSON, file limits and static errors. These are
software checks on synthetic data, not independent environmental validation.

Local verification passed build, checks, strict TypeScript including tests/CLI,
227 ordinary tests and all 42 dedicated PostgreSQL 18.6 tests. DB cases are skipped
in the ordinary suite and ran separately with no skips, using an owned temporary
container that was removed afterward. Sanitized receipts are under
[`docs/evidence/evidence-receipt/`](evidence/evidence-receipt/verification.json).
The initial API baseline had two expected failures for the missing receipt.
A CLI test parameterization issue was fixed so the no-arguments case actually
runs; it is included in the final passing suite.

Receipts do not establish physical truth, sensor calibration, completeness,
operator independence or historical key authorization. They are not signed by
the Oracle: authentic observations can be reaggregated into another internally
consistent result. Verification does not identify an Oracle issuer or certify
its window/horizon choice, TerraLex decision, action draft or community decision.

Virdacora's purpose remains verifiable environmental evidence and community
decision rights. Export enables scrutiny and replay; this change does not promote
operational forecasts or alter consensus, governance, funds or contracts.
