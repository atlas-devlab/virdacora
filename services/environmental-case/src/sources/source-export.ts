// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { OxygenSourceBatch } from "./source.js";

const providerNames = {
  usgs: "USGS Water Data",
  wqp: "Water Quality Portal",
  "water-rangers": "Water Rangers",
};

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const formula = typeof value === "string" && /^[\s\u200b\uFEFF]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text);
  return `"${formula ? "'" : ""}${text.replaceAll('"', '""')}"`;
}

export function renderOxygenSourceCsv(batch: OxygenSourceBatch): string {
  const columns = [
    "provider", "source_url", "source_sha256", "retrieved_at_utc", "terms_url", "attribution",
    "station_id", "station_name", "series_id", "activity_id", "record_id", "organization",
    "observed_at_utc", "reported_date", "reported_time", "reported_zone", "reported_value",
    "reported_unit", "oxygen_mg_l", "source_status", "source_qualifiers_json", "detection_condition",
  ];
  const provenance = [batch.provider, batch.sourceUrl, batch.sourceSha256, batch.retrievedAt, batch.termsUrl, batch.attribution];
  const rows = batch.readings.map(reading => [
    ...provenance, reading.stationId, reading.stationName, reading.seriesId, reading.activityId, reading.recordId,
    reading.organization, reading.observedAtUtc, reading.reportedTime?.date ?? null, reading.reportedTime?.time ?? null,
    reading.reportedTime?.zone ?? null, reading.valueText, reading.unit, reading.valueMgL, reading.status,
    JSON.stringify(reading.qualifiers), reading.detectionCondition,
  ].map(csvCell).join(","));
  return [columns.join(","), ...rows].join("\n");
}

function escapeHtml(value: string | number | null): string {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderOxygenSourceHtml(batch: OxygenSourceBatch): string {
  const visible = batch.readings.slice(0, 250);
  const rows = visible.map(reading => {
    const reported = [reading.reportedTime?.date, reading.reportedTime?.time, reading.reportedTime?.zone]
      .filter(Boolean).join(" ");
    const flags = [reading.status, ...reading.qualifiers, reading.detectionCondition].filter(Boolean).join(" · ");
    const rawValue = [reading.valueText, reading.unit].filter(Boolean).join(" ");
    const station = reading.stationName && reading.stationName !== reading.stationId
      ? `${escapeHtml(reading.stationName)}<br><span>${escapeHtml(reading.stationId)}</span>`
      : escapeHtml(reading.stationId);
    return `<tr><th scope="row">${station}</th><td>${escapeHtml(reading.observedAtUtc ?? (reported || null))}</td>
      <td>${escapeHtml(rawValue || null)}</td><td>${escapeHtml(reading.valueMgL)}</td>
      <td>${escapeHtml(flags || null)}</td>
      <td>${escapeHtml(reading.seriesId ?? reading.activityId ?? reading.recordId)}</td></tr>`;
  }).join("\n");
  const normalized = batch.readings.filter(reading => reading.valueMgL !== null).length;
  const readingCount = `${batch.readings.length} ${batch.readings.length === 1 ? "misura" : "misure"}`;
  const inputCount = `${batch.inputRows} ${batch.inputRows === 1 ? "riga di origine" : "righe di origine"}`;
  const valueCount = `${normalized} ${normalized === 1 ? "valore espresso" : "valori espressi"} in mg/L`;

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Virdacora · ${providerNames[batch.provider]}</title>
  <style>
    :root { color: #172e27; background: #f3f3ec; font: 16px/1.55 system-ui,sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 72rem; margin: clamp(1rem,5vw,3rem) auto; padding: 0 1rem; }
    header { background: #173b2f; color: #fffefa; border-radius: .9rem; padding: clamp(1.4rem,6vw,3.4rem); }
    header p, h1, h2 { margin: 0; }
    h1 { font: 400 clamp(2rem,6vw,3.5rem)/1.1 Georgia,serif; margin-top: .35rem; }
    section { background: #fffefa; border: 1px solid #d5ded6; border-radius: .9rem; margin-top: 1rem; padding: clamp(1rem,4vw,1.75rem); }
    dl { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,17rem),1fr)); gap: 1rem; }
    dt { font-weight: 650; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .scroll { overflow-x: auto; }
    .scroll:focus-visible { outline: 2px solid #295744; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: .7rem .55rem; border-bottom: 1px solid #d5ded6; vertical-align: top; }
    tr th span { color: #455951; font-weight: 400; }
    caption { text-align: left; color: #455951; padding-bottom: .5rem; }
    footer { color: #455951; margin-top: 1rem; }
  </style>
</head>
<body><main>
  <header><p>Virdacora</p><h1>Ossigeno disciolto</h1><p>${providerNames[batch.provider]}</p></header>
  <section><h2>Esito dell’importazione</h2><p>${readingCount} di ossigeno su ${inputCount}. ${valueCount}.</p>
    <p>L’orario conserva il riferimento del fornitore quando l’UTC è assente.</p>
    <div class="scroll" role="region" aria-label="Misure di ossigeno" tabindex="0"><table>
      <caption>${visible.length === batch.readings.length ? readingCount : `Prime ${visible.length} misure. JSON e CSV contengono l’intero risultato.`}</caption>
      <thead><tr><th scope="col">Stazione</th><th scope="col">Data e ora</th><th scope="col">Valore originale</th>
        <th scope="col">mg/L</th><th scope="col">Stato e qualificatori</th><th scope="col">Serie o riferimento del record</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>
  <section><h2>Provenienza</h2><dl>
    <div><dt>Fonte</dt><dd>${escapeHtml(batch.sourceUrl)}</dd></div>
    <div><dt>SHA-256 dei dati ricevuti o letti</dt><dd><code>${escapeHtml(batch.sourceSha256)}</code></dd></div>
    <div><dt>Acquisizione Virdacora</dt><dd>${escapeHtml(batch.retrievedAt)}</dd></div>
    <div><dt>Termini della fonte</dt><dd>${escapeHtml(batch.termsUrl)}</dd></div>
    <div><dt>Attribuzione</dt><dd>${escapeHtml(batch.attribution)}</dd></div>
  </dl></section>
  <footer>Gli stati e i qualificatori provengono dalle fonti. L’importazione è una consultazione dei dati pubblicati.</footer>
</main></body></html>`;
}
