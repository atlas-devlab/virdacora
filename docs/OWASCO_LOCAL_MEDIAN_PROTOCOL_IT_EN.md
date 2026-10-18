# Owasco: protocollo della regressione locale LAD / Local LAD protocol

**Stato: protocollo preparato; nessun nuovo modello addestrato e nessuna nuova
previsione ambientale calcolata.** Il contratto leggibile dalla macchina è
[protocol.json](datasets/owasco-local-median/protocol.json). La ricevuta del
[preflight](evidence/owasco-local-median/preflight.json) riguarda soltanto hash,
date e identificativi degli archivi.

## Italiano

### La domanda e il cambiamento proposto

Vogliamo sapere se una regressione che impara sul lago Owasco e minimizza
l'errore assoluto riesce a prevedere l'ossigeno fra un'ora meglio dell'ultima
misura invariata. La MAE rimane il criterio principale: è la media delle
distanze fra previsione e misura successiva, in mg/L. Più piccola è, meglio è.

La vecchia regressione è stata addestrata sul Willamette con un obiettivo
quadratico. Rimane conservata insieme ai risultati negativi dei filtri già
provati. La nuova candidata sarebbe un modello distinto: regressione lineare
LAD, detta anche regressione della mediana condizionale o quantile 0,5, senza
penalità sui coefficienti. Minimizza la **media degli errori assoluti**, non
la mediana degli errori. Cambiamo insieme luogo di addestramento e funzione
di errore: questo esperimento valuta la ricetta complessiva, senza poter
attribuire un eventuale beneficio a una sola delle due modifiche.

### Un esempio semplice, inventato

Immaginiamo cinque situazioni passate identiche per gli ingressi disponibili,
con variazioni dopo un'ora di `0, 0, 0, +0,1, +0,3 mg/L`. Un esempio con solo
intercetta minimizza l'errore assoluto prevedendo la mediana, cioè zero;
la media delle variazioni sarebbe invece `+0,08`. Se l'ossigeno ora è `8,0`,
questa previsione resta `8,0`: evita una correzione che molti precedenti
non sostengono.

Se le variazioni fossero `+0,1, +0,1, +0,2`, la mediana sarebbe `+0,1`:
prevederemmo `8,1`. Aiuta se la misura successiva è `8,1` (errore zero,
contro `0,1` della persistenza); sbaglia se è `8,0` (errore `0,1`, contro zero).
Sono esempi didattici sintetici, non risultati sul lago. Il modello reale usa
otto ingressi insieme, senza inventare gruppi di situazioni o soglie.
**LAD può favorire correzioni più prudenti, ma non garantisce meno correzioni
né una MAE migliore.** Potrebbe limitarsi a riprodurre la persistenza.

### La separazione dei dati, prima di imparare

| Archivio già disponibile | Righe | Uso fissato |
|---|---:|---|
| 1–29 luglio 2020 | 1.275 | Solo addestramento e calcolo delle scale |
| 1–29 agosto 2020 | 1.306 | Un solo controllo di sviluppo, dopo il congelamento |
| Settembre | — | Rimane chiuso |

Gli estremi sono finestre UTC, con ultimo target al 29 del mese alle 00:00.
Non rappresentano due mesi di calendario completi. La cadenza delle origini
accettate è di mezz'ora; i buchi originali restano tali. Non riempiamo serie
né scegliamo nuove righe.

Le storie terminano all'origine della previsione e il target è esattamente
un'ora dopo. L'ultimo target di luglio precede di 72 ore la prima osservazione
della storia di agosto. Il preflight controlla anche che non siano riutilizzati
fra i due archivi gli identificativi delle misure target.

**Agosto è già stato visto negli esperimenti precedenti.** Questa separazione
impedisce di addestrare su agosto, ma non lo trasforma in un test cieco o in
una validazione indipendente. Luglio, dopo l'addestramento, non può più essere
contato come prova fuori campione. La regola dei due mesi dei precedenti
filtri rimane parte della loro evidenza e non viene riscritta.

### La ricetta numerica da conservare

1. Usiamo gli stessi otto ingressi archiviati, nello stesso ordine: ossigeno
   attuale, variazioni a 30 minuti, 2 ore e 5 ore e mezza, seno/coseno dell'ora
   UTC, temperatura attuale e sua variazione a 2 ore. Non aggiungiamo meteo,
   portata o attività umane in questo esperimento.
