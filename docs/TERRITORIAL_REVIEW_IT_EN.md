# Verifica territoriale offline / Offline territorial review

## Italiano

Il comando riproduce l'analisi dell'ossigeno disciolto per la stazione
`USGS-14211720` sul Willamette. Usa l'[archivio USGS versionato](datasets/usgs-willamette/manifest.json)
e le impronte del caso e delle consegne fissate nella [revisione storica][archive-revision]. Ricarica i dati
originali e verifica che la consegna completa sia riproducibile e che le due
consegne di prova, alterata e incompleta, vengano respinte. Una verifica
inaspettata comporta un codice di uscita diverso da zero.

Dopo l'installazione e la build, l'esecuzione avviene offline a partire dai
file locali. Usa Node.js 24 o successivo e pnpm 11.7.0 dalla radice del
repository. I comandi sono nella sezione [English](#english).

Il report HTML si apre direttamente in un browser. Il CSV contiene tutte le
coppie cronologiche tra origine della previsione e misura a un'ora, con tempi
UTC, concentrazioni in mg/L, identificativi della stazione e della serie e
l'impronta dell'archivio. Il JSON contiene la verifica, l'analisi e le coppie.

In questa finestra storica, 673 osservazioni approvate producono 335 coppie
valide. L'errore assoluto medio è 0,242 mg/L per il modello e 0,205 mg/L per la
baseline che mantiene l'ultimo valore misurato. L'archivio non contiene eventi
sotto la soglia illustrativa di 5 mg/L, quindi la sensibilità agli eventi resta
da misurare. La verifica riguarda la riproducibilità dei risultati e le consegne
simulate. Per il contesto scientifico e di governance, consulta i
[risultati della prova territoriale](TERRITORIAL_JOB_RESULTS_IT_EN.md).

## English

The verifier replays the archived dissolved-oxygen analysis at Willamette station
`USGS-14211720`. It reloads the [USGS snapshot](datasets/usgs-willamette/manifest.json)
and checks delivery commitments from the [archived Git revision][archive-revision]. It expects the complete
delivery to reproduce and the altered and incomplete submissions to be rejected.
An unexpected outcome returns a nonzero exit code. The verification runs offline
after setup and covers archived calculations and simulated delivery scenarios.

From the repository root with Node.js 24 or later and pnpm 11.7.0:

```sh
pnpm install --frozen-lockfile
pnpm --filter '@terravoce/environmental-case...' build
pnpm --silent territorial:verify
```

To save the standalone browser report and the CSV in Bash:

```sh
mkdir -p outputs
pnpm --silent territorial:verify --format html > outputs/willamette-review.html
pnpm --silent territorial:verify --format csv > outputs/willamette-forecast-pairs.csv
```

In PowerShell, save the same files as UTF-8:

```powershell
New-Item -ItemType Directory -Force outputs | Out-Null
pnpm --silent territorial:verify --format html | Out-File -Encoding utf8 outputs/willamette-review.html
pnpm --silent territorial:verify --format csv | Out-File -Encoding utf8 outputs/willamette-forecast-pairs.csv
```

The CSV includes every chronological one-hour forecast pair, with UTC
timestamps, mg/L values, station and time-series identifiers and the archive
digest. In this archive, 673 approved observations yield 335 pairs. Mean absolute error is
0.242 mg/L for the model and 0.205 mg/L for the latest-value baseline. The
archive contains zero observations below the illustrative 5 mg/L threshold, so
event detection remains unmeasured. See the [territorial demonstration results](TERRITORIAL_JOB_RESULTS_IT_EN.md)
for the limits of the retrospective analysis and local governance simulation.

## Related workflows / Flussi analoghi

| Reference | Pattern used in this review |
| --- | --- |
| USGS Water Data for the Nation | The source separates continuous observations, monitoring locations and time-series metadata. The review keeps the station, series, source URL and snapshot digest with the results. [USGS Water Data APIs](https://api.waterdata.usgs.gov/docs/ogcapi/migration/) |
| Water Quality Portal | The data workflow identifies sampling locations, characteristics and date ranges. The report identifies this review's station, measured parameter and fixed window. [Water Quality Portal user guide](https://waterqualitydata.us/beta/portal_userguide/) |
| Water Rangers | Its platform presents water measurements by location and offers CSV for further analysis. This review provides a portable browser report and a CSV of the evaluated pairs. [Water Rangers data access](https://waterrangers.com/data-platform/sharing-data/how-to-access-data/) |

[archive-revision]: https://github.com/atlas-devlab/virdacora/tree/8e0d0d68f8dbaa58eb0d89ce0b7cdcb5790ae94e/docs/evidence/territorial-job
