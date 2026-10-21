# Trovare le ricevute / Finding receipts

## Italiano

### Perché serve

La ricevuta è conservata, ma un operatore può perdere il suo ID. Ora, conoscendo
l'ID del risultato, può trovare gli ID delle ricevute associate, recuperarne una
e verificarla offline. Sono tre passaggi distinti:

1. risultato A → elenco degli ID di ricevuta R1, R2;
2. ID R1 → pacchetto originale conservato;
3. pacchetto + chiavi fidate separate → verifica delle firme e del calcolo.

L'elenco non ricostruisce prove mancanti. Richiede un assessment ID noto; non
introduce un elenco globale dei risultati. Un risultato corrente può già essere
letto dall'endpoint latest per regione/metrica. La lista non sceglie quale variante
di ricevuta debba essere considerata autorevole.

### Contratto

```text
GET /v1/assessments/<assessmentId>/evidence-receipts?limit=20&after=<receiptId>
x-oracle-token: <token configurato, non pubblicarlo>
```

La prima pagina omette `after`. Il risultato è un oggetto con `assessmentId`,
array `receiptIds` e, soltanto se esiste almeno un ulteriore elemento,
`nextAfter`. Per continuare, usare quel valore come `after`.

| Regola | Comportamento |
| --- | --- |
| Limite | Predefinito 20; da 1 a 100 ID per pagina |
| Query `limit` | Intero decimale senza segno, spazi, zeri iniziali o esponenti |
| ID | `0x` seguito da 64 cifre esadecimali minuscole |
| Ordine | Crescente ASCII degli ID, non cronologia o qualità delle prove |
| Cursore | Limite esclusivo: restituisce solo ID strettamente maggiori |
| Cursore inesistente | Accettato se il formato è valido; non è necessario cercarlo nel DB |
| Risultato sconosciuto o legacy senza ricevute | HTTP 200, array vuoto |
| Token mancante o errato | HTTP 401 prima di validare ID/query o leggere il deposito |
| Parametri autorizzati non validi | HTTP 400 prima della query |
| Errore del deposito | HTTP 500 generico, senza dettagli SQL o credenziali |

Tutte le risposte usano `Cache-Control: no-store`. Parametri sconosciuti, valori
vuoti e duplicati di query che producono array vengono respinti. La lista contiene
soltanto ID: non corpi delle ricevute, misure, firme, chiavi o conteggio totale.
La route autenticata già esistente recupera il pacchetto completo:
`GET /v1/evidence-receipts/<receiptId>`.

### Come viene limitato il lavoro

Il deposito valida i parametri anche per i chiamanti diretti. Richiede al massimo
`limit + 1` ID: l'elemento aggiuntivo serve soltanto a sapere se mostrare un cursore
successivo. Il cursore corrisponde all'ultimo ID restituito, mai a quello aggiuntivo.
Non usa OFFSET, conteggi globali o lettura delle ricevute complete.

PostgreSQL filtra per assessment e limite esclusivo, usando `COLLATE "C"` sia
nel confronto sia nell'ordine. La migrazione 004 aggiunge l'indice composito
`(assessment_id, receipt_id COLLATE "C")`. È additiva e rieseguibile; non cambia
osservazioni, firme, risultati o ricevute. In memoria ogni assessment ha un indice
di ID ordinato: la prima posizione viene trovata con ricerca binaria, senza
scansionare tutte le ricevute del deposito ad ogni lettura. L'indice viene
aggiornato nello stesso percorso sincrono del nuovo salvataggio e non duplicato
quando si ripete il medesimo pacchetto. Gli array restituiti sono copie.

Nuovi volumi Compose e runner isolati includono 004. Un'installazione esistente
richiede applicazione esplicita dopo 003 con backup verificato e `ON_ERROR_STOP`;
non è stata eseguita alcuna migrazione sui database utente. Readiness resta un
controllo di tabelle, colonne e accessi: non certifica la presenza dell'indice
né un livello di prestazioni. Il nuovo indice non costituisce un benchmark.

### Cosa succede fra due pagine

