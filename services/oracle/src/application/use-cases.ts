import {
  actionDraftSchema, assessmentSchema, observationId, sensorRegistrationSchema,
  signedObservationSchema, verifyObservation
} from "@terravoce/protocol";
import { z } from "zod";

import { OXYGEN_ANALYSIS_MODEL_VERSION, analyzeEvidence } from "../domain/analysis.js";
import { DomainError } from "../domain/errors.js";
import { verifyArchivedEvidence } from "../domain/evidence-integrity.js";
import { createEvidenceReceipt } from "../domain/evidence-receipt.js";
import { OXYGEN_METRIC, valueForAnalysis } from "../domain/observation-units.js";
import type { ObservationStore } from "./ports/observation-store.js";
import type { PolicyPort } from "./ports/policy.js";

const assessmentRequestSchema = z.object({
  regionId: z.string().min(2).max(128),
  metric: z.string().min(2).max(128),
  forecastHorizonHours: z.number().int().min(1).max(168).default(24),
  requestedAction: z.string().min(1).max(128),
  requestedAmount: z.number().nonnegative(),
  asset: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/)
});

export interface OracleDependencies {
  store: ObservationStore;
  policy: PolicyPort;
  now: () => Date;
}

// Internal application operations, not an authentication boundary. Adapters
// must enforce their caller's capability before invoking privileged commands.
export const createOracleUseCases = ({ store, policy, now }: OracleDependencies) => ({
  policyHash: policy.policyHash,

  registerSensor: async (input: unknown) =>
    store.registerSensor(sensorRegistrationSchema.parse(input)),

  ingestObservation: async (input: unknown) => {
    const observation = signedObservationSchema.parse(input);
    const sensor = await store.getSensor(observation.sensorId);
    if (sensor === undefined || !sensor.active) {
      throw new DomainError("sensor is not registered and active", 403, "SENSOR_INACTIVE");
    }
    if (sensor.regionId !== observation.regionId) {
      throw new DomainError("sensor region mismatch", 403, "SENSOR_REGION_MISMATCH");
    }
    if (!verifyObservation(observation, sensor.publicKeyDerBase64)) {
      throw new DomainError("invalid observation signature", 401, "INVALID_SIGNATURE");
    }
    const observedAt = Date.parse(observation.observedAt);
    const clock = now().getTime();
    if (observedAt > clock + 5 * 60_000 || observedAt < clock - 30 * 24 * 60 * 60_000) {
      throw new DomainError("observation timestamp outside accepted window", 422, "INVALID_TIME");
    }
    // Interpret the numerical vector only after verifying the original signed
    // payload. Persist that payload unchanged, without re-signing or conversion.
    valueForAnalysis(observation);
    const { signature: _signature, ...unsigned } = observation;
    const id = observationId(unsigned);
    await store.addObservation({ observationId: id, observation });
    return { observationId: id, accepted: true };
  },

  runAssessment: async (rawInput: unknown) => {
    const input = assessmentRequestSchema.parse(rawInput);
    const observations = await store.listObservations(input.regionId, input.metric, 512);
    if (observations.length < 5) {
      throw new DomainError("not enough observations", 422, "INSUFFICIENT_OBSERVATIONS");
    }
    const archive = await verifyArchivedEvidence(observations, input, store);
    const analysis = analyzeEvidence(archive.observations, input.forecastHorizonHours * 3_600);
    const assessment = assessmentSchema.parse(analysis.assessment);
    const evidenceReceipt = createEvidenceReceipt(analysis, archive);
    // Preserve the existing order and uncertain-write behavior. A policy
    // failure after this save does not roll back an already retained receipt.
    const evidenceReceiptId = await store.saveAssessmentWithReceipt(evidenceReceipt);
    const decision = policy.evaluate({
      regionId: assessment.regionId,
      metric: assessment.metric,
      risk: assessment.risk,
      confidence: assessment.confidence,
      observations: assessment.observationCount,
      requestedAction: input.requestedAction,
      requestedAmount: input.requestedAmount,
      requestedAsset: input.asset
    });
    const actionDraft = decision.allowed
      ? actionDraftSchema.parse({
          regionId: assessment.regionId,
          evidenceHash: assessment.evidenceHash,
          policyHash: policy.policyHash,
          action: input.requestedAction,
          reversible: true,
          requestedAmount: input.requestedAmount,
          asset: input.asset,
          challengeSeconds: policy.challengeSeconds
        })
      : undefined;
    return { assessment, decision, actionDraft, evidenceReceipt, evidenceReceiptId };
  },

  getEvidenceReceipt: async (receiptId: string) => {
    const receipt = await store.getEvidenceReceipt(receiptId);
    if (receipt === undefined) {
      throw new DomainError("evidence receipt not found", 404, "EVIDENCE_RECEIPT_NOT_FOUND");
    }
    return receipt;
  },

  listEvidenceReceipts: (assessmentId: string, limit: number, after?: string) =>
    store.listEvidenceReceipts(assessmentId, limit, after),

  latestAssessment: async (regionId: string, metric: string) => {
    const assessment = await store.latestAssessment(regionId, metric,
      metric === OXYGEN_METRIC ? OXYGEN_ANALYSIS_MODEL_VERSION : undefined);
    if (assessment === undefined) {
      throw new DomainError("assessment not found", 404, "ASSESSMENT_NOT_FOUND");
    }
    return assessment;
  },

  checkReadiness: () => store.checkReadiness(),
  close: () => store.close()
});

export type OracleUseCases = ReturnType<typeof createOracleUseCases>;
export type EvidenceReadUseCases = Pick<OracleUseCases, "getEvidenceReceipt" | "listEvidenceReceipts">;
