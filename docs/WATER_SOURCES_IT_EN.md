# Fonti di ossigeno disciolto / Dissolved-oxygen sources

## Italiano

`water:source` acquisisce dati di ossigeno disciolto da una fonte alla volta.
USGS Water Data e Water Quality Portal rispondono a una query su richiesta per
una stazione e un intervallo inclusivo da 1 a 31 giorni. Per Water Rangers
il comando legge un CSV locale con una riga per osservazione. I comandi di
esempio sono raccolti sotto [Commands](#commands).

- **USGS Water Data** usa le misure continue per il parametro `00300` con la
  statistica istantanea `00011`. L'output conserva stazione, serie, ID del record,
  istante UTC, unità, stato di approvazione e qualificatori forniti da USGS.
  Le date della query sono giorni UTC.
- **Water Quality Portal** usa il profilo WQX 3.0 dei risultati fisico-chimici.
  L'output conserva stazione, organizzazione, attività, ID del risultato, unità,
  stato, qualificatori e condizioni di rilevazione presenti nel CSV. Le date della
  query sono date dell'attività. Il comando riporta data, ora e fuso originali e
  calcola l'istante UTC quando l'offset numerico o l'indicazione UTC sono
  espliciti e l'ora si riferisce alla misura.
- **Water Rangers** usa il formato **simple table** del
  [dizionario ufficiale](https://waterrangers.com/data-platform/sharing-data/data-dictionary/).
  Le colonne richieste sono `location`, `observed_on`, `oxygen` e `observation_id`.
  `site_id` è facoltativo. Quando manca, la località dichiarata identifica il sito
  nell'ambito del dataset. La tabella riporta un giorno di osservazione e l'output
  conserva quel giorno con l'istante UTC assente. Le colonne sui singoli rilevatori
  non fanno parte dell'output.

Il comando restituisce JSON per impostazione predefinita. Usa `--format csv`
per le righe di misura oppure `--format html` per un report autonomo con un massimo
di 250 righe visibili. JSON e CSV contengono tutte le righe importate. Il comando conserva
l'URL della fonte, l'attribuzione e la SHA-256 del contenuto letto. Il valore
normalizzato in mg/L è disponibile per le concentrazioni numeriche con unità
supportata. Un risultato WQX censurato conserva valore e metadati originali.
Il CSV antepone un apostrofo ai testi che un foglio di calcolo potrebbe
interpretare come formule. Il JSON conserva quei testi originali.
L'impronta identifica i byte della risposta o del file e permette di confrontare
copie dello stesso contenuto. Una firma dell'ente richiederebbe una verifica
distinta. Il comando opera in sola lettura, senza server locale o database. I
risultati sono consultabili e restano fuori dai flussi di firma e governance.

Il limite per risposta o file è 8 MiB, con un massimo di 20.000 righe per i CSV.
Una risposta dichiarata incompleta o oltre il limite produce un errore.
Riduci l'intervallo per le query troppo grandi.

Le query USGS e Water Quality Portal sono state provate sui servizi pubblici.
L'import Water Rangers è stato provato su un esempio di test conforme al
dizionario. L'API diretta richiede una chiave rilasciata dal gestore e il modulo
di download chiede un contatto e la finalità d'uso. Per l'import locale scegli
**Agree and download (simple table)** e riporta l'attribuzione indicata per il
dataset. [Guida Water Rangers](https://data.waterrangers.com/api/faq)

## English

The command reads one dissolved-oxygen source per run. USGS Water Data and the
Water Quality Portal are queried on demand for one station and an inclusive
window of 1 to 31 days. USGS uses UTC calendar days and parameter `00300` from the
continuous observations API, with instantaneous statistic `00011`. Water Quality
Portal uses WQX 3.0 physical/chemical results for `Dissolved oxygen (DO)` in water.
It retains reported activity date, time and zone, and emits a UTC timestamp only
when the offset or UTC designation is explicit and the reported time applies to
the reading.

Water Rangers import reads a local **simple table** with one observation per row.
The [published dictionary](https://waterrangers.com/data-platform/sharing-data/data-dictionary/)
defines `location`, `observed_on`, `oxygen` in mg/L, `observation_id` and the optional
`site_id`. With no `site_id`, the provided location is used as the site reference
within the dataset. Date-only records keep the reported date and a null UTC
timestamp. The public dataset download form asks for contact information and
purpose, while direct API access requires an issued key. The CSV adapter was
checked against a dictionary-based test fixture. The USGS and Water Quality
Portal queries were run against the public services.

### Commands

Run the setup and the selected source query from the repository root with
Node.js 24 or later and pnpm 11.7.0.

```sh
pnpm install --frozen-lockfile
pnpm --silent water:source --provider usgs --station USGS-14211720 --start 2025-08-08 --end 2025-08-08
pnpm --silent water:source --provider wqp --station USGS-14211720 --start 2025-08-01 --end 2025-08-31
pnpm --silent water:source --provider water-rangers --csv path/to/download.csv --dataset-url https://data.waterrangers.com/datasets/education-programs --attribution 'SOURCE: Education Programs dataset by Water Rangers is licensed under Open Data Commons Attribution Licence (ODC-By).'
```

For Water Rangers, replace the local path, dataset URL and attribution with the
values from your export. Save another output format with `--format csv` or
`--format html` followed by shell redirection to a local file. The command accepts
at most 8 MiB per remote response or local input file and 20,000 records per CSV.
It fails when a provider reports an incomplete result.

CSV prefixes text that spreadsheets could interpret as a formula with an
apostrophe.

JSON retains batch provenance and reading details, including original text and value,
unit and provider quality fields. The normalized `valueMgL` is null for
unsupported units or values that cannot be treated as numerical observations.
The SHA-256 identifies the bytes actually received or read. It can be compared
with another copy of those bytes. The report is read-only and covers the source
records, with no station authentication, publisher signature check or transfer
into the Oracle decision pipeline.

### Reuse and attribution / Riuso e attribuzione

Retain the recorded source URL, attribution and applicable data terms when
sharing exported readings. Project source-code terms and data-provider terms
apply to their respective materials.

- Credit the [U.S. Geological Survey](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
  for its data. [USGS continuous data documentation](https://api.waterdata.usgs.gov/docs/ogcapi/migration/)
- Cite [Water Quality Portal](https://waterqualitydata.us/beta/portal_userguide/#cite-the-water-quality-portal)
  and preserve the submitting organization's identity and applicable terms.
  [WQX 3.0 web services](https://waterqualitydata.us/beta/webservices_documentation/)
- For Water Rangers keep the dataset-specific attribution from the download
  under the [Open Data Commons Attribution License](https://opendatacommons.org/licenses/by/1-0/).
  [Water Rangers data sharing guide](https://data.waterrangers.com/api/faq)
