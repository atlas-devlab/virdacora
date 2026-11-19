# Acquisizione e verifica del Willamette / Willamette acquisition and verification

## Italiano

`territorial:willamette` acquisisce le risposte originali per le osservazioni
di ossigeno disciolto e i metadati della stazione `USGS-14211720` sul Willamette
a Portland. Usa il connettore USGS del progetto e mantiene fissi la serie, la
finestra storica dalle 00:00 UTC del 1º agosto alle 00:00 UTC del 15 agosto 2025
e l'inizio della valutazione l'8 agosto. Le misure si riferiscono quindi a un intervallo storico.
Una nuova risposta dell'API può avere byte e orario di acquisizione diversi a
parità di osservazioni.

Il comando salva le risposte originali e le loro impronte SHA-256 nel nuovo
pacchetto, insieme alla regola territoriale. Prima della simulazione calcola
l'impronta del caso dal nuovo manifest e dai dati validati. Gli scenari locali
riesaminano tre consegne usando i file appena acquisiti. Una risposta incompleta,
incompatibile o priva delle misure necessarie al caso interrompe la prova. Per
riesaminare a parte lo snapshot versionato usa `territorial:verify`.

Esegui questi comandi dalla radice del repository con Node.js 24 o successivo e
pnpm 11.7.0. Per `--output` scegli una directory nuova.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --silent territorial:willamette --output outputs/willamette-capture-01
```

Conserva separatamente il valore `commitmentsSha256` dal JSON stampato dal
primo comando territoriale. Usa quel valore per sostituire `0x...` nel comando
di verifica, anche quando il pacchetto viene aperto su un'altra macchina.

```sh
pnpm --silent territorial:verify-import --bundle outputs/willamette-capture-01 --anchor '0x...'
```

| Nel pacchetto | Contenuto |
| --- | --- |
| `source/` | Risposte USGS originali, manifest dell'acquisizione con URL e hash, regola territoriale usata. |
| `simulation/` | Caso, consegne, fasi e transazioni simulate, `commitments.json` con le impronte lette dalla simulazione. |
| `summary.json` | Esito della verifica e riepilogo dell'analisi. |

La verifica offline confronta `commitments.json` con l'impronta conservata
separatamente e ricalcola il caso e gli esiti dai dati originali. Il confronto
misura la riproducibilità del risultato rispetto alla simulazione locale.
Identità, voti, revisori e fondi appartengono alla simulazione Hardhat. La
verifica di una firma del produttore o di una transazione su una rete pubblica
richiede prove distinte. La regola si applica alla serie USGS fissata dal
protocollo Willamette. Per consultare altre fonti, usa la
[guida alle fonti](WATER_SOURCES_IT_EN.md).

## English

`territorial:willamette` uses Virdacora's USGS connector to retrieve the original
dissolved-oxygen observations and metadata for station `USGS-14211720` on the
Willamette River at Portland. It uses the fixed historical series and window
from 00:00 UTC on August 1 to 00:00 UTC on August 15, 2025, with evaluation
starting on August 8. A fresh response can have different bytes and a different retrieval
time even when the observations are identical.

The command saves the original responses with their SHA-256 hashes and a copy
of the territorial policy. The validated dataset and new manifest determine
the case commitment before the simulation starts. Three local delivery scenarios
are reviewed against the captured files. An incomplete or incompatible response,
or one missing required observations, stops the run. The separate
`territorial:verify` command reviews the checked-in snapshot.

From the repository root, use Node.js 24 or later and pnpm 11.7.0. Choose a new
directory for `--output`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --silent territorial:willamette --output outputs/willamette-capture-01
```

Keep the `commitmentsSha256` value from the JSON printed by the first territorial
command separately from the bundle. Replace `0x...` below with that stored value
to verify the bundle offline, including on another machine.

```sh
pnpm --silent territorial:verify-import --bundle outputs/willamette-capture-01 --anchor '0x...'
```

| Bundle path | Contents |
| --- | --- |
| `source/` | Original USGS responses, capture manifest with URLs and hashes, and the territorial policy. |
| `simulation/` | Case, submissions, simulated stages and transactions, and `commitments.json` with commitments read from the simulation. |
| `summary.json` | Verification result and analysis summary. |

The verifier compares `commitments.json` with the separately retained digest
and reproduces the case and delivery outcomes from the original files. Its
scope is reproducibility against local-simulation commitments. Identities,
votes, reviewers and funds are simulated in Hardhat. Publisher signatures and
public-chain transactions require separate evidence. The territorial policy
covers the USGS series fixed by the Willamette protocol. For other sources, see
the [water-source guide](WATER_SOURCES_IT_EN.md).
