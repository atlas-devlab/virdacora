// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { ArchivedTerritorialReview } from "./archived-review.js";

const concentration = new Intl.NumberFormat("it-IT", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const count = new Intl.NumberFormat("it-IT");

const scenarios = {
  positive: "Consegna riprodotta",
  altered_delivery: "Misura alterata",
  insufficient_delivery: "Consegna incompleta",
} as const;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function utc(value: string): string {
  const label = value.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(label)}</time>`;
}

export function renderArchivedTerritorialReview(report: ArchivedTerritorialReview): string {
  const { source, evaluation } = report;
  const review = report.case;
  const maeLimit = Math.max(evaluation.linear.maeMgL, evaluation.persistence.maeMgL, 0.01);
  const maeConclusion = evaluation.persistence.maeMgL < evaluation.linear.maeMgL
    ? "La persistenza ha l’errore assoluto medio più basso in questa finestra."
    : evaluation.linear.maeMgL < evaluation.persistence.maeMgL
      ? "Il modello lineare ha l’errore assoluto medio più basso in questa finestra."
      : "I due metodi hanno lo stesso errore assoluto medio in questa finestra.";
  const evaluationRows = [
    { title: "Modello lineare", metrics: evaluation.linear },
    { title: "Persistenza", metrics: evaluation.persistence },
  ].map(({ title, metrics }) => `
    <tr>
      <th scope="row">${title}</th>
      <td><div class="mae"><meter min="0" max="${escapeHtml(maeLimit)}" value="${escapeHtml(metrics.maeMgL)}"
        aria-label="MAE per ${title.toLowerCase()} in mg/L"></meter><span>${concentration.format(metrics.maeMgL)}</span></div></td>
      <td>${concentration.format(metrics.rmseMgL)}</td>
      <td>${count.format(metrics.falseAlerts)}</td>
      <td>${count.format(metrics.missedLowOxygen)}</td>
    </tr>`).join("");

  const outcomeItems = report.scenarios.map(({ id, outcome, reason }) => `
    <li>
      <h3>${scenarios[id]}</h3>
      <strong class="${outcome === "verified" ? "verified" : "rejected"}">${outcome === "verified" ? "Verificata" : "Respinta"}</strong>
      ${reason === "DELIVERY_NOT_REPRODUCED" ? "<p>Riproduzione dei risultati fallita.</p>" : ""}
    </li>`).join("");

  const pairRows = evaluation.rows.map((row) => `
    <tr>
      <td>${utc(row.origin)}</td>
      <td>${utc(row.target)}</td>
      <td>${concentration.format(row.actual)}</td>
      <td>${concentration.format(row.linear)}</td>
      <td>${concentration.format(row.persistence)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="color-scheme" content="light">
  <title>Virdacora | Revisione delle prove ambientali</title>
  <style>
    :root {
      color: #172e27;
      background: #f3f3ec;
      font-family: system-ui, sans-serif;
      line-height: 1.55;
      --ink: #172e27;
      --muted: #455951;
      --surface: #fffefa;
      --line: #d5ded6;
      --green: #295744;
      --amber: #7a381f;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(100% - 2rem, 72rem); margin: clamp(1rem, 5vw, 3.5rem) auto; }
    h1, h2, h3, p { margin: 0; }
    h1, h2 { text-wrap: balance; }
    h1 { font: 400 clamp(2.15rem, 6vw, 4.3rem)/1.05 Georgia, serif; max-width: 18ch; }
    h2 { font-size: clamp(1.3rem, 3vw, 1.65rem); line-height: 1.2; }
    h3 { font-size: 1rem; }
    .hero { padding: clamp(1.5rem, 5vw, 4rem); color: #fcfcf3; background: #173b2f; border-radius: 1.1rem; }
    .brand { margin-bottom: 1.2rem; font-weight: 750; }
    .hero p:last-child { margin-top: 0.85rem; max-width: 50ch; color: #e1eadd; }
    .grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 1rem; margin-top: 1rem; }
    .panel { padding: clamp(1rem, 3vw, 1.75rem); background: var(--surface); border: 1px solid var(--line); border-radius: 0.85rem; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .intro { margin: 0.5rem 0 1rem; color: var(--muted); }
    .numbers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.7rem; margin: 1rem 0; }
    .numbers div, .outcomes li { padding: 0.8rem; border: 1px solid var(--line); border-radius: 0.6rem; }
    .numbers dt { font-size: 0.88rem; color: var(--muted); }
    .numbers dd { margin: 0.2rem 0 0; font-size: clamp(1.2rem, 3vw, 1.7rem); font-weight: 720; }
    .numbers small { display: block; font-size: 0.82rem; font-weight: 550; }
    .facts { display: grid; gap: 0.6rem; margin: 1rem 0 0; }
    .facts div { min-width: 0; }
    .facts dt { font-weight: 650; }
    .facts dd { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
    .provenance .facts { grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
    code { font-size: 0.9em; overflow-wrap: anywhere; }
    .scroll { overflow-x: auto; margin: 0.65rem 0; }
    .scroll:focus-visible, summary:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
    table { border-collapse: collapse; min-width: 100%; font-variant-numeric: tabular-nums; }
    caption { font-size: 0.88rem; text-align: left; margin: 0.25rem 0; color: var(--muted); }
    th, td { padding: 0.65rem 0.55rem; border-bottom: 1px solid var(--line); text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    th { font-weight: 650; }
    tbody tr:last-child > * { border-bottom: 0; }
    .mae { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; }
    meter { width: 4.2rem; min-width: 2.8rem; accent-color: var(--green); }
    meter::-webkit-meter-optimum-value { background: var(--green); }
    meter::-moz-meter-bar { background: var(--green); }
    .calculation { font-size: 0.88rem; color: var(--muted); margin-top: 0.7rem; }
    .outcomes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.65rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .outcomes p { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; }
    .verified, .rejected { display: inline-block; margin-top: 0.35rem; font-size: 0.92rem; }
    .verified { color: var(--green); }
    .rejected { color: var(--amber); }
    details { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--line); }
    summary { cursor: pointer; font-weight: 650; width: fit-content; }
    .pairs { max-height: 31rem; overflow: auto; }
    .pairs th { background: var(--surface); }
    .pairs thead { position: sticky; top: 0; }
    .pairs time { white-space: nowrap; }
    .footnote { margin: 1.1rem 0; color: var(--muted); font-size: 0.9rem; }
    @media (max-width: 48rem) {
      .grid { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: 32rem) {
      .numbers, .outcomes { grid-template-columns: minmax(0, 1fr); }
      .benchmark th, .benchmark td { font-size: 0.82rem; padding-inline: 0.3rem; }
      .benchmark meter { display: none; }
    }
    @media print {
      main { width: 100%; margin: 0; }
      .hero { background: #fff; color: var(--ink); padding: 0 0 1rem; }
      .hero p:last-child { color: var(--muted); }
      .panel { break-inside: avoid; }
      .pairs { max-height: none; }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <p class="brand">Virdacora</p>
      <h1>Revisione delle prove ambientali</h1>
      <p>Ossigeno disciolto nella stazione ${escapeHtml(source.stationId)}. Analisi riprodotta da osservazioni storiche USGS.</p>
    </header>

    <div class="grid">
      <section class="panel" aria-labelledby="evaluation">
        <h2 id="evaluation">Modello e baseline</h2>
        <p class="intro">${count.format(evaluation.assessedPairs)} previsioni valutate dal ${utc(evaluation.startUtc)}.
          Orizzonte di ${count.format(evaluation.horizonSeconds / 60)} minuti, con ${count.format(evaluation.windowSize)} osservazioni per finestra.
          La baseline di persistenza usa l’ultima misura disponibile.</p>
        <div class="scroll" role="region" aria-label="Confronto delle prestazioni" tabindex="0">
          <table class="benchmark">
            <caption>Errore assoluto medio (MAE) e radice dell’errore quadratico medio (RMSE), entrambi in mg/L.</caption>
            <thead><tr><th scope="col">Metodo</th><th scope="col">MAE</th><th scope="col">RMSE</th><th scope="col">Falsi allarmi</th><th scope="col">Eventi mancati</th></tr></thead>
            <tbody>${evaluationRows}</tbody>
          </table>
        </div>
        <p class="calculation"><strong>${maeConclusion}</strong></p>
        <p class="calculation">Soglia illustrativa di ${concentration.format(evaluation.illustrativeThresholdMgL)} mg/L.
          Nelle coppie valutate, il numero di misure sotto soglia è ${count.format(evaluation.observedLowOxygenEvents)}.
          ${evaluation.observedLowOxygenEvents === 0 ? "Per valutare la capacità di rilevare questi episodi serve un campione che li contenga." : ""}</p>
        <p class="calculation">Analisi retrospettiva su misure acquisite dall’archivio USGS dopo il periodo osservato.</p>
        <details>
          <summary>Coppie valutate</summary>
          <div class="scroll pairs" role="region" aria-label="Coppie di previsione" tabindex="0">
            <table>
              <caption>Misura e previsioni in mg/L. Orari in UTC.</caption>
              <thead><tr><th scope="col">Origine</th><th scope="col">Target</th><th scope="col">Misura</th><th scope="col">Modello</th><th scope="col">Persistenza</th></tr></thead>
              <tbody>${pairRows}</tbody>
            </table>
          </div>
        </details>
      </section>

      <section class="panel" aria-labelledby="coverage">
        <h2 id="coverage">Copertura dell’archivio</h2>
        <dl class="facts">
          <div><dt>Periodo della fonte</dt><dd>${utc(source.start)} – ${utc(source.end)}</dd></div>
          <div><dt>Osservazioni accettate</dt><dd>${count.format(evaluation.acceptedObservations)} su ${count.format(evaluation.sourceObservations)}</dd></div>
          <div><dt>Filtro di approvazione USGS</dt><dd>Misure approvate senza qualificatori <small lang="en">(${escapeHtml(source.approvalFilter)})</small></dd></div>
          <div><dt>Osservazioni escluse</dt><dd>${count.format(evaluation.excludedObservations)}</dd></div>
          <div><dt>Intervalli mancanti</dt><dd>${count.format(evaluation.missingIntervals)}</dd></div>
          <div><dt>Coppie saltate</dt><dd>${count.format(evaluation.skippedPairs)}</dd></div>
        </dl>
      </section>

      <section class="panel wide" aria-labelledby="target">
        <h2 id="target">Misura del caso territoriale</h2>
        <p class="intro">Origine della previsione ${utc(review.originUtc)}. Misura di riferimento ${utc(review.targetUtc)}.</p>
        <dl class="numbers">
          <div><dt>Misura osservata</dt><dd>${concentration.format(review.observedMgL)} <small>mg/L</small></dd></div>
          <div><dt>Modello lineare</dt><dd>${concentration.format(review.linearMgL)} <small>mg/L</small></dd></div>
          <div><dt>Persistenza</dt><dd>${concentration.format(review.persistenceMgL)} <small>mg/L</small></dd></div>
        </dl>
        <p class="calculation">Su questa misura l’errore assoluto del modello è ${concentration.format(review.linearErrorMgL)} mg/L.
          L’errore della persistenza è ${concentration.format(review.persistenceErrorMgL)} mg/L.</p>
      </section>

      <section class="panel wide" aria-labelledby="simulation">
        <h2 id="simulation">Consegne nella simulazione locale</h2>
        <p class="intro">Partecipanti, revisori e fondi fanno parte della simulazione. La prova riguarda una revisione di dati.</p>
        <ul class="outcomes">${outcomeItems}</ul>
      </section>

      <section class="panel wide provenance" aria-labelledby="provenance">
        <h2 id="provenance">Fonte e impronte di verifica</h2>
        <dl class="facts">
          <div><dt>Serie USGS</dt><dd><code>${escapeHtml(source.timeSeriesId)}</code></dd></div>
          <div><dt>Parametro e unità</dt><dd><code>${escapeHtml(source.parameterCode)}</code> · ${escapeHtml(source.unit)}</dd></div>
          <div><dt>Acquisizione dell’archivio</dt><dd>${utc(source.retrievedAt)}</dd></div>
          <div><dt>Termini della fonte</dt><dd>${escapeHtml(source.license)}</dd></div>
          <div><dt>Origine delle misure</dt><dd><code>${escapeHtml(source.sourceUrl)}</code></dd></div>
          <div><dt>Origine dei metadati della stazione</dt><dd><code>${escapeHtml(source.stationUrl)}</code></dd></div>
          <div><dt>SHA-256 delle misure archiviate</dt><dd><code>${escapeHtml(source.sourceHash)}</code></dd></div>
          <div><dt>SHA-256 dei metadati della stazione</dt><dd><code>${escapeHtml(source.stationHash)}</code></dd></div>
          <div><dt>Revisione Git della prova archiviata</dt><dd><code>${escapeHtml(source.referenceRevision)}</code></dd></div>
          <div><dt>Record della misura</dt><dd><code>${escapeHtml(review.targetRecordId)}</code></dd></div>
          <div><dt>Versione del modello</dt><dd><code>${escapeHtml(review.modelVersion)}</code></dd></div>
          <div><dt>Impronta del caso</dt><dd><code>${escapeHtml(review.caseHash)}</code></dd></div>
          <div><dt>Impronta del risultato</dt><dd><code>${escapeHtml(review.resultHash)}</code></dd></div>
          <div><dt>Impronta della policy</dt><dd><code>${escapeHtml(review.policyHash)}</code></dd></div>
        </dl>
      </section>
    </div>
    <p class="footnote">Gli hash riguardano i contenuti archiviati. La verifica che questo report documenta riguarda il calcolo riprodotto e la simulazione locale. Un giudizio sulla qualità ecologica richiede evidenze di campo.</p>
  </main>
</body>
</html>
`;
}
