# Virdacora: primo incarico territoriale completo / First complete territorial job

## Italiano — protocollo prima della prova

**Obiettivo:** consegnare una revisione riproducibile di dati ambientali reali,
con decisione delle camere comunità e giovani, controllo della consegna e
compenso simulato. Questo incarico attua un modulo della missione Virdacora:
osservazioni → prove verificabili → decisione comunitaria → lavoro controllabile.

### Fonte e incarico

Riutilizziamo, senza nuove acquisizioni, l'archivio USGS di ossigeno disciolto
del Willamette a Portland, stazione `USGS-14211720`, dal primo al quindici agosto
2025. Sono osservazioni storiche reali; non sono dati in tempo reale. Il codice,
il dataset e la regola di incarico provengono dal ramo di ricerca conservato nel
commit `0deeb4e46673b28cad598c2e6c6afdebcebfdac8`. Questa integrazione separata
usa come base il refactor Oracle `5dd7a0fe8ef978c96b3bee97377dcbacd142217f`;
non integra automaticamente le PR da cui dipende e non modifica i vecchi rami.

Il lavoro è `DATA_REVIEW`: controllare il campione fissato, riportare la misura
all'istante di verifica, riprodurre gli errori del modello e dell'ultima misura,
e dichiarare i limiti. Origine, intervallo, target a un'ora, policy e hash sono
quelli del caso già definito; non scegliamo un esempio in base a un errore
favorevole. Il modello numerico rimane identico. La soglia dimostrativa non è
uno standard ecologico o legale.

Il budget è **10 TEST senza valore**, distribuiti esclusivamente sulla rete
locale effimera Hardhat. Dopo approvazione civica il budget va nell'escrow;
il revisore del dato non riceve il pagamento anticipato. Il compenso remunera
una revisione completa e riproducibile anche quando il modello sbaglia.
L'incarico corrente non aggiunge una quota monetaria comunitaria: le comunità
mantengono decisione, revisione e contestazione; eventuali ripartizioni economiche
richiedono termini separati espliciti.

### Criteri di successo e scenari

1. **Integrità e provenienza:** leggere i byte originali, verificare manifest,
   hash, stazione, serie, unità, qualità e istanti; conservare esclusioni e limiti.
   La firma di importazione è locale, non una firma del sensore USGS.
2. **Impegno prima della consegna:** fissare caso, fonte, policy, importo,
   destinatario, revisori e risultato atteso come formato/controlli, non come
   valore ambientale desiderato. Le modifiche richiedono un incarico distinto.
3. **Decisione civica:** aprire la contestazione e dimostrare che il solo voto
   favorevole comunitario non consente l'esecuzione; occorre anche la camera
   giovani. Un voto contrario non deve essere aggirato nella prova.
4. **Consegna valida:** ciascun revisore ricarica separatamente i file originali,
   ricostruisce il caso, controlla il riferimento finanziato e l'hash effettivamente
   consegnato. Solo due approvazioni del medesimo risultato consentono il pagamento.
5. **Dati alterati:** modificare soltanto copie temporanee, mantenendo l'ancora
   originale. Il cambiamento dei byte deve fallire. Una misura falsificata con
   errori e hash ricalcolati deve comunque fallire contro l'archivio finanziato.
   Nessuna approvazione della consegna, nessun pagamento al consegnatario;
   rifiuto da un revisore e rimborso completo alla tesoreria simulata.
6. **Consegna insufficiente:** omettere elementi essenziali del risultato e
   ricalcolarne l'hash. Il controllo deve rifiutarla, l'escrow deve restare
   bloccato e il rimborso restituire l'intero budget. Un hash coerente non rende
   completa una consegna incompleta.
7. **Tracce verificabili:** salvare termini, candidato, controlli, stati civici,
   saldi e ricevute di transazione dei tre percorsi. Verificare i motivi di
   rifiuto attesi, senza considerare un qualunque errore come test superato.
   Il saldo positivo finale è 10 TEST al consegnatario; nei due casi rifiutati
   è zero, con 10 TEST restituiti alla tesoreria e zero residui nell'escrow.

Un referto che documenta onestamente una discrepanza può essere remunerabile
se l'incarico lo prevede prima. Questo incarico richiede invece la riproduzione
del preciso archivio concordato: non cambiamo la regola dopo una consegna fallita.

### Confini della dimostrazione

I dati sono reali; identità, camere, revisori, orologio della catena e compensi
sono simulati. Tre firme locali su quattro verificano il certificato del bridge,
non un nuovo cluster Open Autonomy. Non sono stati incaricati residenti,
operatori sul campo o revisori indipendenti. Non sono dimostrati calibrazione
fisica, verità della fonte iniziale, sicurezza dell'acqua o miglioramento ecologico.

Il contratto di escrow tratta hash e ruoli: la verifica della consegna avviene
nel percorso dei revisori. Due revisori collusi potrebbero approvare una falsità;
questa prova non elimina quel confine di fiducia. Non modifica contratti esistenti,
governance, ENV, modelli, fondi reali o dati firmati. Nessun LLM, servizio a
pagamento, acquisto, wallet reale o pubblicazione sulla rete pubblica è necessario.

Fonti primarie: i riferimenti esatti e gli hash sono in
`docs/datasets/usgs-willamette/manifest.json`; i byte delle risposte sono negli
altri due file della medesima cartella. La provenienza USGS e la data di cattura
rimangono dichiarazioni dell'archivio, non nuove attestazioni del produttore.

## English — protocol before execution

This bounded `DATA_REVIEW` job reuses the pinned real historical USGS dissolved
oxygen archive for Willamette station `USGS-14211720`, August 2025. It tests the
original Virdacora path: observations, verifiable evidence, community and youth
decisions, checked delivery and simulated compensation. No new observations or
forecast training are performed. The existing first origin/target and unchanged
model are retained; favourable prediction accuracy is never a payment condition.

The local ephemeral Hardhat budget is ten valueless TEST units. Civic approval
funds escrow, not the worker directly. Community-only approval must fail before
youth approval. Two separately invoked reviewers freshly load the original
archive, reproduce the full committed case and delivery, and bind them to funded
on-chain terms and the submitted result hash before approving the same result.

There are three isolated settlement scenarios: complete valid delivery is paid;
source/result alteration is detected and refunded; incomplete delivery is
rejected and refunded. Negative candidates may recompute their own hashes:
hash consistency alone is not acceptance. Both failed deliveries receive zero;
the full ten units return to treasury with no escrow remainder. Store original
terms, candidates, explicit rejection reasons, civic stages, balances and actual
local transaction receipts. Raw fixtures must remain unchanged.

Signatures authenticate the local importer, not USGS sensors. Local roles do not
establish independently operated people or affected residents. The bridge uses
a three-of-four signer fixture, not an ABCI cluster. The escrow enforces hash,
role and payment rules; scientific/document completeness is checked off-chain.
Colluding authorized reviewers remain a trust boundary. This is not fieldwork,
water-safety certification, environmental improvement or public deployment.
No real funds, paid API, model pivot or production governance change occurs.
Community monetary allocation is not added to this job; any later allocation
requires separately agreed terms. The funded task cannot be redefined after an
invalid delivery to make it payable.
