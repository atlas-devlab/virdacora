// SPDX-License-Identifier: AGPL-3.0-only
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { deliverResult, prepareCase, verifyResult } from "./case.js";
import { loadDataset } from "./dataset.js";
import { reviewTerritorialDelivery, TerritorialReviewError,
  type TerritorialDeliveryReviewInput } from "./territorial-review.js";

const folder = fileURLToPath(new URL("../../../docs/datasets/usgs-willamette/", import.meta.url));
const policySource = await readFile(new URL("../../../policies/usgs-data-review-v1.terra", import.meta.url), "utf8");
const sourceFiles = ["continuous.json", "station.json", "manifest.json"] as const;
const originalBytes = await Promise.all(sourceFiles.map(name => readFile(join(folder, name))));
const dataset = await loadDataset(folder);
const committedCase = prepareCase(dataset, policySource);
const delivered = deliverResult(dataset, committedCase);

function review(overrides: Partial<TerritorialDeliveryReviewInput> = {}) {
  return reviewTerritorialDelivery({ datasetFolder: folder, policySource, committedCase,
    fundedCaseHash: committedCase.caseHash, submittedResultHash: delivered.resultHash,
    candidate: delivered, ...overrides });
}

function recommit(value: Record<string, unknown>) {
  const { resultHash: _previousHash, ...core } = value;
  return { ...core, resultHash: sha256Hex(`environmental-result-v1:${canonicalJson(core)}`) };
}

async function withArchiveCopy(run: (copy: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "terravoce-territorial-review-"));
  try {
    const copy = join(temporary, "archive");
    await cp(folder, copy, { recursive: true });
    await run(copy);
  } finally {
    if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup target");
    await rm(temporary, { recursive: true, force: true });
  }
}

afterAll(async () => {
  const unchanged = await Promise.all(sourceFiles.map(name => readFile(join(folder, name))));
  expect(unchanged).toEqual(originalBytes);
});

