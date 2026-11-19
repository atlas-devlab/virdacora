// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@terravoce/protocol";
import { describe, expect, it } from "vitest";
import { prepareCase } from "./case.js";
import { loadDataset } from "./dataset.js";
import { verifyImportedTerritorialBundle } from "./imported-review.js";

const source = new URL("../../../docs/datasets/usgs-willamette/", import.meta.url);
const evidence = new URL("../../../docs/evidence/territorial-job/", import.meta.url);
const policy = new URL("../../../policies/usgs-data-review-v1.terra", import.meta.url);
const caseHash = "0x3cee978fda3fd8e84c92e2b0a94dec7bdb5fe0c64560c4b13e8e3babd4414f84";
const scenarioNames = ["positive", "altered_delivery", "insufficient_delivery"] as const;
const commitmentDocument = JSON.stringify({
  schema: "virdacora-territorial-commitments-v1",
  mode: "local-simulation",
  fundedCaseHash: caseHash,
  submittedResultHashes: {
    positive: "0x68aba721f7c3c0933aa20c8a1849d64189dc41fd419d40f434cb19444fee90bc",
    altered_delivery: "0xdd036ba8669d2eaffa8dcfda59326a8ba1308dc0de044ccad5c36f8d0537e149",
    insufficient_delivery: "0x850f2342846007e18718f97c8ea726f3671d932367bb8f44bb7ebe77a34266f5",
  },
});
const anchor = sha256Hex(commitmentDocument);

async function withBundle(run: (bundle: string) => Promise<void>) {
  const bundle = await mkdtemp(join(tmpdir(), "virdacora-imported-review-"));
  const files = new Map<string, string | Uint8Array>();
  const folders: string[] = [];
  try {
    for (const relative of ["source", "simulation", ...scenarioNames.map(name => `simulation/${name}`)]) {
      const folder = join(bundle, relative);
      await mkdir(folder);
      folders.push(folder);
    }
    for (const name of ["continuous.json", "station.json", "manifest.json"]) {
      files.set(join(bundle, "source", name), await readFile(new URL(name, source)));
    }
    files.set(join(bundle, "source", "policy.terra"), await readFile(policy));
    files.set(join(bundle, "simulation", "case.json"), await readFile(new URL("case.json", evidence)));
    files.set(join(bundle, "simulation", "commitments.json"), commitmentDocument);
    for (const scenario of scenarioNames) {
      files.set(join(bundle, "simulation", scenario, "candidate.json"),
        await readFile(new URL(`${scenario}/candidate.json`, evidence)));
    }
    for (const [path, data] of files) await writeFile(path, data, { flag: "wx" });
    await run(bundle);
  } finally {
    for (const path of files.keys()) {
      await unlink(path).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    for (const folder of folders.reverse()) await rmdir(folder);
    await rmdir(bundle);
  }
}

describe("offline verification of a supplied territorial bundle", () => {
  it("checks all three delivery commitments and reproduces the archived result", async () => {
    await withBundle(async bundle => {
      const report = await verifyImportedTerritorialBundle(bundle, anchor);
      expect(report).toMatchObject({
        verified: true, commitmentsSha256: anchor, fundedCaseHash: caseHash, mode: "local-simulation",
        source: { stationId: "USGS-14211720" }, target: { observedMgL: 8.2, persistenceMgL: 8.4 },
        evaluation: { evaluatedPairs: 335 },
      });
      expect(report.scenarios.map(({ reason }) => reason)).toEqual([
        null, "DELIVERY_NOT_REPRODUCED", "DELIVERY_NOT_REPRODUCED",
      ]);
    });
  });

  it("requires the hashes of the original commitment file bytes", async () => {
    await withBundle(async bundle => {
      await writeFile(join(bundle, "simulation", "commitments.json"), commitmentDocument + "\n");
      await expect(verifyImportedTerritorialBundle(bundle, anchor)).rejects.toThrow(/supplied anchor/);
      await expect(verifyImportedTerritorialBundle(bundle, "")).rejects.toThrow(/independently retained/);
    });
  });

  it("rejects a different source with a coherently updated manifest and case", async () => {
    await withBundle(async bundle => {
      const sourceFolder = join(bundle, "source");
      const rawFile = join(sourceFolder, "continuous.json");
      const manifestFile = join(sourceFolder, "manifest.json");
      const changedRaw = (await readFile(rawFile, "utf8")) + "\n";
      const changedManifest = { ...JSON.parse(await readFile(manifestFile, "utf8")), sourceHash: sha256Hex(changedRaw) };
      await writeFile(rawFile, changedRaw);
      await writeFile(manifestFile, JSON.stringify(changedManifest));
      const changedCase = prepareCase(await loadDataset(sourceFolder), await readFile(policy, "utf8"));
      expect(changedCase.caseHash).not.toEqual(caseHash);
      await writeFile(join(bundle, "simulation", "case.json"), JSON.stringify(changedCase));
      await expect(verifyImportedTerritorialBundle(bundle, anchor)).rejects.toThrow(/funded commitment/);
    });
  });

  it("rejects a different candidate instead of counting a commitment error as the expected rejection", async () => {
    await withBundle(async bundle => {
      await writeFile(join(bundle, "simulation", "altered_delivery", "candidate.json"),
        await readFile(new URL("positive/candidate.json", evidence)));
      await expect(verifyImportedTerritorialBundle(bundle, anchor)).rejects.toMatchObject({
        code: "RESULT_COMMITMENT_MISMATCH",
      });
    });
  });
});
