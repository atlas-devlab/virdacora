# Virdacora: guida operativa per chi prende in mano il progetto

> Virdacora è un prototipo di ricerca con un
> [repository pubblico su GitHub](https://github.com/atlas-devlab/virdacora).
> La licenza predefinita è [PolyForm Noncommercial 1.0.0](LICENSE).
> La [policy delle licenze](LICENSE_POLICY.md) documenta le eccezioni e i
> permessi concessi in precedenza sotto MIT e AGPL.

## A chi serve questa guida

Questa guida è pensata per una persona che deve dirigere Virdacora senza essere
uno sviluppatore. Spiega che cosa abbiamo costruito, quale problema affronta,
che cosa si può dimostrare oggi e quali passi sono necessari prima di coinvolgere
comunità, denaro o infrastrutture reali.

Il principio più importante è semplice: **il software attuale è un prototipo di
ricerca funzionante, non un sistema pronto per governare fondi o interventi
fisici nel mondo reale**.

## Se devi iniziare domani

Le prime azioni del nuovo responsabile sono queste:

1. Leggere le sezioni "Virdacora in una frase", "Che cosa abbiamo costruito" e
   "Che cosa non abbiamo ancora costruito".
2. Chiedere a un tecnico di mostrare dal vivo il controllo di salute, la demo e
   i test descritti in questa guida.
3. Scegliere un solo possibile caso pilota, con una regione, una metrica e
   un'azione reversibile chiaramente definite.
4. Nominare almeno un responsabile scientifico e un referente della comunità
   prima di decidere soglie o regole.
5. Dichiarare per iscritto che la prima fase sarà in modalità ombra: niente fondi
   reali, vendita di ENV o controllo di dispositivi fisici.
6. Usare il piano dei primi 90 giorni come agenda di progetto.
7. Non avanzare alla fase successiva finché i criteri di sicurezza e governance
   elencati nella guida non sono soddisfatti.

## Virdacora in una frase

Virdacora è un sistema pubblico per trasformare dati ambientali verificabili in
decisioni controllate, finanziabili e contestabili dalle comunità coinvolte.

Il progetto combina:

- sensori e fonti di dati che firmano ciò che osservano;
- un modello che valuta rischio, tendenza e affidabilità dei dati;
- TerraLex, un nuovo linguaggio per scrivere regole ambientali leggibili e
  verificabili;
- una blockchain che conserva prove, regole, voti e movimenti della tesoreria;
- una governance nella quale il possesso di token non compra il diritto di
  decidere per una comunità.

## Il problema che vogliamo risolvere

Oggi molte decisioni ambientali falliscono per una combinazione di problemi:

- i dati sono frammentati o possono essere nascosti;
- non è sempre chiaro chi ha prodotto un dato e se è stato modificato;
- le previsioni dei modelli sono difficili da riprodurre;
- chi subisce le conseguenze ha spesso poca voce;
- i fondi arrivano tardi o non è trasparente come vengono spesi;
- un algoritmo può suggerire un intervento senza avere limiti comprensibili.

Virdacora prova a creare una catena di responsabilità completa:

**osservazione -> prova -> valutazione -> regola pubblica -> possibilità di
contestazione -> decisione -> eventuale finanziamento**.

## Un esempio concreto

Immaginiamo un progetto pilota nel Delta del Po.

1. Uno o più sensori misurano l'ossigeno disciolto nell'acqua.
2. Ogni misurazione viene firmata digitalmente. La firma permette di verificare
   da quale sensore proviene e impedisce di riutilizzare vecchi dati come nuovi.
3. Il servizio Oracle raccoglie le misurazioni e calcola andamento, anomalia,
   previsione, livello di rischio e confidenza.
4. TerraLex confronta il risultato con una regola pubblica. La regola di esempio
   richiede almeno cinque osservazioni, rischio almeno pari a 0,72 e confidenza
   almeno pari a 0,80.
5. Se le condizioni sono soddisfatte, il sistema può proporre soltanto una delle
   azioni reversibili autorizzate: aumentare i campionamenti oppure finanziare
   un'aerazione controllata dell'acqua.
6. La proposta non può superare 250 USDC ogni sette giorni e rimane contestabile
   per almeno 24 ore.
7. Se una persona della comunità coinvolta la contesta, la proposta passa al voto
   della camera della comunità e della camera dei giovani.
8. Solo dopo il percorso previsto il contratto di tesoreria può trasferire la
   cifra esatta al destinatario autorizzato.

Questo esempio è già rappresentato nel progetto e viene eseguito nei test. Non
è però collegato a sensori, denaro o aeratori reali.

## Che cos'è davvero TerraLex

TerraLex non vuole sostituire linguaggi generali come Python o JavaScript. È un
linguaggio specializzato per esprimere una politica ambientale.

Una politica TerraLex dichiara, in modo limitato e controllabile:

- la regione interessata;
- la grandezza ambientale osservata;
- quanti dati sono necessari;
- quali soglie di rischio e confidenza devono essere superate;
- quali azioni reversibili sono ammesse;
- il budget massimo;
- il tempo disponibile per una contestazione;
- i passaggi di governance obbligatori;
- il divieto di azioni irreversibili.

TerraLex non può navigare su Internet, chiamare programmi arbitrari, leggere
l'orologio, creare cicli infiniti o modificare da solo la propria regola. A
parità di regola e dati produce lo stesso risultato.

La regola compilata riceve un **hash**, cioè un'impronta digitale. Se qualcuno
modifica anche un solo elemento della politica, l'impronta cambia e la modifica
diventa evidente.

### In che cosa TerraLex è diverso da Python

TerraLex è più simile a una legge eseguibile che a un normale programma.
Python è un linguaggio generale con cui si possono costruire siti, modelli AI,
automazioni e interi servizi. TerraLex è un linguaggio specializzato che può
soltanto dichiarare le condizioni e i limiti di una decisione ambientale.

| Python | TerraLex |
| --- | --- |
| Può costruire quasi qualsiasi programma | Può descrivere soltanto policy ambientali previste dalla grammatica |
| Indica come eseguire un algoritmo | Dichiara che cosa è consentito o vietato |
| Ha variabili, funzioni, classi e moduli | Ha un insieme ristretto di dichiarazioni |
| Permette cicli e ricorsione | Non permette cicli o ricorsione |
| Può leggere file, rete, orologio e servizi esterni | Non possiede accesso a risorse esterne |
| Può produrre effetti durante l'esecuzione | Produce soltanto una decisione e le sue motivazioni |
| Può dipendere da librerie e stato della macchina | A parità di input e versione produce lo stesso risultato |
| Non genera automaticamente un'identità della regola | Genera una rappresentazione canonica e un hash della policy |

Una condizione simile può essere scritta anche in Python. La differenza è che
un programma Python potrebbe, nello stesso punto, chiamare un server, cambiare
un file o effettuare un'altra operazione non prevista. TerraLex non può uscire
dai confini definiti dalla propria grammatica.

La prima versione accetta soltanto:

- i campi `risk`, `confidence` e `observations`;
- confronti `>=` collegati da `and`;
- una regione e una metrica;
- azioni dichiarate reversibili;
- un budget per un periodo espresso in ore o giorni;
- una finestra di contestazione;
- pausa del custode e contestazione comunitaria obbligatorie;
- divieto delle azioni irreversibili.

Questi limiti sono una caratteristica di sicurezza. Se introducessimo subito
funzioni arbitrarie, rete, cicli e accesso diretto ai dispositivi, TerraLex
perderebbe la proprietà che lo rende controllabile.

### Da quali idee eredita TerraLex

TerraLex non è un fork di Python e non utilizza il suo interprete. Il prototipo è
implementato in TypeScript con un parser dedicato.

Eredita concetti da famiglie differenti:

- da Python prende l'obiettivo della leggibilità;
- da C e JavaScript prende parentesi graffe, stringhe, operatori e punto e
  virgola;
- dai linguaggi dichiarativi prende l'idea di descrivere il risultato ammesso,
  non tutti i passaggi per ottenerlo;
- dal policy-as-code prende parole come `allow`, `require` e `forbid`;
- dalla programmazione funzionale prende il principio secondo cui gli stessi
  input devono produrre lo stesso output;
- dagli smart contract prende versioni, limiti espliciti, hash e verificabilità;
- dal linguaggio giuridico prende autorizzazioni, obblighi, divieti e diritto di
  contestazione.

Il suo elemento originale non è una singola parola della sintassi. È la
combinazione fra regola ambientale, prova firmata, limite economico, diritto di
contestazione e verifica blockchain.

### Il nome TerraLex è provvisorio

Un controllo preliminare sul Web mostra che `TerraLex` è già utilizzato da una
[rete internazionale di studi legali](https://www.terralex.org/). Questo non è
un parere legale né una ricerca completa sui marchi, ma rende necessario trattare
`TerraLex` come nome interno di lavoro.

Prima di creare sito, logo, società o registrazione pubblica bisogna:

1. proporre nomi alternativi;
2. controllare domini e profili social;
3. eseguire una ricerca professionale sui marchi nelle classi pertinenti;
4. scegliere il nome definitivo soltanto dopo tale verifica.

Nella prima comunicazione pubblica è preferibile parlare di **linguaggio
sperimentale per policy ambientali**, senza presentare TerraLex come marchio
definitivo.

## Che cosa abbiamo costruito

### 1. Il linguaggio TerraLex

Esistono il parser, il compilatore, il valutatore e un comando per controllare e
compilare le politiche. La politica del Delta del Po è un esempio funzionante.

### 2. Il protocollo dei dati firmati

Il progetto definisce il formato delle osservazioni e delle valutazioni. I
sensori utilizzano firme Ed25519; il sistema controlla firma, identità e numero
progressivo della misurazione.

### 3. Il servizio Oracle

È il servizio che riceve i dati, verifica le firme, conserva le osservazioni,
calcola il rischio e applica TerraLex. Espone un'API, cioè una porta controllata
attraverso la quale altri sistemi possono comunicare con Virdacora.

In questo MVP il modello è intenzionalmente semplice e deterministico. Non c'è
un modello linguistico che decide liberamente lungo il percorso di esecuzione.

### 4. Il database

PostgreSQL conserva tre categorie principali:

- sensori registrati;
- osservazioni ricevute;
- valutazioni prodotte.

### 5. Gli smart contract

Sono presenti contratti per:

- registrare prove ambientali confermate da più Oracle indipendenti;
- registrare e attivare le politiche TerraLex;
- rappresentare le credenziali della comunità e della camera dei giovani;
- creare, contestare, votare ed eseguire proposte;
- custodire e rilasciare fondi secondo le regole;
- creare il token sperimentale ENV.

### 6. L'ambiente Docker

Docker permette di avviare Oracle e PostgreSQL nello stesso modo su computer
diversi. Lo stack locale è configurato e dispone di controlli automatici di
salute.

### 7. Test e dimostrazione completa

Il progetto contiene 16 test automatici. Verificano, tra le altre cose, quorum
degli Oracle, limiti di budget, contestazioni, voto a due camere, pause di
emergenza e impossibilità per amministratori o possessori di token di prelevare
liberamente dalla tesoreria.

Esiste inoltre una dimostrazione end-to-end: genera osservazioni firmate,
produce una valutazione, applica TerraLex, registra la prova, crea una proposta
e simula il rilascio di fondi su una blockchain locale.

## Che cosa non abbiamo ancora costruito

È essenziale non confondere l'MVP con un servizio pubblico completo. Oggi non
abbiamo ancora:

- una rete di sensori ambientali reali;
- una validazione scientifica del modello per uno specifico ecosistema;
- tre o più Oracle gestiti da organizzazioni realmente indipendenti;
- un'identità civica pronta per iscrivere comunità e giovani;
- un'interfaccia grafica per cittadini e responsabili del progetto;
- un deployment permanente su una rete blockchain pubblica;
- denaro reale nella tesoreria;
- un collegamento con pompe, droni, paratie, dosatori o altri attuatori;
- un audit indipendente degli smart contract;
- una struttura legale, fiscale e di protezione dei dati;
- un piano economico approvato per il token ENV;
- meccanismi completi per revoca dei sensori, privacy del voto e ricorsi sulle
  credenziali civiche.

Questi punti non sono dettagli: sono condizioni necessarie prima di dichiarare
Virdacora operativo nel mondo reale.

## Come è distribuito il potere

Virdacora separa deliberatamente capacità diverse.

### L'AI e gli Oracle

Possono analizzare dati, produrre prove e proporre un'azione. Non possono votare,
inventare un destinatario, superare il budget o prelevare dalla tesoreria.

### La comunità coinvolta

Può contestare un'azione automatica e partecipa alle decisioni che richiedono un
voto. Le credenziali devono esistere prima della proposta, così non si possono
creare nuovi votanti opportunistici durante una votazione.

### La camera dei giovani

Rappresenta gli interessi di chi vivrà più a lungo con le conseguenze della
decisione. Le azioni irreversibili richiedono l'approvazione sia della comunità
sia dei giovani.

### Il custode di emergenza

Può imporre una sola pausa pubblica e temporanea a una proposta, motivandola. Non
possiede un veto permanente.

### La tesoreria

Rilascia fondi soltanto quando riceve un ordine valido dal contratto di
governance. Non contiene una funzione con cui un amministratore possa svuotarla.

### I possessori di ENV

Non ricevono potere di voto ambientale solo perché possiedono token.

## I tre livelli di autonomia

### Livello 1: osservare e avvisare

Può essere automatizzato. Il sistema raccoglie dati, calcola valutazioni e
pubblica allerte, mantenendo traccia delle fonti.

### Livello 2: proporre azioni reversibili

Può essere automatizzato entro una politica già approvata, un budget rigido e
una finestra di contestazione. Esempi: nuovi campionamenti o una sperimentazione
limitata e arrestabile.

### Livello 3: azioni irreversibili o ad alto impatto

Non può essere eseguito autonomamente. Richiede entrambe le camere e, in un
progetto reale, autorizzazioni scientifiche, tecniche e legali esterne alla
blockchain.

## Che ruolo ha la blockchain

La blockchain non conserva tutti i dati ambientali e non esegue il modello AI.
Viene usata come registro condiviso per ciò che deve essere difficile da
nascondere o modificare:

- impronta delle prove;
- versione della politica;
- conferme degli Oracle;
- proposte e contestazioni;
- voti;
- limiti e movimenti della tesoreria.

I dati completi e i modelli rimangono fuori dalla blockchain. In produzione
dovranno essere replicati in più archivi, con le loro impronte pubblicate nel
registro. Questa scelta riduce costi e dipendenza da una singola piattaforma.

## Che ruolo ha il token ENV

Il contratto ENV esiste come prototipo tecnico: è un token con quantità massima
prestabilita e autorizzazioni firmabili. Non esiste ancora una tokenomics, una
vendita, una promessa di rendimento o una funzione economica completa.

La tesoreria degli interventi usa nell'MVP un asset stabile separato, simile a
USDC. ENV non governa i voti ambientali e non deve essere presentato oggi come
investimento.

Prima di emettere o vendere ENV servono almeno:

1. una funzione concreta che non sia puramente speculativa;
2. un modello di entrate, costi e domanda verificabile;
3. regole pubbliche di emissione e allocazione;
4. analisi legale e fiscale nelle giurisdizioni coinvolte;
5. audit del contratto e gestione sicura delle chiavi;
6. comunicazione trasparente dei rischi, senza promesse finanziarie.

Una prima sperimentazione deve utilizzare token di test privi di valore.

## Come provarlo oggi senza modificare il codice

Il responsabile non tecnico può chiedere a un tecnico di eseguire questa breve
procedura davanti a lui.

1. Aprire Docker Desktop.
2. Aprire PowerShell nella cartella del progetto.
3. Avviare i servizi:

```powershell
docker compose up -d --build
```

4. Aprire nel browser:

```text
http://localhost:8877/healthz
```

Il risultato corretto contiene:

```json
{
  "status": "ok",
  "policyHash": "0x16fcda4dd4e94a5493f0ebbc756d40ed37095a44ea69d0a691c230610196a114"
}
```

`status: ok` significa che il servizio risponde. `policyHash` è l'impronta della
politica attiva, non una valutazione della qualità ambientale.

5. Per fermare i servizi senza cancellare il database:

```powershell
docker compose stop
```

## Dimostrazioni da chiedere al responsabile tecnico

### Dimostrazione dei dati e della regola

```powershell
pnpm demo
```

Deve mostrare una valutazione ambientale, l'impronta della prova, la decisione
TerraLex e l'eventuale bozza di azione reversibile.

### Test dell'intero progetto

```powershell
pnpm test
```

Il risultato atteso è che tutti i 16 test siano superati.

### Simulazione completa fino alla tesoreria

```powershell
pnpm e2e
```

Questa prova deve terminare con una proposta eseguita e un trasferimento
simulato. Non utilizza fondi reali.

## Chi deve partecipare al progetto

Un pilot credibile richiede ruoli distinti.

| Ruolo | Responsabilità principale |
| --- | --- |
| Responsabile del progetto | Tiene obiettivo, budget, calendario, rischi e decisioni aperte |
| Responsabile scientifico | Valida metriche, sensori, soglie, modello e significato dei risultati |
| Facilitatore della comunità | Definisce chi è coinvolto e rende accessibili contestazioni e decisioni |
| Rappresentanza dei giovani | Costruisce la seconda camera senza dipendere dalla prima |
| Responsabile tecnico | Gestisce software, integrazioni, ambienti e qualità del servizio |
| Operatori Oracle | Eseguono copie indipendenti del modello e attestano le prove |
| Auditor di sicurezza | Verifica smart contract, chiavi, infrastruttura e scenari di attacco |
| Responsabili della tesoreria | Custodiscono il multisig e riconciliano ogni movimento |
| Consulente legale e privacy | Valuta token, dati, responsabilità e autorizzazioni territoriali |
| Custodi di emergenza | Gestiscono pause motivate e incidenti senza avere potere permanente |

Una sola persona non dovrebbe controllare contemporaneamente Oracle,
credenziali civiche, tesoreria e pausa di emergenza.

## Piano operativo dei primi 90 giorni

### Giorni 1-30: scegliere un problema piccolo e verificabile

Il responsabile del progetto deve:

1. scegliere una sola area geografica;
2. scegliere una sola metrica ambientale;
3. identificare un intervento realmente reversibile;
4. nominare un responsabile scientifico e un referente della comunità;
5. descrivere chi può subire benefici e danni;
6. definire tre risultati misurabili del pilot;
7. stabilire condizioni che impongono lo stop;
8. censire fonti di dati, proprietari, licenze e qualità storica;
9. tradurre la politica TerraLex in una pagina di linguaggio comune;
10. approvare un budget del pilot che non richieda token pubblici.

Il risultato di questa fase è un documento di mandato, non un deployment.

### Giorni 31-60: preparare il pilot tecnico e sociale

Il gruppo deve:

1. collegare dati reali in sola lettura;
2. qualificare e registrare i sensori;
3. far eseguire l'Oracle ad almeno tre organizzazioni separate;
4. predisporre una rete blockchain di test;
5. simulare iscrizione, contestazione e voto delle due camere;
6. approvare soglie, budget e destinatari ammessi;
7. definire revoca delle chiavi e risposta agli incidenti;
8. pubblicare politica, modello, limiti e conflitti di interesse;
9. predisporre una semplice interfaccia per leggere dati e proposte;
10. incaricare una revisione tecnica indipendente.

In questa fase il sistema osserva e simula, ma non sposta fondi reali.

### Giorni 61-90: lavorare in modalità ombra

La modalità ombra significa che Virdacora produce valutazioni e proposte, ma le
decisioni reali continuano a essere prese fuori dal sistema.

Il gruppo deve:

1. confrontare previsioni e dati realmente osservati;
2. misurare falsi allarmi e mancate segnalazioni;
3. far esaminare ogni proposta a comunità e scienziati;
4. simulare sensore compromesso, Oracle assente e politica errata;
5. provare pausa, contestazione e recupero delle chiavi;
6. pubblicare un rapporto con risultati e fallimenti;
7. decidere se fermare, correggere o avanzare al pilot testnet.

Il passaggio successivo richiede una decisione formale e documentata.

## Criteri per dire sì o no al pilot successivo

Si può considerare un pilot con responsabilità maggiore soltanto quando:

- la qualità dei dati è stata validata da un soggetto indipendente;
- le soglie TerraLex hanno una motivazione scientifica documentata;
- comunità e giovani comprendono come contestare e votare;
- almeno tre Oracle indipendenti producono lo stesso risultato;
- smart contract e infrastruttura hanno superato audit;
- esistono multisig, timelock, piano incidenti e procedura di migrazione;
- il modello ha limiti ed errori pubblicati;
- responsabilità legali e autorizzazioni sono chiare;
- nessun partecipante può controllare da solo dati, decisione e fondi;
- una prova completa di arresto è riuscita.

Se manca uno di questi elementi, il sistema deve restare in osservazione o
modalità ombra.

## Che cosa controllare durante il funzionamento

Il responsabile del progetto non deve leggere il codice, ma deve ricevere un
rapporto regolare che risponda a queste domande:

1. Quali sensori sono attivi, scaduti, revocati o anomali?
2. Quante osservazioni sono state accettate e rifiutate, e perché?
3. Quale versione del modello e quale hash TerraLex sono attivi?
4. Gli Oracle indipendenti concordano oppure stanno divergendo?
5. Quali proposte sono aperte, contestate, sospese o eseguite?
6. Quanto budget è stato impegnato e trasferito in ogni periodo?
7. Chi ha ricevuto fondi e quale prova autorizzava il pagamento?
8. Ci sono incidenti, conflitti di interesse o tentativi di manipolazione?
9. Come stanno cambiando falsi allarmi e mancate segnalazioni?
10. La comunità riesce concretamente a partecipare?

## Cosa fare in caso di incidente

Se un dato, una chiave, una politica o una proposta sembra compromessa:

1. sospendere nuove azioni e non collegare attuatori;
2. disattivare pubblicamente la politica interessata;
3. utilizzare la pausa prevista, indicando motivo e durata;
4. conservare log, firme, hash e cronologia senza riscriverli;
5. informare comunità, responsabile scientifico, sicurezza e tesoreria;
6. revocare o sostituire le credenziali compromesse;
7. chiedere una verifica indipendente;
8. pubblicare causa, impatto, rimedio e condizioni di riavvio;
9. riattivare soltanto dopo una nuova approvazione documentata.

La blockchain rende visibili molte azioni, ma non sostituisce responsabilità,
comunicazione e procedure di emergenza.

## Documenti che il responsabile deve custodire

Per ogni pilot devono esistere e rimanere reperibili:

- mandato e obiettivi;
- mappa delle comunità coinvolte;
- fonti e licenze dei dati;
- schede di calibrazione dei sensori;
- versione e limiti del modello;
- politica TerraLex e traduzione in linguaggio comune;
- verbali di approvazione delle due camere;
- registro dei conflitti di interesse;
- budget, destinatari e riconciliazione dei pagamenti;
- audit e test di sicurezza;
- registro degli incidenti;
- rapporto finale, inclusi risultati negativi.

## Indicatori di successo

Il successo non è il prezzo di ENV. Un pilot deve essere valutato almeno su:

- copertura e continuità dei dati;
- capacità di individuare un rischio utile in anticipo;
- tasso di falsi allarmi e mancate segnalazioni;
- tempo tra prova verificata e decisione;
- percentuale di decisioni realmente comprensibili alla comunità;
- partecipazione e accessibilità delle contestazioni;
- tracciabilità completa dei fondi;
- assenza di azioni oltre politica e budget;
- capacità di fermare e ripristinare il sistema;
- effetto ambientale misurato dell'eventuale intervento.

## Checklist di presa in consegna

Il nuovo responsabile può considerare ricevuto il progetto quando sa indicare:

- [ ] il problema ambientale che Virdacora vuole affrontare;
- [ ] la differenza tra osservazione, valutazione, proposta ed esecuzione;
- [ ] dove si trova la politica TerraLex attiva;
- [ ] chi controlla dati, Oracle, comunità, tesoreria e pausa;
- [ ] quali azioni sono reversibili e quali sono vietate;
- [ ] quali limiti di budget sono attivi;
- [ ] come una comunità può contestare una proposta;
- [ ] che cosa deve approvare la camera dei giovani;
- [ ] che ENV non attribuisce voto ambientale;
- [ ] come verificare lo stato del servizio;
- [ ] come fermare i servizi locali;
- [ ] quali gate impediscono l'uso di fondi o attuatori reali;
- [ ] chi viene contattato in caso di incidente;
- [ ] quali risultati determinano continuazione o chiusura del pilot.

## Dove trovare i materiali

- `README.md`: ingresso rapido al repository.
- `policies/po-water-v1.terra`: politica TerraLex di esempio.
- `docs/architecture.md`: architettura tecnica.
- `docs/invariants.md`: regole che il sistema non deve violare.
- `docs/threat-model.md`: rischi, difese attuali e lavoro ancora necessario.
- `docs/api.md`: interfaccia del servizio Oracle.
- `docs/deployment.md`: avvio locale e condizioni per la produzione.
- `packages/terralex`: implementazione del linguaggio.
- `packages/contracts`: smart contract e relativi test.
- `services/oracle`: servizio dati, valutazione e API.

## Prima pubblicazione su LinkedIn

### Perché pubblichiamo

La prima pubblicazione non serve a vendere token, raccogliere capitale o
dichiarare concluso il progetto. Serve a verificare se il problema viene
compreso e se emergono persone capaci di migliorarlo.

Le risposte che cerchiamo sono soprattutto:

- obiezioni scientifiche;
- esperienze di comunità esposte a rischi ambientali;
- disponibilità di dati reali;
- persone che gestiscono sensori o monitoraggio;
- competenze su governance, blockchain, AI, cloud e sicurezza;
- disponibilità a partecipare a un piccolo pilot in modalità ombra.

Il post può accompagnare il [logo completo](docs/assets/virdacora-logo-v1.png).
Il testo deve rendere comprensibili lo scopo, la prova effettuata e il contributo
richiesto, senza promesse economiche.

### Affermazioni che possiamo sostenere

Nel post possiamo dire che:

- esiste un MVP locale funzionante;
- è stato creato un linguaggio sperimentale per policy ambientali;
- osservazioni firmate possono alimentare una valutazione riproducibile;
- smart contract locali applicano quorum, budget e governance;
- esistono test riproducibili e dimostrazioni locali; i risultati dipendono dal ramo e dal commit verificati;
- il sistema non è collegato a sensori, fondi o attuatori reali;
- stiamo cercando critica e possibili partner per un pilot.

### Affermazioni da non fare

Non dobbiamo ancora dire che:

- il sistema prevede correttamente crisi ambientali reali;
- il modello è stato validato scientificamente;
- il progetto è approvato da ARPAE, enti pubblici o comunità;
- Virdacora è già decentralizzato o resistente a ogni censura;
- gli smart contract sono sicuri per fondi reali;
- ENV è un investimento oppure avrà un determinato valore;
- esiste già un pilot ufficiale nel Delta del Po;
- TerraLex è un nome registrato o disponibile;
- il progetto controlla autonomamente dispositivi fisici.

### Testo pronto per la prima pubblicazione

Bozza aggiornata al nuovo nome. La versione inglese e i canali suggeriti sono
in [LINKEDIN_POST_IT_EN.md](docs/LINKEDIN_POST_IT_EN.md). Non è ancora una prova
di pubblicazione su LinkedIn.

```text
Chi controlla i dati ambientali può influenzare il racconto di un territorio.
Chi vive lì deve poter controllare le prove.

Sto costruendo Virdacora.
Le prove dell’ambiente, la voce delle comunità.

L'obiettivo è collegare osservazioni ambientali, analisi verificabili e decisioni
delle comunità: sapere da dove arriva un dato, come viene interpretato e chi
può decidere un eventuale intervento.

Abbiamo già una demo riproducibile su dati reali USGS: il prototipo scopre una
stazione in un catalogo configurato, conserva le misure e registra le prove su
una blockchain locale. Abbiamo provato anche dati alterati e un primo
attestatore malevolo: tre identità concordi possono registrare la busta corretta
senza farsi bloccare dalla prima attestazione falsa.

Il progetto tiene al centro due regole: l'AI propone, le comunità mantengono
diritti decisionali; il token non compra il voto ambientale. Vogliamo inoltre
costruire un modello che riconosca il lavoro di chi porta dati, sensori e
competenze e produca benefici per le comunità.

È un prototipo di ricerca. I test sono locali, non una rete di operatori
indipendenti. Non abbiamo ancora dimostrato previsioni affidabili sul campo,
resistenza generale alla censura o miglioramenti ecologici.

Cerco persone con cui verificare il prossimo passo: idrologia, dati ambientali,
sensori, sistemi distribuiti, sicurezza e governance delle comunità.
Anche una critica ben motivata, una fonte dati o una prova della demo è utile.

Codice, guide e prove: https://github.com/atlas-devlab/virdacora
Per le demo più recenti: ramo feat/autonomous-source-evidence.
Chi vuole contribuire può aprire una proposta o scrivermi per un primo compito.

Qual è il dato ambientale che vorresti poter verificare nel tuo territorio?

#ClimateTech #EnvironmentalData #OpenScience #CommunityGovernance
```

### Controllo prima di premere Pubblica

Prima della pubblicazione verificare:

- [ ] il testo dice "nome di lavoro" e non presenta il nome come marchio;
- [ ] non contiene il collegamento locale `localhost`, che fuori dal computer
  non funziona;
- [ ] non contiene chiavi, token API, indirizzi personali o dati riservati;
- [ ] non promette rendimenti, vendita o valore futuro di ENV;
- [ ] non attribuisce collaborazioni a organizzazioni che non hanno aderito;
- [ ] non usa immagini o loghi di cui non possediamo i diritti;
- [ ] non presenta la simulazione del Delta del Po come pilot già avviato;
- [ ] il profilo LinkedIn descrive correttamente il ruolo del promotore;
- [ ] è possibile dedicare tempo alle risposte nei due giorni successivi.

### Che cosa può succedere dopo la pubblicazione

Il numero di reazioni non determina il valore del progetto. Gli scenari più
probabili sono:

1. **Poche reazioni.** È normale per un primo post. Si esamina se messaggio e
   rete di contatti sono coerenti, senza cambiare subito il progetto.
2. **Curiosità generica.** Si ringrazia e si chiede quale parte interessa, senza
   trasformare ogni commento in una collaborazione.
3. **Obiezioni tecniche o scientifiche.** Sono il risultato più utile. Si
   registrano, si chiede una fonte e si aggiorna il progetto quando la critica è
   fondata.
4. **Contatto territoriale.** Si propone una breve conversazione esplorativa,
   chiarendo che non esiste ancora un pilot ufficiale.
5. **Richiesta di investimento o token.** Si risponde che non è aperta alcuna
   raccolta e che l'economia di ENV non è stata definita.
6. **Timore verso AI o blockchain.** Si spiega il confine: AI fuori dalla
   tesoreria, azioni reversibili limitate, possibilità di contestazione e nessun
   attuatore fisico.
7. **Richiesta del codice.** Si indica [atlas-devlab/virdacora](https://github.com/atlas-devlab/virdacora),
   pubblico, e si propone un primo contributo concreto. Le
   condizioni sono in [LICENSE_POLICY.md](LICENSE_POLICY.md); il progetto resta
   un prototipo di ricerca.

### Come rispondere ai commenti

Risposta a una critica scientifica:

```text
Grazie, è esattamente il tipo di verifica che sto cercando. Le soglie attuali
sono dimostrative e non ancora validate sul campo. Se puoi indicarmi dati o
letteratura pertinenti, li inserirò nella valutazione del pilot.
```

Risposta a chi considera inutile la blockchain:

```text
È un'obiezione importante. Nel prototipo la blockchain non conserva tutti i
dati e non esegue l'AI: registra soltanto hash delle prove, regole, contestazioni,
voti e movimenti della tesoreria. Il pilot dovrà dimostrare se questo registro
condiviso produce un vantaggio reale rispetto a soluzioni più semplici.
```

Risposta a chi domanda come investire:

```text
In questa fase non è aperta alcuna raccolta e il token non viene proposto come
investimento. La priorità è validare problema, dati, governance e sicurezza con
un pilot senza valore economico reale.
```

Risposta a un possibile partner:

```text
Grazie. Sto cercando proprio esperienza su dati ambientali, territorio e
validazione. Possiamo fare una breve conversazione esplorativa per capire quali
dati o competenze potresti mettere a disposizione, senza impegni commerciali in
questa fase.
```

### Registro delle risposte

Per sette giorni mantenere una tabella semplice:

| Data | Persona e ruolo | Tipo di risposta | Informazione utile | Prossima azione | Stato |
| --- | --- | --- | --- | --- | --- |
|  |  | critica / dati / territorio / tecnica / token |  | rispondere / chiamata / studiare / nessuna | aperto / chiuso |

Registrare soltanto informazioni professionali pertinenti e rese pubbliche o
fornite volontariamente. Non raccogliere dati personali non necessari.

### Valutazione dopo sette giorni

Dopo una settimana rispondere per iscritto a queste domande:

1. Quali parti dell'idea sono state comprese subito?
2. Quali parole hanno creato confusione?
3. Sono emerse obiezioni che invalidano una nostra ipotesi?
4. Abbiamo ricevuto dati, fonti o casi reali?
5. Si è presentato almeno un esperto scientifico credibile?
6. Si è presentato almeno un contatto legato a un territorio?
7. L'interesse riguarda il problema ambientale oppure soltanto AI, blockchain e
   token?
8. Qual è la prossima prova più piccola che possiamo fare?

Il risultato della pubblicazione non deve essere "molti like". Deve essere una
lista più precisa di ipotesi, rischi, persone e dati da verificare.

## La decisione da prendere adesso

Il progetto non ha bisogno, come prima mossa, di una vendita di token o di
un'attuazione fisica. Ha bisogno di un **pilot ambientale piccolo, misurabile e in
modalità ombra**, con una comunità reale disposta a partecipare e un partner
scientifico disposto a validare dati e soglie.

La prima decisione del responsabile è leggere questa guida, pubblicare il primo
messaggio come richiesta di confronto e osservare le risposte per sette giorni.
In parallelo deve scegliere il caso d'uso pilota e formare il gruppo minimo di
responsabilità. Tutto il resto, inclusi blockchain, AI e token, deve servire
quella prova e non sostituirla.
