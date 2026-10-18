# Oracle: robustezza e prestazioni / resilience and performance

## Italiano

Questo intervento rafforza l'Oracle di Virdacora: conserva le osservazioni
accettate, restituisce le ultime misure e rende riproducibile l'analisi. Non
cambia il calcolo delle previsioni, le regole TerraLex o i contratti.

### Problemi corretti

- L'archivio in memoria restituiva riferimenti ai propri oggetti. Modificare
  un sensore o un'osservazione ricevuta dal chiamante poteva modificare anche
  il dato conservato. Ora ingressi e uscite sono copie isolate dei record
  previsti dagli schemi, i cui campi sono primitivi.
- Una valutazione vecchia arrivata in ritardo sostituiva la più recente.
  Ora la scelta considera `generatedAt`, poi `assessmentId`, e conserva
  l'identità delle valutazioni già accettate. Non dipende dall'ordine di arrivo.
- Il limite zero produceva `slice(-0)` e restituiva l'intero archivio. Entrambi
  i backend ora richiedono un intero positivo sicuro, prima di leggere i dati.
- JSON malformato, corpo eccessivo e formato non supportato diventavano errori
  500. Le classi note del parser Fastify ora restituiscono 400, 413 o 415 con
  un codice privo del contenuto ricevuto. Gli errori interni inattesi conservano
  la risposta generica 500. Vedi il [riferimento Fastify](https://fastify.dev/docs/latest/Reference/Errors/).
- Il backend PostgreSQL copia i corpi JSON prima di accodarli al pool, così
  mutazioni successive del chiamante non cambiano la scrittura in attesa.

### Perché la lettura è più veloce

Prima ogni richiesta materializzava tutte le osservazioni, filtrava la regione
e la metrica, ordinava le corrispondenze e prendeva la coda. Ora un indice per
coppia regione/metrica mantiene l'ordine cronologico: inserimento in coda per
arrivi ordinati, ricerca binaria e spostamento nell'array per arrivi tardivi.
La lettura prende soltanto la coda richiesta e ne restituisce copie isolate.
Le chiavi sono tuple JSON, evitando ambiguità dovute ai separatori nei nomi.

Il benchmark usa 100.000 record sintetici in 100 regioni, letture delle ultime
512 osservazioni, 100 campioni di lettura e cinque inserimenti dell'intero
corpus per scenario. Confronta il nuovo archivio con l'algoritmo precedente
conservato nello script e verifica l'uguaglianza dell'intero risultato per
ogni regione, anche con timestamp uguali e arrivi mescolati.

| Arrivi | Mediana lettura precedente | Mediana lettura indicizzata | Mediana inserimento corpus precedente / nuovo |
|---|---:|---:|---:|
| Cronologici | 4,20125 ms | 0,05990 ms | 125,804 / 234,747 ms |
| Mescolati | 24,33275 ms | 0,07225 ms | 201,653 / 380,241 ms |

Sono misure locali su Node 24.18.0, Windows x64: circa 70 e 337 volte sul solo
tempo mediano di lettura dei due scenari. Il tempo mediano di inserimento
sale a circa 1,87 e 1,89 volte: mantenere l'indice e copie isolate ha un costo.
Non sono throughput HTTP, prestazioni PostgreSQL o una promessa di latenza.
Il report conserva p95 e campioni riepilogati; cinque campioni di scrittura
non stimano una coda di latenza stabile. Il garbage collector non è forzato.

### Verifiche e limiti

I test confrontano l'indice con un ordinamento completo di riferimento e
coprono mutazioni, limiti, arrivi fuori ordine, pareggi e replay concorrenti.
Sedici richieste simultanee identiche, o firmate con valori diversi ma stesso
sensore e sequenza, devono produrre una sola accettazione e 15 rifiuti.
I test PostgreSQL di questo intervento usano mock del pool: non sono una prova
con un database attivo. Le demo rimangono sintetiche e su blockchain locale.

L'archivio in memoria continua a conservare tutta la storia; non è persistente
e non ha un tetto di memoria. Conserva anche gli ID delle valutazioni ricevute.
Inserire dati tardivi richiede ancora spostamenti nell'array della serie.
L'ordinamento JavaScript resta quello precedente, `Date.parse` al millisecondo
e poi ID. Timestamp con frazioni inferiori al millisecondo possono differire
dall'ordine PostgreSQL: questa patch non cambia il contratto temporale o le
firme per risolvere quel problema separato.

## English

This change strengthens Oracle storage and request handling without changing
forecast arithmetic, TerraLex or contracts. Memory storage now isolates flat
schema-record snapshots, selects the latest assessment by timestamp and ID
rather than arrival order, rejects invalid query limits, and maintains a
per-region/metric ordered index. PostgreSQL validates the same limits and
copies JSON payloads before queueing writes. Known Fastify parser errors retain
sanitized 400/413/415 responses; unexpected internal errors stay generic 500.

The synthetic benchmark compares the previous inline algorithm with the new
store using 100,000 rows, 100 regions, 512-row tails, 100 read samples and five
whole-corpus write samples per arrival scenario. Complete query payloads match
for every region. Local median reads fall from 4.20125 to 0.05990 ms for ordered
arrivals and 24.33275 to 0.07225 ms for shuffled arrivals. Whole-corpus insertion
medians rise from 125.804 to 234.747 ms and 201.653 to 380.241 ms respectively.
These are local Node 24.18.0 / Windows x64 memory-store measurements, not HTTP,
PostgreSQL, field capacity or forecasting claims. Snapshot/index costs and
uncontrolled garbage collection are included; five write samples do not
establish a stable tail-latency estimate.

Tests cover reference-order equivalence, isolated snapshots, late results,
limits and concurrent replay rejection. PostgreSQL tests mock its pool; no live
database was validated. Full history and assessment IDs remain retained with
no memory cap or persistence. Late insertion still shifts a series array.
Existing millisecond JavaScript ordering is preserved; submillisecond parity
with PostgreSQL remains a separate unresolved contract issue.

## Reproduction / Riproduzione

```sh
pnpm build
pnpm check
pnpm test
pnpm demo
pnpm e2e
pnpm benchmark:oracle
```

[Benchmark receipt](evidence/oracle-resilience/benchmark.json) ·
[Verification receipt](evidence/oracle-resilience/verification.json).
CI also runs a small synthetic benchmark for output equivalence, without any
hardware-dependent timing acceptance threshold.
