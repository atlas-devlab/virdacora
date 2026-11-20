// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyDiscreteTerritorialBundle } from "../services/environmental-case/src/discrete-bundle.js";
import { discreteComparisonFiles, loadDiscreteTerritorialCase, prepareDiscreteTerritorialCase } from "../services/environmental-case/src/discrete-territorial.js";
import { readLocalSourceCsv } from "../services/environmental-case/src/sources/source.js";
import { captureWqpOxygen } from "../services/environmental-case/src/sources/wqp.js";
import { runTerritorialSimulation } from "./run-territorial-simulation.js";

const usage = [
  "Usage: pnpm --silent territorial:discrete --provider wqp --station <id> --start <YYYY-MM-DD> --end <YYYY-MM-DD> --output <new-directory>",
  "       pnpm --silent territorial:discrete --provider water-rangers --station <site_id-or-location> --csv <file> --dataset-url <url> --attribution <text> --output <new-directory> [--record-url <public-observation-url> ...]",
  "       pnpm --silent territorial:discrete --comparison <source-directory> --output <new-directory>",
].join("\n");

type ProviderOptions = { stationId: string; output: string } & (
  { provider: "wqp"; start: string; end: string } |
  { provider: "water-rangers"; csv: string; datasetUrl: string; attribution: string; recordUrls: string[] }
);
type Options = ProviderOptions | { comparison: string; output: string };

function parseOptions(): Options | null {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, station: { type: "string" }, output: { type: "string" },
    start: { type: "string" }, end: { type: "string" }, csv: { type: "string" },
    "dataset-url": { type: "string" }, attribution: { type: "string" },
    "record-url": { type: "string", multiple: true }, comparison: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) return null;
  const { comparison, provider, station, output, start, end, csv, "dataset-url": datasetUrl, attribution, "record-url": urls } = values;
  if (comparison?.trim() && output?.trim() &&
      [provider, station, start, end, csv, datasetUrl, attribution, urls].every(value => value === undefined)) {
    return { comparison: resolve(comparison), output: resolve(output) };
  }
  if (comparison !== undefined) throw new Error("Supply a comparison archive and an output folder.");
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

async function acquireSource(options: ProviderOptions) {
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

async function prepareSource(options: Options, sourceFolder: string) {
  await mkdir(sourceFolder);
  if ("comparison" in options) {
    const entries = await Promise.all(discreteComparisonFiles.map(async name =>
      [name, await readLocalSourceCsv(resolve(options.comparison, name))] as const));
    for (const [name, content] of entries) {
      await writeFile(resolve(sourceFolder, name), content, { flag: "wx" });
    }
    const { spec } = await loadDiscreteTerritorialCase(sourceFolder);
    if (spec.provider !== "comparison") throw new Error("Use a comparison source manifest.");
    return spec;
  }
  const { bytes, manifest } = await acquireSource(options);
  const { spec } = prepareDiscreteTerritorialCase(manifest, bytes);
  await writeFile(resolve(sourceFolder, "observations.csv"), bytes, { flag: "wx" });
  await writeFile(resolve(sourceFolder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return spec;
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
    const spec = await prepareSource(options, resolve(output, "source"));
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
