// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { parseArgs } from "node:util";
import { readLocalSourceCsv, type StationWindow } from "../services/environmental-case/src/sources/source.js";
import { renderOxygenSourceCsv, renderOxygenSourceHtml } from "../services/environmental-case/src/sources/source-export.js";
import { fetchUsgsOxygen } from "../services/environmental-case/src/sources/usgs.js";
import { importWaterRangersOxygen } from "../services/environmental-case/src/sources/water-rangers.js";
import { fetchWqpOxygen } from "../services/environmental-case/src/sources/wqp.js";

const usage = [
  "Usage: pnpm --silent water:source --provider usgs|wqp --station <id> --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--format json|csv|html]",
  "       pnpm --silent water:source --provider water-rangers --csv <file> --dataset-url <url> --attribution <text> [--format json|csv|html]",
].join("\n");

type SourceArguments = { format: "json" | "csv" | "html" } & (
  { provider: "usgs" | "wqp"; query: StationWindow } |
  { provider: "water-rangers"; csv: string; datasetUrl: string; attribution: string }
);

function argumentsForSource(): SourceArguments | null {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, station: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    csv: { type: "string" }, "dataset-url": { type: "string" }, attribution: { type: "string" },
    format: { type: "string", default: "json" }, help: { type: "boolean" },
  } });
  if (values.help) return null;
  const { provider, station, start, end, csv, "dataset-url": datasetUrl, attribution, format } = values;
  if (format !== "json" && format !== "csv" && format !== "html") throw new Error("Unknown output format.");

  if ((provider === "usgs" || provider === "wqp") && station && start && end &&
      csv === undefined && datasetUrl === undefined && attribution === undefined) {
    return { provider, format, query: { stationId: station, start, end } };
  }
  if (provider === "water-rangers" && csv && datasetUrl && attribution &&
      station === undefined && start === undefined && end === undefined) {
    return { provider, format, csv, datasetUrl, attribution };
  }
  throw new Error("Choose one provider and its required arguments.");
}

async function main(): Promise<void> {
  let options;
  try {
    options = argumentsForSource();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments.";
    process.stderr.write(`${message}\n${usage}\n`);
    process.exitCode = 2;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  try {
    const batch = options.provider === "water-rangers"
      ? importWaterRangersOxygen({
        bytes: await readLocalSourceCsv(options.csv), datasetUrl: options.datasetUrl, attribution: options.attribution,
      })
      : await (options.provider === "usgs" ? fetchUsgsOxygen : fetchWqpOxygen)(options.query);
    const output = options.format === "csv" ? renderOxygenSourceCsv(batch)
      : options.format === "html" ? renderOxygenSourceHtml(batch) : JSON.stringify(batch, null, 2);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    process.stderr.write(`Oxygen source import failed. ${message}\n`);
    process.exitCode = 1;
  }
}

await main();
