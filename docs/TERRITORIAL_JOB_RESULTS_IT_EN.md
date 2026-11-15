# Virdacora: incarico territoriale eseguito / Executed territorial job

Risultati registrati il 2026-11-15T13:47:36.997552+00:00. Dati ambientali reali archiviati; identità,
camere, firme del bridge, revisori, tempo EVM e compensi simulati.

## Italiano — cosa fa concretamente

L'incarico collega osservazioni, analisi controllabile, decisione comunitaria,
consegna, verifica e compenso. Il lavoro remunerato è una **revisione dei dati**.
Non sono stati commissionati campionamenti, lavori sul fiume o risanamenti.
Il prototipo usa ruoli locali simulati, non rappresentanti reali del territorio.

### Primo passo: fonte conservata

Abbiamo riutilizzato 673 misure USGS di ossigeno disciolto,
stazione `USGS-14211720` sul Willamette a Portland, dall'1 al 15 agosto
2025. Hash, metadati di stazione, serie, unità, istanti e stato Approved vengono
ricontrollati. Questa esecuzione non acquisisce nuovi dati; il manifest registra
la precedente cattura del 2026-10-11. I file originali restano invariati.

### Secondo passo: termini prima del risultato

Il caso fissa fonte, policy, istanti, azione DATA_REVIEW, 10 unità TEST senza
valore e regole di consegna. Gli importi non sono euro, criptovalute di mercato
né una vendita ENV. L'ERC-20 locale è il fixture MockStablecoin, simbolo TUSD;
TEST è il nome usato nei termini dell'incarico. Nessun wallet reale è usato.
L'esecutore deve consegnare misura di verifica e confronto riproducibile degli
errori, anche se sfavorevoli al nostro modello. L'hash finanziato resta uguale
nei tre percorsi: `0x3cee978fda3fd8e84c92e2b0a94dec7bdb5fe0c64560c4b13e8e3babd4414f84`.

### Terzo passo: Oracle e proposta

Dodici osservazioni dell'origine prefissata entrano nell'Oracle tramite API e
firme Ed25519 temporanee dell'importatore locale. Sono firme di importazione,
non firme USGS o dei sensori. L'assessment coincide con la ricostruzione del caso.
Il bridge usa tre firme locali su quattro: non è un nuovo test di cluster ABCI.
La policy limita azione, destinatario e budget; i fondi vanno al deposito escrow.

### Quarto passo: comunità e giovani

La demo registra i due ruoli civici e apre una contestazione della proposta.
Un controfattuale locale, dichiarato e ripristinato tramite snapshot, dimostra
che il solo voto della comunità non basta dopo la chiusura del voto. Poi entrambe
le camere approvano il percorso principale. La suite dei contratti verifica
anche il blocco quando i giovani votano contro. Chi detiene ENV non acquista
un voto ambientale. Non è stato coinvolto un residente reale di Portland.

### Quinto passo: consegna onesta, anche quando il modello perde

Per il target prefissato il modello produce 8.655594 mg/L;
la misura approvata archiviata è 8.2 mg/L e l'ultima misura
ripetuta avrebbe dato 8.4 mg/L. Gli errori assoluti sono
0.455594 e 0.200000 mg/L.
Su 335 coppie del replay la MAE è 0.242038
per il modello e 0.204776 mg/L per l'ultima misura:
il modello perde in questa finestra. Il lavoro completo viene ugualmente pagato.
Non abbiamo ritoccato pesi, soglie, dati o selezione per migliorare quel numero.
Non ci sono eventi sotto la soglia dimostrativa; la capacità di allarme resta
non valutata. È un confronto retrospettivo su dati finalizzati.

### Sesto passo: due controlli della consegna

