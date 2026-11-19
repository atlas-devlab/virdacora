// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { z } from "zod";
import { deliverResult, prepareCase } from "./case.js";
import { loadDataset } from "./dataset.js";
import { replay } from "./replay.js";
import { reviewTerritorialDelivery, TerritorialReviewError } from "./territorial-review.js";

const scenarioNames = ["positive", "altered_delivery", "insufficient_delivery"] as const;
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const commitmentsSchema = z.strictObject({
  schema: z.literal("virdacora-territorial-commitments-v1"),
  mode: z.literal("local-simulation"),
  fundedCaseHash: hash,
  submittedResultHashes: z.strictObject({
    positive: hash,
    altered_delivery: hash,
    insufficient_delivery: hash,
  }),
});

function decodeJson(bytes: Uint8Array): unknown {
  const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return JSON.parse(json) as unknown;
}

export async function verifyImportedTerritorialBundle(bundleFolder: string, trustedCommitmentsSha256: string) {
  if (!hash.safeParse(trustedCommitmentsSha256).success) {
    throw new Error("Provide an independently retained SHA-256 commitment anchor (0x + 64 lowercase hex digits).");
  }
  if (!bundleFolder || bundleFolder === "-" || /^[/\\]{2}|^[a-z][a-z0-9+.-]*:\/\//i.test(bundleFolder)) {
    throw new Error("Provide a local territorial bundle directory.");
  }
  const datasetFolder = resolve(bundleFolder, "source");
  const simulation = resolve(bundleFolder, "simulation");
  const commitmentBytes = await readFile(resolve(simulation, "commitments.json"));
  if (sha256Hex(commitmentBytes) !== trustedCommitmentsSha256) {
    throw new Error("Commitments file does not match the supplied anchor.");
  }
  const commitments = commitmentsSchema.parse(decodeJson(commitmentBytes));

  const [dataset, policyBytes, archivedCaseBytes] = await Promise.all([
    loadDataset(datasetFolder),
    readFile(resolve(datasetFolder, "policy.terra")),
    readFile(resolve(simulation, "case.json")),
  ]);
  const policySource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(policyBytes);
  const committedCase = prepareCase(dataset, policySource);
  if (committedCase.caseHash !== commitments.fundedCaseHash ||
      canonicalJson(decodeJson(archivedCaseBytes)) !== canonicalJson(committedCase)) {
    throw new Error("The captured source, policy and recorded case do not reproduce the funded commitment.");
  }

  const scenarios = await Promise.all(scenarioNames.map(async scenario => {
    const candidate = decodeJson(await readFile(resolve(simulation, scenario, "candidate.json")));
    const submittedResultHash = commitments.submittedResultHashes[scenario];
    try {
      await reviewTerritorialDelivery({
        datasetFolder, policySource, committedCase,
        fundedCaseHash: commitments.fundedCaseHash, submittedResultHash, candidate,
      });
    } catch (error) {
      if (scenario !== "positive" && error instanceof TerritorialReviewError && error.code === "DELIVERY_NOT_REPRODUCED") {
        return { scenario, submittedResultHash, outcome: "rejected", reason: error.code } as const;
      }
      throw error;
    }
    if (scenario !== "positive") throw new Error(`Invalid territorial delivery reproduced: ${scenario}.`);
    return { scenario, submittedResultHash, outcome: "verified", reason: null } as const;
  }));

  const delivered = deliverResult(dataset, committedCase);
  const { rows: _rows, ...evaluation } = replay(dataset);
  return {
    schema: "virdacora-territorial-import-verification-v1",
    mode: commitments.mode,
    scope: "offline reproducibility of captured USGS observations against local-simulation commitments",
    verified: true,
    commitmentsSha256: trustedCommitmentsSha256,
    fundedCaseHash: commitments.fundedCaseHash,
    submittedResultHashes: commitments.submittedResultHashes,
    sourceManifestSha256: committedCase.datasetManifestHash,
    policySourceSha256: committedCase.policySourceHash,
    source: dataset.manifest,
    target: {
      recordId: delivered.targetRecord.id,
      observedAtUtc: delivered.targetRecord.time,
      observedMgL: delivered.targetRecord.value,
      forecastMgL: delivered.predictionMgL,
      persistenceMgL: delivered.persistenceMgL,
      forecastAbsoluteErrorMgL: delivered.absoluteErrorMgL,
      persistenceAbsoluteErrorMgL: delivered.persistenceAbsoluteErrorMgL,
    },
    scenarios,
    evaluation,
  } as const;
}
