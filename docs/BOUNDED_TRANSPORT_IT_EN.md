# Acquisizione limitata / bounded acquisition transport

## Italiano

Il CLI del caso Willamette usava `response.text()` e controllava la lunghezza
solo dopo aver letto tutta la risposta. Contava caratteri JavaScript invece
di byte e poteva sostituire UTF-8 invalido prima di calcolare l'hash.
Il nuovo helper `fetchBoundedUSGSJSON` serve esclusivamente le future chiamate
`fetch` e `verify-live` di quel CLI. La cattura autonoma storica e i suoi file
vincolati al resoconto blockchain restano invariati.

Il trasporto richiede l'origine HTTPS USGS autorizzata, senza credenziali o
frammenti nell'URL, vieta redirect, richiede un media type JSON, applica un
massimo di 10.000.000 byte e un unico timeout di 30 secondi per richiesta e
lettura. Le opzioni consentono solo limiti più stretti. Non fa retry, non usa
cache e non sostituisce dati precedenti dopo un fallimento.

I byte del corpo esposto da `fetch` vengono contati mentre arrivano, anche
quando `Content-Length` manca o mente. Un chunk oltre limite viene respinto
prima di essere copiato. I blocchi conservati sono allocati progressivamente,
al massimo `ceil(maxBytes / 65536)`: molti chunk da un byte non producono più
un oggetto conservato ciascuno. Il blocco finale può avere una coda inutilizzata,
che viene esclusa dal buffer finale e dall'hash. Una risposta piccola alloca
comunque fino a un blocco da 64 KiB, oltre al buffer finale della misura esatta.

La decodifica UTF-8 è rigorosa. Per input validi si conservano anche gli
eventuali byte BOM; non vengono eliminati silenziosamente prima dell'hash.
Contenuto JSON e schemi restano responsabilità del validatore del dataset:
avere un media type JSON non prova validità sintattica o verità ambientale.
Un BOM conservato può essere respinto dal parser successivo.

Su errore si avvia la cancellazione del corpo e si interrompe la richiesta;
una cancellazione bloccata del peer non prolunga l'attesa della funzione.
Il reader viene rilasciato. Queste operazioni seguono il
[contratto Web Streams di Node](https://nodejs.org/docs/latest-v24.x/api/webstreams.html).
Il timeout usa il normale event loop JavaScript, non una garanzia di tempo reale.

### Risultato del benchmark locale

Lo script genera in memoria uno stream sintetico di 64 MiB in chunk da 64 KiB.
Sostituisce `fetch` nel processo: nessuna richiesta esce sulla rete. Confronta
il vecchio percorso conservato nello script e quello nuovo, con un riscaldamento
per metodo, tre misure ciascuno e ordine alternato.

| Misura | Percorso precedente | Percorso limitato |
|---|---:|---:|
| Byte prodotti prima del rifiuto, ogni prova | 67.108.864 | 10.027.008 |
| Chunk prodotti | 1.024 | 153 |
| Mediana locale della durata | 68,07 ms | 16,00 ms |

Il lavoro sintetico evitato è **85,06%**. Il metodo nuovo legge il primo chunk
che supera il limite e lo rifiuta; il vecchio legge l'intero corpo. Una fixture
UTF-8 valida di 1.830 byte mantiene lo stesso SHA-256. Sono misure su Node
24.18.0, Windows x64: non velocità della rete, picco di memoria, capacità di un
servizio remoto o qualità delle previsioni. I blocchi, la copia finale e la
stringa hanno costi aggiuntivi; il limite dei byte non è un limite rigoroso
dell'intero heap del processo. Il benchmark usa `highWaterMark: 0`; il vero
trasporto può avere buffering e decompressione propri.

### Test e confini

43 test mirati coprono limiti esatti, UTF-8 multibyte diviso fra chunk,
UTF-8 invalido, BOM e hash, piccoli chunk attraverso più blocchi, header
assenti/falsi, HTTP e media type falliti con cancellazione, timeout durante
header e corpo, risposte tardive, cancellazione bloccata e URL vietati.
Un test fa arrivare gli header dopo 7 ms e lascia il corpo bloccato: il timeout
di 10 ms scade al termine originale, non dopo altri 10 ms.
L'intera suite environmental-case conta 107 test passati.

Nessun nuovo dato ambientale, addestramento, soglia, punteggio previsionale,
prova con nodi spenti o modifica della governance è stato eseguito qui.
La cancellazione dei corpi HTTP rifiutati nel trasporto storico di
`discovery.ts`, l'UTF-8 dei suoi file offline e la ripresa di catture parziali
rimangono interventi separati: questa patch non dichiara risolti tutti i
percorsi di acquisizione.

## English

The Willamette CLI previously read the complete response with `response.text()`
before checking JavaScript character length. The new helper bounds streamed
body bytes before retaining chunks and rejects invalid UTF-8 without replacing
bytes. It applies one 30-second request/body deadline, a 10,000,000-byte ceiling,
USGS HTTPS-origin restrictions, no redirects, JSON media types, and cancellation
on failure. Options can only tighten the defaults. It performs no retries,
cache use or historical fallback. JSON/schema validation remains downstream.

Buffers are accumulated in lazy 64-KiB slabs, at most `ceil(maxBytes/65536)`,
rather than one retained object per upstream chunk. Unused final padding never
enters the returned text or hash. Valid UTF-8 and BOM bytes are preserved; a
downstream JSON parser may reject a retained BOM. A small body still allocates
up to one slab plus its exact final buffer. Payload limits are not whole-process
heap bounds, and event-loop timeouts are not real-time guarantees.

The local no-network benchmark compares a synthetic 64-MiB stream in 64-KiB
chunks, one warmup and three measured runs per implementation. The old path
produces all 67,108,864 bytes/1,024 chunks before rejecting; the new one produces
10,027,008 bytes/153 chunks, rejects the excess chunk before retaining it and
cancels. Synthetic work avoided is 85.06%; local median durations are 68.07
versus 16.00 ms on Node 24.18.0 / Windows x64. A valid 1,830-byte UTF-8 fixture
has identical SHA-256. These are not network, peak-memory, service-capacity or
forecast-quality measurements; the fixture disables prefetch with highWaterMark
zero, while real transports can buffer and decompress separately.

43 focused tests and all 107 environmental-case tests pass. They cover byte
boundaries, split/malformed UTF-8, BOM/hash preservation, many small chunks,
untrusted metadata, rejection cleanup and the shared deadline after delayed
headers. Integration changes only the future acquisition/verify-live transport
in the Willamette CLI. Legacy autonomous discovery code, archived inputs and
frozen model/evidence bytes remain unchanged. No new observations, fit, forecast
score, outage test, governance action or live deployment occurred. Legacy
discovery transport and interrupted-capture recovery remain separate work.

## Reproduction / Riproduzione

```sh
pnpm build
pnpm --filter @terravoce/environmental-case check
pnpm --filter @terravoce/environmental-case test
pnpm benchmark:transport
pnpm source:verify
pnpm case:replay
pnpm case:verify
```

[Benchmark receipt](evidence/bounded-transport/benchmark.json) ·
[Verification receipt](evidence/bounded-transport/verification.json).
The benchmark stubs `fetch`; these commands do not acquire environmental data.
