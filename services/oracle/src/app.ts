import { timingSafeEqual } from "node:crypto";

import {
  actionDraftSchema,
  assessmentSchema,
  observationId,
  sensorRegistrationSchema,
  signedObservationSchema,
  verifyObservation
} from "@terravoce/protocol";
import { compileTerraLex, evaluatePolicy } from "@terravoce/terralex";
import Fastify, { errorCodes } from "fastify";
import { z } from "zod";

import { OXYGEN_ANALYSIS_MODEL_VERSION, analyzeObservations } from "./analysis.js";
import { DomainError } from "./errors.js";
import { OXYGEN_METRIC, valueForAnalysis } from "./observation-units.js";
import type { ObservationStore } from "./store.js";

const assessmentRequestSchema = z.object({
  regionId: z.string().min(2).max(128),
  metric: z.string().min(2).max(128),
  forecastHorizonHours: z.number().int().min(1).max(168).default(24),
  requestedAction: z.string().min(1).max(128),
  requestedAmount: z.number().nonnegative(),
  asset: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/)
});

export interface AppOptions {
  store: ObservationStore;
  policySource: string;
  adminToken: string;
  oracleToken: string;
  now?: () => Date;
}

const tokenMatches = (provided: unknown, expected: string): boolean => {
  if (typeof provided !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Only framework parser failures belong here: arbitrary store errors must stay private.
const inputErrors = [
  ["FST_ERR_CTP_INVALID_JSON_BODY", 400],
  ["FST_ERR_CTP_EMPTY_JSON_BODY", 400],
  ["FST_ERR_CTP_INVALID_CONTENT_LENGTH", 400],
  ["FST_ERR_CTP_BODY_TOO_LARGE", 413],
  ["FST_ERR_CTP_INVALID_MEDIA_TYPE", 415]
] as const;

export const buildApp = (options: AppOptions) => {
  // Keep active HTTP requests alive while close() drains them. Be explicit:
  // Fastify 5.10's default "idle" branch can close every active connection.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, forceCloseConnections: false });
  const policy = compileTerraLex(options.policySource);
  const now = options.now ?? (() => new Date());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: "INVALID_INPUT", issues: error.issues });
      return;
    }
    for (const [code, status] of inputErrors) {
      if (error instanceof errorCodes[code]) {
        void reply.status(status).send({ error: code });
        return;
      }
    }
    app.log.error(error);
    void reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  app.addHook("onClose", async () => options.store.close());

  app.get("/healthz", async () => ({ status: "ok", policyHash: policy.policyHash }));

  // Share the actual probe until it settles, even if an HTTP deadline expires.
  // A deadline does not cancel a query or justify starting additional queries.
  let readinessInFlight: Promise<void> | undefined;
  const probeReadiness = (): Promise<void> => {
    if (readinessInFlight !== undefined) return readinessInFlight;
    const probe = Promise.resolve().then(() => options.store.checkReadiness());
    readinessInFlight = probe;
    const release = () => {
      if (readinessInFlight === probe) readinessInFlight = undefined;
    };
    void probe.then(release, release);
    return probe;
  };

  app.get("/readyz", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probeReadiness(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("readiness deadline exceeded")), 2_000);
        })
      ]);
      return reply.status(200).send({ status: "ready" });
    } catch {
      // Never route store errors through the general/domain error handler.
      return reply.status(503).send({ status: "not_ready" });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  });

  app.post("/v1/sensors", async (request, reply) => {
    if (!tokenMatches(request.headers["x-admin-token"], options.adminToken)) {
      throw new DomainError("invalid administrator token", 401, "UNAUTHORIZED");
    }
    const registration = sensorRegistrationSchema.parse(request.body);
    const sensor = await options.store.registerSensor(registration);
    return reply.status(201).send(sensor);
  });

  app.post("/v1/observations", async (request, reply) => {
    const observation = signedObservationSchema.parse(request.body);
    const sensor = await options.store.getSensor(observation.sensorId);
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

    // Validate interpretation only after checking the original signature. Store
    // that original unchanged; conversion belongs to the analytical vector.
    valueForAnalysis(observation);
    const { signature: _signature, ...unsigned } = observation;
    const id = observationId(unsigned);
    await options.store.addObservation({ observationId: id, observation });
    return reply.status(202).send({ observationId: id, accepted: true });
  });

  app.post("/v1/assessments/run", async (request, reply) => {
    if (!tokenMatches(request.headers["x-oracle-token"], options.oracleToken)) {
      throw new DomainError("invalid oracle token", 401, "UNAUTHORIZED");
    }
    const input = assessmentRequestSchema.parse(request.body);
    const observations = await options.store.listObservations(input.regionId, input.metric, 512);
    if (observations.length < 5) {
      throw new DomainError("not enough observations", 422, "INSUFFICIENT_OBSERVATIONS");
    }

    const assessment = assessmentSchema.parse(
      analyzeObservations(observations, input.forecastHorizonHours * 3_600)
    );
    await options.store.saveAssessment(assessment);
    const decision = evaluatePolicy(policy, {
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
          challengeSeconds: policy.policy.challengeSeconds
        })
      : undefined;

    return reply.status(201).send({ assessment, decision, actionDraft });
  });

  app.get("/v1/regions/:regionId/metrics/:metric/latest", async (request) => {
    const parameters = z
      .object({ regionId: z.string().min(2), metric: z.string().min(2) })
      .parse(request.params);
    const assessment = await options.store.latestAssessment(
      parameters.regionId,
      parameters.metric,
      // A legacy result must not hide a corrected interpretation merely because
      // its hash sorts later at the same measurement timestamp.
      parameters.metric === OXYGEN_METRIC ? OXYGEN_ANALYSIS_MODEL_VERSION : undefined
    );
    if (assessment === undefined) {
      throw new DomainError("assessment not found", 404, "ASSESSMENT_NOT_FOUND");
    }
    return assessment;
  });

  return app;
};