describe("fresh territorial delivery review", () => {
  it("accepts the complete archived review even when the forecast loses to persistence", async () => {
    expect(delivered.absoluteErrorMgL).toBeGreaterThan(delivered.persistenceAbsoluteErrorMgL);
    expect(await review()).toEqual({ verified: true, archiveReloaded: true,
      caseHash: committedCase.caseHash, resultHash: delivered.resultHash,
      scope: "reproducibility against pinned USGS snapshot; not independent field review" });
    expect(delivered.ecologicalImprovementVerified).toBe(false);
  });

  it("reloads bytes on every review and rejects an altered archive with its original manifest", async () => {
    await withArchiveCopy(async copy => {
      expect((await review({ datasetFolder: copy })).verified).toBe(true);
      const path = join(copy, "continuous.json");
      const raw = await readFile(path, "utf8");
      await writeFile(path, raw + " ");
      await expect(review({ datasetFolder: copy })).rejects.toMatchObject({
        name: "TerritorialReviewError", code: "SOURCE_INTEGRITY_FAILED" });
      expect(await readFile(join(folder, "continuous.json"))).toEqual(originalBytes[0]);
    });
  });

  it("reports an unavailable archive as a typed integrity failure", async () => {
    await withArchiveCopy(async copy => {
      await rm(join(copy, "station.json"));
      const error = await review({ datasetFolder: copy }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(TerritorialReviewError);
      expect(error).toMatchObject({ code: "SOURCE_INTEGRITY_FAILED" });
    });
  });

  it("rejects a self-consistent forged target, its recalculated errors and its new hash", async () => {
    const executorDataset = structuredClone(dataset);
    executorDataset.measurements.find(row => row.time === committedCase.targetTime)!.value =
      committedCase.assessment.forecastValue;
    const forged = deliverResult(executorDataset, committedCase);
    // The normalized-object verifier alone cannot prove that the object came from its claimed archive.
    expect(verifyResult(executorDataset, policySource, committedCase, forged).verified).toBe(true);
    expect(forged.absoluteErrorMgL).toBe(0);
    await expect(review({ candidate: forged, submittedResultHash: forged.resultHash }))
      .rejects.toMatchObject({ code: "DELIVERY_NOT_REPRODUCED" });
  });

  it.each(["targetRecord", "persistenceMgL", "absoluteErrorMgL", "persistenceAbsoluteErrorMgL"])(
    "rejects an incomplete report missing %s even with a correct replacement hash", async field => {
      const incomplete: Record<string, unknown> = { ...delivered };
      delete incomplete[field];
      const candidate = recommit(incomplete);
      await expect(review({ candidate, submittedResultHash: candidate.resultHash }))
        .rejects.toMatchObject({ code: "DELIVERY_NOT_REPRODUCED" });
    });

  const falseClaims: Array<[string, Record<string, unknown>]> = [
    ["unit", { unit: "ug/L" }],
    ["approval", { approval: "Provisional" }],
    ["station", { stationId: "USGS-OTHER" }],
    ["series", { timeSeriesId: "other-series" }],
    ["target timestamp", { targetRecord: { ...delivered.targetRecord, time: committedCase.origin } }],
    ["ecological improvement", { ecologicalImprovementVerified: true }],
    ["physical action", { deliveredAction: "AERATION" }],
    ["safety certification", { environmentalSafetyCertified: true }],
    ["independent field review", { independentFieldReview: "performed" }]
  ];
  it.each(falseClaims)("rejects a rehashed false %s claim", async (_label, change) => {
    const candidate = recommit({ ...delivered, ...change });
    await expect(review({ candidate, submittedResultHash: candidate.resultHash }))
      .rejects.toMatchObject({ code: "DELIVERY_NOT_REPRODUCED" });
  });

  it("binds both the full case and the exact policy bytes to the funded anchor", async () => {
    await expect(review({ committedCase: { ...committedCase, requestedAmount: 100 } }))
      .rejects.toMatchObject({ code: "FUNDED_CASE_MISMATCH" });
    await expect(review({ policySource: policySource + "\n# Changed after funding\n" }))
      .rejects.toMatchObject({ code: "FUNDED_CASE_MISMATCH" });
  });

  it("rejects a replacement source, manifest, case and result against the original funded hash", async () => {
    await withArchiveCopy(async copy => {
      const sourcePath = join(copy, "continuous.json");
      const source = JSON.parse(await readFile(sourcePath, "utf8"));
      const target = source.features.find((row: { properties: { time: string } }) =>
        new Date(row.properties.time).toISOString() === committedCase.targetTime);
      target.properties.value = "7.4";
      const changedRaw = JSON.stringify(source);
      const manifestPath = join(copy, "manifest.json");
      const changedManifest = { ...JSON.parse(await readFile(manifestPath, "utf8")),
        sourceHash: sha256Hex(changedRaw) };
      await writeFile(sourcePath, changedRaw);
      await writeFile(manifestPath, JSON.stringify(changedManifest));
      const replacementDataset = await loadDataset(copy);
      const replacementCase = prepareCase(replacementDataset, policySource);
      const candidate = deliverResult(replacementDataset, replacementCase);
      expect(replacementCase.caseHash).not.toBe(committedCase.caseHash);
      await expect(review({ datasetFolder: copy, committedCase: replacementCase,
        candidate, submittedResultHash: candidate.resultHash }))
        .rejects.toMatchObject({ code: "FUNDED_CASE_MISMATCH" });
    });
  });

  it("does not complete a case whose committed archive has no exact follow-up target", async () => {
    await withArchiveCopy(async copy => {
      const sourcePath = join(copy, "continuous.json");
      const source = JSON.parse(await readFile(sourcePath, "utf8"));
      source.features = source.features.filter((row: { properties: { time: string } }) =>
        new Date(row.properties.time).toISOString() !== committedCase.targetTime);
      source.numberReturned = source.features.length;
      const raw = JSON.stringify(source);
      const manifestPath = join(copy, "manifest.json");
      const manifest = { ...JSON.parse(await readFile(manifestPath, "utf8")), sourceHash: sha256Hex(raw) };
      await writeFile(sourcePath, raw);
      await writeFile(manifestPath, JSON.stringify(manifest));
      const missingTargetCase = prepareCase(await loadDataset(copy), policySource);
      const candidate = recommit({ ...delivered, caseHash: missingTargetCase.caseHash, sourceHash: manifest.sourceHash });
      await expect(review({ datasetFolder: copy, committedCase: missingTargetCase,
        fundedCaseHash: missingTargetCase.caseHash, candidate, submittedResultHash: candidate.resultHash }))
        .rejects.toMatchObject({ code: "DELIVERY_NOT_REPRODUCED" });
    });
  });

  it("rejects a submitted hash that differs from the delivered report", async () => {
    await expect(review({ submittedResultHash: sha256Hex("another-submitted-result") }))
      .rejects.toMatchObject({ code: "RESULT_COMMITMENT_MISMATCH" });
  });

  it("rejects a body change without a matching recomputed result hash", async () => {
    await expect(review({ candidate: { ...delivered, absoluteErrorMgL: 0 } }))
      .rejects.toMatchObject({ code: "RESULT_COMMITMENT_MISMATCH" });
  });

  it.each([{ candidate: null }, { candidate: [] }, { candidate: "not a report" }])(
    "rejects a malformed result commitment: $candidate", async ({ candidate }) => {
    await expect(review({ candidate })).rejects.toMatchObject({ code: "RESULT_COMMITMENT_MISMATCH" });
    });
});
