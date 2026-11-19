// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@terravoce/protocol";
import { z } from "zod";
import { readLocalSourceCsv, type WaterOxygenReading } from "./sources/source.js";
import { importWaterRangersOxygen } from "./sources/water-rangers.js";
import { parseWqpOxygen } from "./sources/wqp.js";
import { TerritorialReviewError } from "./territorial-review.js";

const sourceSchema = "virdacora-discrete-oxygen-archive-v1";
const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const originFields = {
  schema: z.literal(sourceSchema),
  stationId: z.string().min(1).max(200),
  capturedAt: z.iso.datetime(),
  rawSha256: hashSchema,
};

const discreteManifest = z.discriminatedUnion("provider", [
  z.strictObject({ ...originFields, provider: z.literal("wqp"), start: z.iso.date(), end: z.iso.date() }),
  z.strictObject({ ...originFields, provider: z.literal("water-rangers"), datasetUrl: z.url(),
    attribution: z.string().trim().min(1).max(2000),
    origin: z.enum(["simple-table-export", "public-record-transcription"]),
    recordUrls: z.array(z.url()).min(1).max(250).optional(),
  }),
]);

type Outcome = "included" | "non-numeric-or-censored" | "provider-quality";
type AuditedReading = WaterOxygenReading & { summaryDisposition: Outcome; publicRecordUrl: string | null };
export type DiscreteSettlementScenario = "positive" | "altered_delivery" | "insufficient_delivery";

function recordRefs(urls: string[]): Map<string, string> {
  const records = new Map<string, string>();
  for (const link of urls) {
    const url = new URL(link);
    const id = /^\/observations\/(\d+)$/.exec(url.pathname)?.[1];
    if (!id || url.origin !== "https://data.waterrangers.com" || url.username || url.password ||
        url.search || url.hash || records.has(id)) {
      throw new Error("Expected distinct public Water Rangers observation URLs.");
    }
    records.set(id, url.href);
  }
  return records;
}

function disposition(reading: WaterOxygenReading, provider: "wqp" | "water-rangers"): Outcome {
  if (reading.valueMgL === null) return "non-numeric-or-censored";
  if (provider === "wqp" && (!/^(accepted|approved)$/i.test(reading.status ?? "") || reading.qualifiers.length > 0)) {
    return "provider-quality";
  }
  return "included";
}

function summarize(readings: AuditedReading[]) {
  const values: number[] = [];
  const reportedDates = new Set<string>();
  for (const record of readings) {
    if (record.summaryDisposition !== "included" || record.valueMgL === null) continue;
    values.push(record.valueMgL);
    if (record.reportedTime?.date) reportedDates.add(record.reportedTime.date);
  }
  return {
    recordCount: readings.length, includedCount: values.length, excludedCount: readings.length - values.length,
    distinctDates: reportedDates.size,
    minMgL: values.length ? Math.min(...values) : null,
    maxMgL: values.length ? Math.max(...values) : null,
    meanMgL: values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null,
  };
}

function hashResult(core: unknown) {
  return sha256Hex(`discrete-oxygen-delivery-v1:${canonicalJson(core)}`);
}

export function prepareDiscreteTerritorialCase(input: unknown, bytes: Uint8Array) {
  const manifest = discreteManifest.parse(input);
  if (sha256Hex(bytes) !== manifest.rawSha256) throw new Error("Discrete source hash mismatch.");
  const { provider, stationId, capturedAt } = manifest;
  if (new Date(capturedAt).toISOString() !== capturedAt) throw new Error("Expected a canonical UTC capture time.");
  const batch = manifest.provider === "wqp"
    ? parseWqpOxygen(bytes, { stationId, start: manifest.start, end: manifest.end }, capturedAt, { requireDiscrete: true })
    : importWaterRangersOxygen({ bytes, datasetUrl: manifest.datasetUrl, attribution: manifest.attribution });
  const origin = manifest.provider === "wqp" ? "api-response" : manifest.origin;
  const refs = recordRefs(manifest.provider === "water-rangers" ? manifest.recordUrls ?? [] : []);
  if ((origin === "public-record-transcription") !== (refs.size > 0)) {
    throw new Error("Public-record transcriptions need references. Provider exports use the dataset attribution.");
  }

  const knownIds = new Set<string>();
  const readings = batch.readings.filter(record => record.stationId === stationId).map((record): AuditedReading => {
    const id = record.recordId ?? record.activityId;
    if (!id || knownIds.has(id)) throw new Error("Selected observations must have distinct source record identifiers.");
    knownIds.add(id);
    const publicRecordUrl = refs.get(id) ?? null;
    if (refs.size && !publicRecordUrl) throw new Error("A transcribed Water Rangers observation lacks its public reference.");
    return { ...record, publicRecordUrl, summaryDisposition: disposition(record, provider) };
  });
  if (refs.size && refs.size !== readings.length) throw new Error("Public references must match the selected observations.");
  const summary = summarize(readings);
  if (summary.includedCount === 0) throw new Error("The selected station has no eligible numeric dissolved-oxygen observations.");

  const datasetIdentity = provider === "water-rangers" ? batch.sourceUrl : null;
  const stationIdentity = { provider, stationId, datasetIdentity };
  const regionId = `DISCRETE-${sha256Hex(canonicalJson(stationIdentity)).slice(2)}`;
  const source = { ...stationIdentity, origin, capturedAt, url: batch.sourceUrl, termsUrl: batch.termsUrl,
    attribution: batch.attribution, rawSha256: manifest.rawSha256, inputRows: batch.inputRows,
    manifestSha256: sha256Hex(canonicalJson(manifest)) };
  const policy = {
    schema: "discrete-oxygen-review-policy-v1", regionId, metric: "water.oxygen.mg_l",
    action: "DATA_REVIEW", asset: "TEST", amount: 10, challengeSeconds: 86400,
    delivery: "reproduce all selected source records and quality dispositions",
    summaryBasis: provider === "wqp" ? "accepted-or-approved-unqualified-concentrations" : "reported-numeric-concentrations",
    requireBothChambers: true, requireScientificAndCommunityReview: true,
  } as const;
  const policySource = canonicalJson(policy);
  const core = {
    version: "discrete-oxygen-case-v1", provider, stationId, capturedAt, regionId, source, policy,
    policyHash: sha256Hex(`discrete-oxygen-review-policy-v1:${policySource}`), policySourceHash: sha256Hex(policySource),
    evidenceHash: sha256Hex(`discrete-oxygen-observation-batch-v1:${canonicalJson({ source, readings })}`),
    challengeSeconds: policy.challengeSeconds, action: policy.action, requestedAmount: policy.amount, asset: policy.asset,
  } as const;
  const spec = { ...core, caseHash: sha256Hex(`discrete-oxygen-case-v1:${canonicalJson(core)}`) };
  const delivery = { version: "discrete-oxygen-delivery-v1", caseHash: spec.caseHash,
    evidenceHash: spec.evidenceHash, provider, stationId, readings, summary } as const;
  return { spec, result: { ...delivery, resultHash: hashResult(delivery) } };
}

