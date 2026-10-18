import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { loadDataset, validateDataset } from "./dataset.js";
import { deliverResult, prepareCase, verifyResult } from "./case.js";
import { replay } from "./replay.js";
import { fetchBoundedUSGSJSON } from "./bounded-fetch.js";

const sourceFolder = resolve("../../docs/datasets/usgs-willamette");
const command = process.argv[2];
async function getUSGS(url: string) {
  return fetchBoundedUSGSJSON(url);
}
async function save(folder: string, name: string, data: unknown) {
  await mkdir(folder, { recursive: true });
  const path = resolve(folder, name), content = canonicalJson(data) + "\n";
  try { await writeFile(path, content, { flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(`Existing artifact differs: ${name}`);
  }
}
if (command === "fetch") {
  // A new capture is separate: upstream revisions must never overwrite the pinned experiment.
  const destination = process.argv[3];
  if (!destination || resolve(destination) === sourceFolder) throw new Error("Provide a new snapshot folder");
  const manifest = JSON.parse(await readFile(resolve(sourceFolder, "manifest.json"), "utf8"));
  const raw = await getUSGS(manifest.sourceUrl), station = await getUSGS(manifest.stationUrl);
  const updated = { ...manifest, retrievedAt: new Date().toISOString(),
    sourceHash: sha256Hex(raw), stationHash: sha256Hex(station) };
  validateDataset(raw, station, updated);
  const folder = resolve(destination);
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, "continuous.json"), raw, { flag: "wx" });
  await writeFile(resolve(folder, "station.json"), station, { flag: "wx" });
  await save(folder, "manifest.json", updated);
  console.log(JSON.stringify({ captured: folder, sourceHash: updated.sourceHash }));
} else if (command === "replay" || command === "verify" || command === "verify-live") {
  const folder = resolve(process.argv[3] ?? "../../outputs/real-case");
  const dataset = await loadDataset(sourceFolder);
  const policy = await readFile(resolve("../../policies/usgs-data-review-v1.terra"), "utf8");
  if (command === "replay") {
    const report = replay(dataset), spec = prepareCase(dataset, policy), result = deliverResult(dataset, spec);
    const verification = verifyResult(dataset, policy, spec, result);
    await save(folder, "replay.json", report);
    await save(folder, "case.json", spec);
    await save(folder, "result.json", result);
    await save(folder, "verification.json", verification);
    const { rows: _rows, ...summary } = report;
    console.log(JSON.stringify({ ...summary, verification, artifacts: folder }, null, 2));
  } else {
    const spec = JSON.parse(await readFile(resolve(folder, "case.json"), "utf8"));
    const candidate = JSON.parse(await readFile(resolve(folder, "result.json"), "utf8"));
    const local = verifyResult(dataset, policy, spec, candidate);
    if (command === "verify-live") {
      const raw = await getUSGS(dataset.manifest.sourceUrl), station = await getUSGS(dataset.manifest.stationUrl);
      const checkedAt = new Date().toISOString();
      const current = validateDataset(raw, station, { ...dataset.manifest, retrievedAt: checkedAt,
        sourceHash: sha256Hex(raw), stationHash: sha256Hex(station) });
      const requiredIds = new Set([...spec.sourceRecordIds, candidate.targetRecord.id]);
      const select = (items: typeof dataset.measurements) => items.filter((m) => requiredIds.has(m.id))
        .map(({ id, time, value }) => ({ id, time, value }));
      const pinned = select(dataset.measurements), latest = select(current.measurements);
      if (pinned.length !== requiredIds.size || canonicalJson(pinned) !== canonicalJson(latest)) {
        throw new Error("USGS source revision or missing/qualified measurements; independent review required");
      }
      const checked = { ...local, checkedAt, requiredApprovedMeasurements: pinned.length,
        upstreamValuesMatch: true, upstreamSourceHash: current.manifest.sourceHash,
        rawResponseChanged: current.manifest.sourceHash !== dataset.manifest.sourceHash,
        scope: "fresh HTTPS retrieval from the same USGS source; not an independent physical measurement" };
      const name = `upstream-${sha256Hex(canonicalJson(checked))}.json`;
      await save(folder, name, checked);
      console.log(JSON.stringify(checked, null, 2));
    } else console.log(JSON.stringify(local, null, 2));
  }
} else throw new Error("Use replay/verify/verify-live [output-folder], or fetch <new-folder>");