Ciascuna chiamata del revisore rilegge da disco l'archivio, ne verifica i vincoli,
ricostruisce tutto il caso e confronta il documento consegnato. Prima di ogni
approvazione vengono riletti caso finanziato, proposta eseguita, fonte, policy,
azione, importo, destinatario, esecutore, revisori, scadenza e hash consegnato
sull'escrow. Nessuno può far passare una misura alterata soltanto ricalcolando
un hash coerente. Un errore di rete o un'eccezione generica non conta come un
rifiuto corretto: i test richiedono il codice o revert ABI specifico previsto.

La correzione rispetto alla vecchia demo è importante: il verificatore non
riutilizza il Dataset normalizzato fornito dall'esecutore. Una sua manipolazione
poteva essere internamente coerente con un report falso; la rilettura separata
dell'archivio concordato fa fallire questa consegna.

### Settimo passo: compensi e rimborsi verificati

Ogni riga è un deployment separato con dieci unità iniziali. I saldi non sono
una suddivisione di un unico budget complessivo fra tre persone.

| Percorso | Esecutore finale | Tesoreria finale | Escrow finale |
|---|---:|---:|---:|
| Consegna valida | 10 TEST | 0 TEST | 0 TEST |
| Dati/consegna alterati | 0 TEST | 10 TEST | 0 TEST |
| Consegna insufficiente | 0 TEST | 10 TEST | 0 TEST |

- Valido: due approvazioni dello stesso risultato, un solo pagamento; un solo
  revisore e un secondo tentativo di pagamento vengono respinti.
- Alterato: una copia dei byte grezzi fallisce l'integrità; una misura falsa con
  errori e hash ricalcolati fallisce la riproduzione. Nessuna approvazione di
  consegna né pagamento; un revisore rifiuta e rimborsa tutto alla tesoreria.
- Insufficiente: report senza misura target, baseline ed errori, con hash
  ricalcolato. Entrambi i controlli lo respingono; nessuna approvazione o
  pagamento, rimborso completo. Dopo il rimborso non è possibile pagare.

In ciascun percorso il controllo conserva la somma tesoreria + escrow +
esecutore, pari alla fornitura totale locale. Alla comunità non viene attribuita
una quota monetaria in questo contratto; i suoi diritti decisionali e di revisione
sono espliciti. Un'eventuale ripartizione economica richiede termini distinti.

### Problemi incontrati e corretti

Il controllo TypeScript dedicato ha rilevato errori nello script dimostrativo,
prima non incluso dal controllo dei contratti. Sono stati risolti con tipi ABI
generati, valori di ritorno espliciti e verifica della presenza dei signer;
non abbiamo disattivato strict o aggiunto soppressioni. Le dipendenze di tipi
ethers e hardhat-ethers sono ora dichiarate direttamente, alle versioni già
bloccate dal progetto. Installazione finale tramite Corepack pnpm 11.7.0.

La prima esecuzione ha completato i pagamenti ma riportava un'etichetta v1
sbagliata nel riepilogo del replay. Il confronto con caso e Oracle ha individuato
la discrepanza. La versione ora deriva dall'assessment effettivo, già v2 nella
base di lavoro. La prima prova resta archiviata con errata e la seconda è la
prova finale. I due casi, i candidati, i valori numerici e i saldi coincidono;
cambia solo l'etichetta del riepilogo. Il vecchio caso storico conserva i propri
hash; l'Oracle corrente produce correttamente nuovi identificativi versionati.
Vedere [compatibilità ed errata](TERRITORIAL_JOB_COMPATIBILITY_IT_EN.md).

### Verifiche realmente eseguite

- Build del workspace e check ordinari superati.
- Test locali: protocollo 1, TerraLex 3, Oracle 342, modulo dati/review 38,
  contratti 20: **404 passati**. I 62 test PostgreSQL opzionali restano saltati:
  non è una nuova verifica di database reale.
- Dopo la correzione dell'etichetta: ricompilazione del modulo, suoi 38 test e
  controllo TypeScript dello script superati; nuova esecuzione completa con tutti
  e tre gli esiti attesi. Non sono 442 test distinti: il sottoinsieme è stato
  ripetuto per verificare la correzione.
