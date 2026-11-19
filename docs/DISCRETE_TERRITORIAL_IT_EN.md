# Verifica territoriale dei campioni discreti / Territorial review of discrete samples

## Italiano

`territorial:discrete` apre un caso territoriale di ossigeno disciolto per
una fonte e una stazione. La consegna riproduce l'inventario dei campioni e
il riepilogo descrittivo, con conteggi, date, minimo, massimo e media in mg/L.
Le date restano quelle riportate dalla fonte. Il caso finanzia la verifica dei
dati nella simulazione locale Hardhat, con revisori, voti e unità TEST simulati.
La consegna riguarda misure discrete e usa statistiche descrittive. Previsioni
e soglie ecologiche restano fuori dal perimetro di questo caso.

- **Water Quality Portal.** Il riepilogo include le concentrazioni numeriche
  normalizzabili in mg/L, con stato `Accepted` o `Approved` e senza qualificatori.
  L'inventario conserva anche i record esclusi e il motivo. Il comando
  acquisisce il CSV della finestra indicata per la stazione selezionata.
  La verifica dei campioni discreti respinge le righe di un registratore continuo.
  [Servizi WQX 3.0](https://waterqualitydata.us/beta/webservices_documentation/)
- **Water Rangers.** Il riepilogo usa le concentrazioni numeriche riportate
  per il `site_id` selezionato, oppure per il nome del sito se il CSV usa
  quel riferimento. Il formato simple table lascia senza valore lo stato QA
  e l'ora UTC quando questi dati sono assenti. Per una trascrizione da schede
  pubbliche, usa un'opzione `--record-url` per ogni osservazione del sito.
  Il manifest conserva gli URL e il caso li associa agli ID originali.
  [Dizionario dei dati](https://waterrangers.com/data-platform/sharing-data/data-dictionary/)

Usa i [comandi sotto](#commands) per acquisire e simulare. Dopo
l'esecuzione conserva `commitmentsSha256` dal JSON a schermo separatamente
dal pacchetto. `territorial:verify-discrete` confronta il file degli impegni
con quell'impronta, rilegge i dati salvati e verifica offline la riproducibilità
della consegna completa e il rifiuto di quelle alterata e incompleta.

## English

`territorial:discrete` reviews dissolved-oxygen samples from one provider and
one station. Its deliverable is a reproducible sampling inventory with dates,
counts, minimum, maximum and mean concentration in mg/L. The case is scoped
to descriptive statistics on reported samples. Forecasts and ecological
thresholds belong to a separate assessment. Hardhat simulates the reviewers,
votes, settlement and TEST units locally.

- **Water Quality Portal.** Only numeric, unqualified concentrations with
  `Accepted` or `Approved` status enter the summary. The inventory retains
  excluded records and their disposition. The command captures the CSV for
  the selected station and date window. If the response includes data logger
  records, the discrete review stops.
  [WQX 3.0 web services](https://waterqualitydata.us/beta/webservices_documentation/)
- **Water Rangers.** The review imports a local simple table and selects the
  station by `site_id` or the supplied location label when that is the site
  reference. Numeric reported concentrations enter the summary. A simple table
  can leave QA status and UTC time unknown. For a public-record transcription,
  pass one `--record-url` per observation so the case commits to the links and
  associates them with the original observation IDs.
  [Data dictionary](https://waterrangers.com/data-platform/sharing-data/data-dictionary/)

### Commands

Run from the repository root with Node.js 24 or later and pnpm 11.7.0. Choose
a new directory for each `--output`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --silent territorial:discrete --provider wqp --station USGS-01463500 \
  --start 2022-08-01 --end 2022-08-31 --output outputs/delaware-01
```

`USGS-01463500` identifies Delaware River at Trenton, New Jersey.
[USGS monitoring location](https://waterdata.usgs.gov/monitoring-location/USGS-01463500/)

For the Water Rangers example, save the five observations linked in the command
below as an attributed `riverwatch-renfrew.csv`. The columns are
`location,site_id,observed_on,oxygen,observation_id`, and `site_id` is the slug
in the public location URL.
The five public pages show completed QA review. The sixth observation has
QA pending, with a chloride flag at the observation level, and sits outside
this reviewed subset. The simple-table CSV carries the dates and oxygen values.
Use the linked records for the published QA status.
[Location and observations](https://data.waterrangers.com/locations/renfrew-boat-launch/observations) ·
[Sixth observation](https://data.waterrangers.com/observations/169843) ·
[Dataset and licence, DOI 10.25976/0lv2-9568](https://doi.org/10.25976/0lv2-9568)

```sh
pnpm --silent territorial:discrete --provider water-rangers \
  --station renfrew-boat-launch --csv riverwatch-renfrew.csv \
  --dataset-url https://data.waterrangers.com/datasets/riverwatch \
  --attribution 'SOURCE: Riverwatch dataset by Bonnechere River Watershed Project is licensed under Open Data Commons Attribution Licence (ODC-By).' \
  --output outputs/renfrew-01 \
  --record-url https://data.waterrangers.com/observations/169854 \
  --record-url https://data.waterrangers.com/observations/169855 \
  --record-url https://data.waterrangers.com/observations/169858 \
  --record-url https://data.waterrangers.com/observations/169796 \
  --record-url https://data.waterrangers.com/observations/169836
```

For a downloaded simple-table export supply the CSV, dataset URL and dataset
credit shown by Water Rangers. Reserve `--record-url` for transcriptions.
[Water Rangers downloads and attribution](https://data.waterrangers.com/api/faq)

Keep the `commitmentsSha256` from the simulation command's JSON output
separately from the bundle. Substitute that digest for `0x...` below.

```sh
pnpm --silent territorial:verify-discrete --bundle outputs/renfrew-01 --anchor '0x...'
```

| Path | Contents |
| --- | --- |
| `source/observations.csv` | Exact CSV bytes from the provider response or supplied local file. |
| `source/manifest.json` | Station, source metadata and SHA-256. For public transcriptions it also records the original observation URLs. |
| `simulation/` | Case, submissions, review stages, local settlement and commitments read from the simulation. |
| `summary.json` | Verification outcome and descriptive sampling summary. |

Offline verification checks the captured files and the simulated commitments.
It verifies the positive delivery and reproduces why the altered and incomplete
deliveries are rejected. The separately retained digest anchors the local case
and delivery commitments. Publisher signatures and public-chain settlement
would require their own verification.