Esempio concettuale con ID abbreviati in ordine: prima leggiamo 10 e 30. Il cursore
è 30. Se nel frattempo viene inserito 20, la pagina successiva non lo vede; se viene
inserito 40, può vederlo. Non è uno snapshot dell'intero archivio. Gli ID già
superati non tornano a causa dei nuovi inserimenti, ma la navigazione non prova
di aver raccolto ogni nuova ricevuta arrivata durante la lettura.

L'elenco dipende dai metadati del database. Una ricevuta può comparire nell'indice
anche se il suo corpo è stato alterato: il recupero completo deve respingerla e
la verifica offline resta necessaria. L'elenco non autentica firme, chiavi,
risultati o completezza contro un amministratore ostile.

### Test e obiettivo originale

I nuovi casi coprono pagine e cursori, ordine memoria/PostgreSQL, duplicati,
partizioni fra risultati, copie, query non valide, autenticazione, errori statici,
inserimenti fra pagine e recupero dopo riapertura partendo soltanto dall'assessment
ID. I pacchetti sintetici mantengono misure e firme autentiche generate dal test;
le varianti cambiano solo l'ordine delle osservazioni. Il test sul catalogo segue
poi gli ID fino al pacchetto e alla verifica offline con chiavi separate.

Gli esiti effettivi sono nelle ricevute sanificate e nella PR; casi PostgreSQL
saltati nella suite ordinaria non costituiscono validazione DB. Non si acquisiscono
nuovi dati ambientali e non cambiano regressione, politica, governance, fondi o
contratti. L'obiettivo resta rendere rintracciabili e contestabili le prove usate
nelle decisioni ambientali delle comunità. Non è un archivio distribuito o una
validazione fisica dell'ambiente.

## English

A retained receipt is difficult to recover if its ID is lost. Given a known
assessment ID, an authenticated caller can now discover associated receipt IDs,
retrieve one exact packet, then verify it offline with separately trusted keys.
Discovery, retrieval and authentication of evidence remain separate steps. No
historical proof is fabricated and no variant is selected as authoritative.

`GET /v1/assessments/:assessmentId/evidence-receipts` requires `x-oracle-token`.
Optional `limit` defaults to20, range 1–100, strict unsigned decimal without
leading zeros, whitespace or exponents. Optional `after` is a lowercase
0x-prefixed 64-digit hex ID. Unknown/duplicate query parameters and malformed IDs
are rejected before lookup, after authentication. All responses use no-store.

Response: `{assessmentId, receiptIds, nextAfter?}`. IDs are strictly ascending
ASCII, not time or quality order. `nextAfter` is present only when another row
exists and equals the last returned ID. It is an exclusive ordering bound and
need not exist in storage. Unknown/legacy assessments return 200 with an empty
array. There are no raw observations, packets, keys, signatures or total counts.
Existing authenticated `GET /v1/evidence-receipts/:receiptId` retrieves a packet.

Store boundaries validate parameters independently. At most N+1 IDs are fetched;
no OFFSET, global count or full-packet read is needed. PostgreSQL uses C collation
for comparison and ordering, matching the additive 004 composite index. Memory
uses an assessment-specific sorted ID index and binary search; reads return array
copies. Duplicate packets do not duplicate index entries. New-volume Compose and
isolated runners include 004; existing databases require explicit migration after
003. No user database was migrated. Readiness does not certify index presence or
performance, and the index is not a benchmark claim.

Pagination is not a cross-page snapshot. After a page ending at 30, a new 20 lies
behind the cursor and may be missed; a new 40 may appear. These are abbreviated
conceptual IDs. The catalog depends on database metadata, not a completeness or
authenticity proof. A listed packet may still have a corrupt body and be rejected
by full retrieval/offline verification. Trusted keys must still come separately.

Tests cover ordering, boundaries, pagination, partitions, idempotence, copies,
authentication/errors, interleaved inserts and reopening before discovery from
assessment ID alone. Synthetic variants preserve signed values and signatures;
only raw observation order differs. Actual results are recorded separately;
skipped database tests are not DB validation. The original mission remains
traceable, contestable environmental evidence supporting community decisions,
without changing numerical models, governance, contracts or funds.