- Il controllo CI è configurato per eseguire anche il typecheck dello script e
  la demo territoriale. Lo stato remoto è una verifica distinta, visibile nella PR.

La revisione e il controllo incrociato sono assistiti da agenti Codex della
stessa famiglia. Non sono un audit scientifico o ambientale indipendente.

### Limiti pratici

L'escrow tratta hash e identità autorizzate; non legge il significato scientifico
del JSON. I revisori autorizzati restano un confine di fiducia: colludendo
potrebbero approvare un falso. L'integrità dell'archivio non rileva una falsità
originaria del produttore. La prova non certifica calibrazione, sicurezza
idrica, indipendenza delle persone, resistenza generale alla censura o benefici
ecologici. Non sono stati impiegati soldi reali, API a pagamento o un LLM.
Nessun modello, fondo, governance o database operativo è stato modificato.

## English — executed result

The job connects real archived USGS Willamette oxygen data, the existing Oracle,
a constrained proposal, simulated community/youth consent, verified delivery
and valueless local payment. It is a reproducible DATA_REVIEW, not fieldwork or
restoration. Source bytes, pinned origin/target and numerical method remain
unchanged. Historical v1 evidence remains preserved; the current existing
v2-oxygen-units Oracle produces a versioned case/evidence identity.

All three local settlement paths passed. Complete delivery receives ten TEST
units only after two fresh-archive reviews agree on the exact submitted hash.
Altered source bytes fail integrity; a forged measurement with self-consistent
errors and a recomputed hash fails reproduction against the funded case.
Incomplete delivery also fails. Both rejected paths receive zero worker payment,
return all ten units to treasury and leave zero escrow balance. Each scenario is
an isolated deployment with its own ten-unit mock supply. TEST is the job's test
unit label; the local token fixture symbol is TUSD and has no market value.

The honest comparison remains unfavourable: MAE 0.242038
versus persistence 0.204776 mg/L over 335
archived pairs. Compensation rewards complete reproducible work, not favourable
predictions. Every reviewer reloads the original source and binds the full case
and report to queried escrow/proposal terms. Two simulated addresses controlled
by one process are not independently operated human reviewers.

The first run's inherited v1 summary label was wrong although its settlement
paths passed. It is retained under first-run-erratum. A corrected second run
derives the actual analytical version; case, candidates, numeric results and
balances are unchanged. The scoped strict TypeScript check also exposed and
resolved script typing/dependency declarations missed by Solidity compilation.

Validation: workspace build/check, 404 distinct local tests passed; 62 optional
PostgreSQL tests skipped. After the metadata fix, the 38 environmental tests,
module build, scoped script check and complete three-path demonstration passed
again. This does not add 38 new distinct tests or establish database/field truth.
Source terms and USGS URLs remain in the retained manifest. No real funds,
public chain, commissioned operator, ecological improvement or LLM are involved.

## Riproduzione / Reproduction

From the repository root, with Node 24+ and project pnpm 11.7.0:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm territorial:check
pnpm territorial:e2e
```

Default output: `outputs/territorial-job`; that directory must not already exist.
A later execution uses a different `VIRDACORA_TERRITORIAL_OUTPUT` directory. No
wallet, provider key, Docker, environmental API request or model service is needed.

The [execution record](evidence/territorial-job/territorial-job-report.json) is
copied from the final local run. Its case, candidate, review, balances, stages and
transaction files are in the same tree; every hash is a local simulation receipt,
not a public-chain explorer reference. The [pre-run input hashes](evidence/territorial-job/execution-inputs.json)
identify the final tested source files. [First-run erratum evidence](evidence/territorial-job/first-run-erratum/territorial-job-report.json)
remains separate. The protocol and compatibility note explain the acceptance
criteria and trust boundaries.
