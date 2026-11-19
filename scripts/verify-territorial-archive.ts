// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { parseArgs } from "node:util";
import { renderArchivedTerritorialReview } from "../services/environmental-case/src/archived-review-html.js";
import type { ArchivedTerritorialReview } from "../services/environmental-case/src/archived-review.js";

const usage = "Usage: pnpm --silent territorial:verify [--format json|html|csv]";

function renderCsv({ source, evaluation }: ArchivedTerritorialReview): string {
  const header = "station_id,time_series_id,parameter_code,source_sha256,unit,origin_utc,target_utc,observed_mg_l,linear_mg_l,persistence_mg_l";
  const prefix = [source.stationId, source.timeSeriesId, source.parameterCode, source.sourceHash, source.unit].join(",");
  const rows = evaluation.rows.map(row =>
    [prefix, row.origin, row.target, row.actual, row.linear, row.persistence].join(","),
  );
  return [header, ...rows].join("\n");
}

async function main(): Promise<void> {
  let format: string;
  try {
    const { values } = parseArgs({
      options: { format: { type: "string", default: "json" }, help: { type: "boolean" } },
    });
    if (values.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    format = values.format;
    if (format !== "json" && format !== "html" && format !== "csv") throw new Error("Invalid format");
  } catch {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const { reviewArchivedTerritorialCase } = await import("../services/environmental-case/src/archived-review.js");
    const report = await reviewArchivedTerritorialCase();
    const output = format === "html" ? renderArchivedTerritorialReview(report) :
      format === "csv" ? renderCsv(report) : JSON.stringify(report, null, 2);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    process.stderr.write(`Territorial archive review failed. ${message}\n`);
    process.exitCode = 1;
  }
}

await main();
