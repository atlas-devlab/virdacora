import { assessmentSchema, canonicalJson, type Assessment } from "@terravoce/protocol";
import { z } from "zod";

import { analyzeEvidence, type EvidenceAnalysis } from "./analysis.js";
import { DomainError } from "./errors.js";
import {
  archivedWindowSchema, sensorVerificationKeySchema, verifyArchivedEvidence,
  type SensorVerificationKey, type VerifiedArchive
} from "./evidence-integrity.js";

const evidenceCoreSchema = assessmentSchema.pick({
  modelVersion: true, regionId: true, metric: true, generatedAt: true,
  forecastHorizonSeconds: true, currentValue: true, forecastValue: true,
  slopePerHour: true, anomalyScore: true, confidence: true, risk: true
}).extend({
  observationIds: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).min(5).max(512)
}).strict();

export const evidenceReceiptSchema = z.object({
  formatVersion: z.literal("virdacora-evidence-receipt-v1"),
  assessment: assessmentSchema.strict(),
  evidenceCore: evidenceCoreSchema,
  observations: archivedWindowSchema.refine(rows => rows.length >= 5),
  sensors: z.array(sensorVerificationKeySchema).min(1).max(512)
}).strict();
export type EvidenceReceipt = z.infer<typeof evidenceReceiptSchema>;
const trustedRegistrySchema = z.array(sensorVerificationKeySchema).min(1).max(512);

export const createEvidenceReceipt = (
  analysis: EvidenceAnalysis,
  archive: VerifiedArchive
): EvidenceReceipt => evidenceReceiptSchema.parse({
  formatVersion: "virdacora-evidence-receipt-v1",
  assessment: analysis.assessment,
  evidenceCore: analysis.evidenceCore,
  observations: archive.observations,
  sensors: archive.sensors
});

const invalidReceipt = () => new DomainError(
  "evidence receipt verification failed", 422, "INVALID_EVIDENCE_RECEIPT"
);

// The caller must supply its trusted public-key registry independently. Keys
// carried by the receipt are claims to compare, never a default trust source.
// This function performs no network, filesystem, database or environment reads.
export const verifyEvidenceReceipt = async (
  input: unknown,
  trustedSensors: unknown
): Promise<Assessment> => {
  try {
    const receipt = evidenceReceiptSchema.parse(input);
    const trusted = trustedRegistrySchema.parse(trustedSensors);
    const trustById = new Map<string, SensorVerificationKey>();
    for (const sensor of trusted) {
      if (trustById.has(sensor.sensorId)) throw invalidReceipt();
      trustById.set(sensor.sensorId, sensor);
    }
    const usedIds = new Set(receipt.observations.map(({ observation }) => observation.sensorId));
    const bundledIds = new Set<string>();
    for (const sensor of receipt.sensors) {
      const trustedSensor = trustById.get(sensor.sensorId);
      if (!usedIds.has(sensor.sensorId) || bundledIds.has(sensor.sensorId) ||
          trustedSensor === undefined || canonicalJson(trustedSensor) !== canonicalJson(sensor)) {
        throw invalidReceipt();
      }
      bundledIds.add(sensor.sensorId);
    }
    if (bundledIds.size !== usedIds.size) throw invalidReceipt();

    const archive = await verifyArchivedEvidence(receipt.observations, receipt.assessment, {
      getSensor: async sensorId => {
        const sensor = trustById.get(sensorId);
        return sensor === undefined ? undefined : { ...sensor, label: "Offline trusted public key", active: true };
      }
    });
    // Reuse the actual producer and exact core; do not maintain a second
    // hand-written numerical recipe or silently accept an unknown model version.
    const replay = analyzeEvidence(archive.observations, receipt.assessment.forecastHorizonSeconds);
    if (canonicalJson(replay.evidenceCore) !== canonicalJson(receipt.evidenceCore) ||
        canonicalJson(replay.assessment) !== canonicalJson(receipt.assessment)) {
      throw invalidReceipt();
    }
    return replay.assessment;
  } catch {
    // No untrusted payload, DER error or registry details enter the response.
    throw invalidReceipt();
  }
};
