// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyDiscreteTerritorialBundle } from "../services/environmental-case/src/discrete-bundle.js";
import { prepareDiscreteTerritorialCase } from "../services/environmental-case/src/discrete-territorial.js";
import { readLocalSourceCsv } from "../services/environmental-case/src/sources/source.js";
import { captureWqpOxygen } from "../services/environmental-case/src/sources/wqp.js";
import { runTerritorialSimulation } from "./run-territorial-simulation.js";

const usage = [
  "Usage: pnpm --silent territorial:discrete --provider wqp --station <id> --start <YYYY-MM-DD> --end <YYYY-MM-DD> --output <new-directory>",
  "       pnpm --silent territorial:discrete --provider water-rangers --station <site_id-or-location> --csv <file> --dataset-url <url> --attribution <text> --output <new-directory> [--record-url <public-observation-url> ...]",
].join("\n");

type Options = { stationId: string; output: string } & (
  { provider: "wqp"; start: string; end: string } |
  { provider: "water-rangers"; csv: string; datasetUrl: string; attribution: string; recordUrls: string[] }
);

function parseOptions(): Options | null {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, station: { type: "string" }, output: { type: "string" },
    start: { type: "string" }, end: { type: "string" }, csv: { type: "string" },
    "dataset-url": { type: "string" }, attribution: { type: "string" },
    "record-url": { type: "string", multiple: true }, help: { type: "boolean" },
  } });
  if (values.help) return null;
  const { provider, station, output, start, end, csv, "dataset-url": datasetUrl, attribution, "record-url": urls } = values;
  if (!station?.trim() || !output?.trim()) throw new Error("Choose a station and a new output directory.");
  const shared = { stationId: station, output: resolve(output) };
  if (provider === "wqp" && start && end && csv === undefined && datasetUrl === undefined && attribution === undefined && !urls) {
    return { ...shared, provider, start, end };
  }
  if (provider === "water-rangers" && csv && datasetUrl && attribution && start === undefined && end === undefined) {
    return { ...shared, provider, csv, datasetUrl, attribution, recordUrls: urls ?? [] };
  }
  throw new Error("Choose one provider and its required arguments.");
}

async function acquireSource(options: Options) {
  const common = { schema: "virdacora-discrete-oxygen-archive-v1", provider: options.provider, stationId: options.stationId };
  if (options.provider === "wqp") {
    const { start, end, stationId } = options;
    const { bytes, batch } = await captureWqpOxygen({ stationId, start, end });
    return { bytes, manifest: { ...common, start, end, capturedAt: batch.retrievedAt, rawSha256: batch.sourceSha256 } };
  }
  const { csv, datasetUrl, attribution, recordUrls } = options;
  const bytes = await readLocalSourceCsv(csv);
  return { bytes, manifest: {
    ...common, datasetUrl, attribution, capturedAt: new Date().toISOString(),
    rawSha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    ...(recordUrls.length ? { origin: "public-record-transcription", recordUrls } : { origin: "simple-table-export" }),
  } };
}

async function main(): Promise<void> {
  let options: Options | null;
  try {
    options = parseOptions();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n${usage}\n`);
    process.exitCode = 2;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  try {
    const { output } = options;
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    const { bytes, manifest } = await acquireSource(options);
    const { spec } = prepareDiscreteTerritorialCase(manifest, bytes);
    const sourceFolder = resolve(output, "source");
    await mkdir(sourceFolder);
    await writeFile(resolve(sourceFolder, "observations.csv"), bytes, { flag: "wx" });
    await writeFile(resolve(sourceFolder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const anchor = await runTerritorialSimulation(output, spec.caseHash, "discrete");
    const verification = await verifyDiscreteTerritorialBundle(output, anchor);
    const summary = { completed: true, commitmentsSha256: anchor, verification };
    await writeFile(resolve(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ ...summary, outputFolder: output }, null, 2)}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unexpected error.";
    process.stderr.write(`Discrete territorial run failed. ${reason}\n`);
    process.exitCode = 1;
  }
}

await main();
