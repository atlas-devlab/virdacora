// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { basename, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { z } from "zod";
import { loadDiscreteTerritorialCase, reviewDiscreteTerritorialDelivery } from "./discrete-territorial.js";
import { readLocalSourceCsv } from "./sources/source.js";
import { TerritorialReviewError } from "./territorial-review.js";

const scenarios = ["positive", "altered_delivery", "insufficient_delivery"] as const;
const sha256 = z.string().regex(/^0x[0-9a-f]{64}$/);
const commitmentsSchema = z.strictObject({
  schema: z.literal("virdacora-territorial-commitments-v1"),
  mode: z.literal("local-simulation"),
  fundedCaseHash: sha256,
  submittedResultHashes: z.strictObject({
    positive: sha256,
    altered_delivery: sha256,
    insufficient_delivery: sha256,
  }),
});

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(utf8.decode(bytes)) as unknown;
}

async function readBundleEntry(file: string) {
  try {
    return await readLocalSourceCsv(file);
  } catch (cause) {
    throw new Error(`Cannot read ${basename(file)} as a local, regular bundle file of at most 8 MiB.`, { cause });
  }
}

export async function verifyDiscreteTerritorialBundle(bundleFolder: string, trustedCommitmentsSha256: string) {
  if (!sha256.safeParse(trustedCommitmentsSha256).success) {
    throw new Error("Provide an independently retained SHA-256 commitment anchor (0x + 64 lowercase hex digits).");
  }
  if (!bundleFolder.trim() || bundleFolder === "-" || /^[/\\]{2}|^[a-z][a-z0-9+.-]*:\/\//i.test(bundleFolder)) {
    throw new Error("Provide a local territorial bundle directory.");
  }

  const sourceFolder = resolve(bundleFolder, "source");
  const simulationFolder = resolve(bundleFolder, "simulation");
  const commitmentBytes = await readBundleEntry(resolve(simulationFolder, "commitments.json"));
  if (sha256Hex(commitmentBytes) !== trustedCommitmentsSha256) {
    throw new Error("Commitments file does not match the supplied anchor.");
  }
  const commitments = commitmentsSchema.parse(decodeJson(commitmentBytes));

  const [{ spec, result }, recordedCaseFile] = await Promise.all([
    loadDiscreteTerritorialCase(sourceFolder),
    readBundleEntry(resolve(simulationFolder, "case.json")),
  ]);
  if (spec.caseHash !== commitments.fundedCaseHash || canonicalJson(decodeJson(recordedCaseFile)) !== canonicalJson(spec)) {
    throw new Error("The captured measurements and recorded case do not reproduce the funded commitment.");
  }

  const reviewedScenarios = await Promise.all(scenarios.map(async scenario => {
    const candidate = decodeJson(await readBundleEntry(resolve(simulationFolder, scenario, "candidate.json")));
    const submittedResultHash = commitments.submittedResultHashes[scenario];
    try {
      await reviewDiscreteTerritorialDelivery({
        sourceFolder,
        committedCase: spec,
        fundedCaseHash: commitments.fundedCaseHash,
        submittedResultHash,
        candidate,
      });
    } catch (error) {
      if (scenario !== "positive" && error instanceof TerritorialReviewError && error.code === "DELIVERY_NOT_REPRODUCED") {
        return { scenario, submittedResultHash, outcome: "rejected", reason: error.code } as const;
      }
      throw error;
    }
    if (scenario !== "positive") throw new Error(`Invalid discrete territorial delivery reproduced: ${scenario}.`);
    return { scenario, submittedResultHash, outcome: "verified", reason: null } as const;
  }));

  return {
    schema: "virdacora-discrete-territorial-verification-v1",
    mode: commitments.mode,
    scope: "offline reproducibility of captured discrete observations against local-simulation commitments",
    verified: true,
    commitmentsSha256: trustedCommitmentsSha256,
    fundedCaseHash: commitments.fundedCaseHash,
    submittedResultHashes: commitments.submittedResultHashes,
    source: spec.source,
    provider: spec.provider,
    stationId: spec.stationId,
    summary: result.summary,
    scenarios: reviewedScenarios,
  } as const;
}
