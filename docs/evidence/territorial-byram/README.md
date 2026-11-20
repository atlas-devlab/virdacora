# Prova territoriale di Byram / Byram territorial review

## Italiano

Un caso Virdacora riunisce due prelievi di ossigeno disciolto presso il Byram
Swinging Bridge sul Pearl River, Mississippi, del 2–3 novembre 2018.

| Fonte | Ora locale | Ossigeno disciolto | Record |
| --- | --- | ---: | --- |
| Water Quality Portal, Mississippi Department of Environmental Quality | 2 novembre, 14:20 CDT | 9,06 mg/L | `STORET-781887710`, `Accepted` |
| Water Rangers, Mississippi Water Stewards | 3 novembre, 11:39 CDT | 7,40 mg/L | `115848`, `qc_complete` |

Le coordinate pubblicate per i due prelievi distano circa 23 m. I campioni
distano 21 ore e 19 minuti e differiscono di 1,66 mg/L. Lo scarto descrive
due prelievi puntuali in momenti diversi. [Stazione WQP](https://waterqualitydata.us/provider/STORET/21MSWQ_WQX/21MSWQ_WQX-02486500/) · [Sito Water Rangers](https://data.waterrangers.com/locations/byram-swinging-bridge)

Il fascicolo conserva come riferimento storico i 191 risultati discreti USGS
del 1969–1978 e i metadati dei minimi e massimi giornalieri del 1971 per
`USGS-02486500`. Solo i due campioni in tabella entrano nel confronto del 2018.
[Riepilogo USGS](https://api.waterdata.usgs.gov/samples-data/summary/USGS-02486500)

La simulazione ha approvato la consegna completa con due revisori e ha
rilasciato 10 TEST simulati. Quando una concentrazione è stata alterata o un
campione è stato omesso, la consegna è stata respinta e la tesoreria ha ricevuto
il rimborso. Tutti gli scenari usano la stessa impronta del caso. Partecipanti,
transazioni e fondi appartengono alla simulazione locale. [Rapporto](simulation/territorial-job-report.json)

## English

The Byram case compares two samples taken on November 2–3, 2018, at the
Byram Swinging Bridge reach of the Pearl River. The concentrations differ
by 1.66 mg/L across 21 hours and 19 minutes. USGS station `USGS-02486500`
provides historical context. Only the two 2018 samples enter the comparison.
The archived [report](simulation/territorial-job-report.json) records the
verified delivery, the rejected altered delivery and the rejected incomplete
delivery on a local Hardhat network with simulated reviewers and tokens.

### Offline verification

Run from the repository root with Node.js 24 or later and pnpm 11.7.0.
The [recorded SHA-256](commitments.sha256) was captured from the simulation
process. Retain it separately if you distribute a copy of the bundle.

```sh
pnpm install --frozen-lockfile
pnpm build
bundle=docs/evidence/territorial-byram
pnpm --silent territorial:verify-discrete --bundle "$bundle" --anchor "$(cat "$bundle/commitments.sha256")"
pnpm --silent territorial:discrete --comparison "$bundle/source" --output outputs/byram-01
```

### Data attribution

- [`source/wqp.csv`](source/wqp.csv) contains the original WQX 3.0 response for
  station `21MSWQ_WQX-02486500`, captured 2026-11-19 UTC. The Mississippi
  Department of Environmental Quality submitted the data. [Water Quality Portal query](https://waterqualitydata.us/wqx3/Result/search?siteid=21MSWQ_WQX-02486500&characteristicName=Dissolved+oxygen+%28DO%29&sampleMedia=Water&startDateLo=11-02-2018&startDateHi=11-03-2018&mimeType=csv&dataProfile=fullPhysChem) · [Portal DOI](https://doi.org/10.5066/P9QRKUVJ)
- [`source/water-rangers.csv`](source/water-rangers.csv) transcribes the
  selected concentration into the simple-table format. The Mississippi Water
  Stewards dataset by Mississippi State University is licensed under Open
  Data Commons Attribution License 1.0. The [supporting excerpt](context/water-rangers-115848.json)
  retains the published time and QA status. [Public observation](https://data.waterrangers.com/observations/115848) · [Dataset](https://data.waterrangers.com/datasets/mississippi-water-stewards) · [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/)
- [`source/usgs-history.csv`](source/usgs-history.csv) and the
  [daily metadata](context/usgs-daily-metadata.json) are from U.S. Geological
  Survey Water Data for the Nation. [USGS credit guidance](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