2. Impariamo l'incremento `ossigeno fra un'ora − ossigeno ora`. La previsione
   sarà `ultima misura + incremento stimato`. Medie e scale delle feature si
   calcoleranno soltanto su luglio. Una feature esattamente costante avrà
   colonna e coefficiente zero anche in agosto; nessuna soglia “quasi costante”.
3. Risolviamo un problema lineare LAD con intercetta libera, pesi uguali per
   tutte le righe e nessuna penalità. Il JSON fissa formulazione, ordine,
   ambiente e opzioni del solver SciPy `highs-ds`. I coefficienti devono avere
   limiti espliciti liberi: quelli predefiniti di `linprog` sono nonnegativi.
4. Prima del fit futuro occorreranno implementazione, test sintetici,
   verifica dei confini e commit del codice. Un solo fit su luglio produrrà
   scale, maschera, coefficienti, diagnostica e ricevuta dell'ambiente. Questi
   byte saranno congelati prima di calcolare una previsione su agosto.
5. Nessun nuovo filtro, soglia, arrotondamento, clipping o ripiego automatico
   sull'ultima misura. Un fallimento del solver blocca la candidata; non si
   provano altri metodi finché uno dà un risultato migliore.

LAD può avere più soluzioni ottime. Il solver e l'ambiente fissati rendono
esplicita la procedura, senza dimostrare unicità matematica dei coefficienti
o refit identici su ogni computer. Il futuro artefatto congelato definirà
la candidata da valutare. Le tolleranze numeriche sono nel JSON.

### Come decideremo su agosto

Confrontiamo tutte e sole le 1.306 righe con `P = ultima misura`:

`guadagno = MAE(P) − MAE(candidata)`.

Il controllo passa soltanto se tutte le previsioni sono finite e nonnegative
e il guadagno è maggiore di `0,000000001 mg/L`. Questa piccola tolleranza
separa il confronto numerico dalla parità; **non è significatività statistica,
accuratezza del sensore o beneficio ecologico**. Non è stata adottata una
soglia di miglioramento del 10%.

Una previsione negativa/non finita impedisce il successo: non eliminiamo la
riga né la sostituiamo con P. Se non è possibile calcolare la MAE completa,
il punteggio resta nullo e si riportano gli errori di validità. La MAE sul
training sarà solo diagnostica; un controllo che non superi la persistenza
su luglio oltre la tolleranza serve a rilevare errori dell'ottimizzazione.

Mostreremo anche tutti i giorni UTC, errore massimo, errore con segno,
correzioni effettuate e casi che aiutano/peggiorano, senza selezionare giorni
favorevoli. I conteggi e le somme dovranno ricomporre il totale. Gli esempi
saranno il primo caso cronologico utile e dannoso, senza usarli per scegliere
una nuova regola.

Se fallisce o pareggia, fermiamo questa candidata e discutiamo. Se passa,
avremo soltanto un guadagno di sviluppo: nessuna promozione automatica.
Le origini sovrapposte sono correlate e un guadagno piccolo può essere fragile.
Una successiva verifica su dati non aperti richiederà un disegno distinto,
con incertezza e criteri fissati prima di accedere ai dati.

### Cosa fa oggi il codice di questa modifica

Il nuovo preflight usa soltanto la libreria standard: verifica i byte degli
input e di 53 file storici, proietta date/UUID e controlla split e conteggi.
Carica e decodifica gli archivi per l'integrità, ma non ispeziona né usa i valori
di ossigeno, target, feature, temperatura o previsioni. I test sintetici sono
costruiti anche senza quei campi. La lettura del JSON per l'integrità non
equivale a calcolare statistiche o addestrare.

Questa verifica non può ancora provare che un futuro programma di fit userà
solo luglio. Non ricostruisce indipendentemente la cronologia della temperatura;
la provenienza delle feature originali resta vincolata agli archivi conservati.
La futura implementazione dovrà verificare tali confini e la relativa evidenza.

I dati USGS finalizzati del 2020 riguardano una sola posizione e profondità.
Non dimostrano disponibilità in tempo reale, accuratezza fisica o capacità di
prevedere tutto il lago. I decimali pubblicati non certificano l'accuratezza;
valori uguali non provano che l'acqua fosse fisicamente immutata.

Virdacora mantiene l'obiettivo di produrre prove ambientali comprensibili e
verificabili al servizio delle comunità. Questo esperimento non cambia Oracle,
blockchain, consenso, fondi o diritti decisionali; il LLM non decide i risultati.

## English

### Question and synthetic example

We propose one separate local linear least-absolute-deviations model for
one-hour dissolved oxygen at Owasco. It would learn on July only and be
screened once on August, with full-cohort MAE against persistence as primary.
The historical Willamette ridge and previous failed filters remain unchanged.
LAD minimizes mean absolute residuals, not the median of absolute errors.
Local training and the loss both change, so their effects cannot be isolated.

In an intercept-only **invented** example, five identical-input cases with
future changes `0, 0, 0, +0.1, +0.3` have median zero and mean `+0.08`.
LAD can retain the latest reading. With changes `+0.1, +0.1, +0.2`, it predicts
`+0.1`: from `8.0`, predict `8.1`. This helps if the outcome is `8.1` and
hurts if it is `8.0`. The actual candidate uses all eight features; these
examples are not lake results or an implemented grouping rule. Fewer or
smaller corrections and improved MAE are hypotheses, not guarantees.

### Frozen design

- July 1–29, 2020: the exact 1,275 archived accepted rows for training and
  preprocessing only. August 1–29: the exact 1,306 rows for one development
  screen after model freeze. These are UTC windows, not full calendar months.
  September stays closed. Both opened archives are already development data.
- Use the eight archived features in their fixed order. Predict future minus
  present oxygen, then add the estimated delta to persistence. Feature means
  and population standard deviations come only from July. Exactly constant
  columns and their coefficients remain zero in both months.
- Pure linear LAD, free intercept and uniform weights, no coefficient penalty.
  The JSON fixes the LP, explicit free coefficient bounds, numerical checks,
  Python/NumPy/SciPy environment and `highs-ds` options. One attempt; a solver
  or integrity failure stops the candidate. No adaptive solver change.
- LAD coefficients need not be unique. Fixed settings do not establish
  mathematical uniqueness or cross-platform bitwise refitting. The exact future
  scaler/weights artifact, frozen before August prediction, is canonical.
- No direction gate, correction threshold, attenuation, clipping, rounding or
  fallback. No row deletion, interpolation, tuning or substitute month.

The later implementation must first pass synthetic and leakage checks and be
committed before fitting environmental data. Then one July-only fit produces
the model, training diagnostics and complete environment/hash receipt. Freeze
and push that artifact before any August candidate prediction. The present
change contains no fit or candidate-scoring implementation.

### Decision and limits

Primary gain is `MAE(persistence) − MAE(candidate)` over all August rows.
Development passes only with finite nonnegative predictions on every row and
gain strictly above `1e-9 mg/L`. This is a numerical tolerance, not statistical
significance, ecological usefulness, sensor accuracy or an adopted 10% target.
Invalid predictions prevent success; never omit rows or substitute persistence.
If the complete score is uncomputable, report null and the invalid records.

July MAE is in-sample diagnostics only. The zero-delta feasible solution gives
an optimization sanity check against persistence, not out-of-sample skill.
Report every August UTC day, maximum/signed error, exact changed-prediction
count and helps/ties/harms with fixed `1e-9` error-difference tolerance. All
partitions must recompose full-cohort errors and counts. Use first chronological
helpful/harmful cases for explanation only. Old R remains a descriptive
comparison, not an alternative primary baseline.

Failure/tie stops the candidate for discussion. Passing only supports further
development discussion. August was already examined, overlapping origins are
correlated, and no new bootstrap or p-value rescues the candidate. Separate
unopened verification would require its uncertainty plan before acquisition.

The current stdlib preflight checks bound file hashes, counts, history/target
timestamps and observation IDs only. The latest July target precedes the first
August history observation by 72 hours, with no reused target IDs. Legitimate
within-window gaps remain unchanged. Numeric observation/target/feature/output
fields are not accessed, and synthetic fixtures can omit them entirely.
The receipt cannot certify future training-code behavior, independently
reconstruct temperature chronology or prove as-of-origin data availability.

Finalized USGS 2020 observations at one near-surface site do not demonstrate
real-time or whole-lake forecasting, sensor accuracy or ecological causality.
Published precision is not physical accuracy; repeated values are not proof of
physical stability. Virdacora retains its community-serving evidence mission;
no operational Oracle, blockchain, consensus, governance or funds are changed.

## Reproduce the metadata-only check

From the repository root, Python standard library only:

```sh
python -m unittest discover -s scripts -p 'test_owasco_local_median_preflight.py'
python scripts/owasco_local_median_preflight.py \
  --protocol docs/datasets/owasco-local-median/protocol.json \
  --verify-report docs/evidence/owasco-local-median/preflight.json
```

The verify command is read-only. Creating the first receipt uses `--output`
and refuses to overwrite an existing file. Neither command trains a model or
computes candidate forecasts. Historical pipeline replays elsewhere in CI
remain separate from this new metadata-only check.

## Method references

- [SciPy: linear programming, explicit bounds and HiGHS dual simplex options](https://docs.scipy.org/doc/scipy/reference/optimize.linprog-highs-ds.html).
  This current reference describes the method; the future fit is pinned to the
  environment in the JSON and must check the installed implementation.
- [Scikit-learn: quantile regression](https://scikit-learn.org/stable/modules/linear_model.html#quantile-regression).
  Quantile 0.5 corresponds to absolute-error fitting. This protocol uses the
  direct SciPy LP, without an estimator's default coefficient penalty.