export type DiscreteTerritorialCase = ReturnType<typeof prepareDiscreteTerritorialCase>["spec"];
type DiscreteResult = ReturnType<typeof prepareDiscreteTerritorialCase>["result"];

export async function loadDiscreteTerritorialCase(sourceFolder: string) {
  const [bytes, manifest] = await Promise.all([
    readLocalSourceCsv(resolve(sourceFolder, "observations.csv")),
    readFile(resolve(sourceFolder, "manifest.json"), "utf8"),
  ]);
  return prepareDiscreteTerritorialCase(JSON.parse(manifest), bytes);
}

export function makeDiscreteTerritorialCandidate(result: DiscreteResult, scenario: DiscreteSettlementScenario) {
  const { resultHash: _originalHash, ...core } = structuredClone(result);
  if (scenario === "altered_delivery") {
    const reading = core.readings.find(sample => sample.summaryDisposition === "included");
    if (!reading || reading.valueMgL === null) throw new Error("Missing eligible observation for the alteration check.");
    reading.valueMgL += 1;
    reading.valueText = String(reading.valueMgL);
    reading.unit = "mg/L";
  } else if (scenario === "insufficient_delivery") {
    core.readings.pop();
  }
  const candidate = { ...core, summary: summarize(core.readings) };
  return { ...candidate, resultHash: hashResult(candidate) };
}

export async function reviewDiscreteTerritorialDelivery({
  sourceFolder, committedCase, fundedCaseHash, submittedResultHash, candidate,
}: { sourceFolder: string; committedCase: DiscreteTerritorialCase; fundedCaseHash: string;
  submittedResultHash: string; candidate: unknown }) {
  let fresh: Awaited<ReturnType<typeof loadDiscreteTerritorialCase>>;
  try {
    fresh = await loadDiscreteTerritorialCase(sourceFolder);
  } catch (cause) {
    throw new TerritorialReviewError("SOURCE_INTEGRITY_FAILED", "The discrete source could not be reloaded and validated.", { cause });
  }
  if (fresh.spec.caseHash !== fundedCaseHash || canonicalJson(fresh.spec) !== canonicalJson(committedCase)) {
    throw new TerritorialReviewError("FUNDED_CASE_MISMATCH", "The discrete source does not reproduce the funded case.");
  }

  let snapshot: Record<string, unknown>;
  try {
    const input: unknown = JSON.parse(canonicalJson(candidate));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A delivery object is required.");
    snapshot = input as Record<string, unknown>;
    const { resultHash, ...core } = snapshot;
    if (!hashSchema.safeParse(resultHash).success || resultHash !== submittedResultHash || hashResult(core) !== resultHash) {
      throw new Error("The declared, computed and submitted hashes differ.");
    }
  } catch (cause) {
    throw new TerritorialReviewError("RESULT_COMMITMENT_MISMATCH", "The discrete delivery does not match its submitted hash.", { cause });
  }
  if (canonicalJson(snapshot) !== canonicalJson(fresh.result)) {
    throw new TerritorialReviewError("DELIVERY_NOT_REPRODUCED", "The complete sampling inventory does not match the original data.");
  }
  return { verified: true, caseHash: fresh.spec.caseHash, resultHash: fresh.result.resultHash,
    archiveReloaded: true, scope: "reproducibility of discrete source records under local-simulation commitments" } as const;
}
