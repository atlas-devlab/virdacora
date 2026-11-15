import Fastify, { errorCodes } from "fastify";
import { z } from "zod";

import type { OracleUseCases } from "../../application/use-cases.js";
import { DomainError } from "../../domain/errors.js";
import { tokenMatches, validateEvidenceReadToken, type OracleCredentials } from "./auth.js";

export interface HttpAppOptions extends OracleCredentials {
  useCases: OracleUseCases;
}

// Only framework parser failures belong here: arbitrary store errors stay private.
const inputErrors = [
  ["FST_ERR_CTP_INVALID_JSON_BODY", 400],
  ["FST_ERR_CTP_EMPTY_JSON_BODY", 400],
  ["FST_ERR_CTP_INVALID_CONTENT_LENGTH", 400],
  ["FST_ERR_CTP_BODY_TOO_LARGE", 413],
  ["FST_ERR_CTP_INVALID_MEDIA_TYPE", 415]
] as const;

export const buildHttpApp = (options: HttpAppOptions) => {
  validateEvidenceReadToken(options);
  const oracle = options.useCases;
  const canReadEvidence = (oracleToken: unknown, evidenceToken: unknown): boolean =>
    tokenMatches(oracleToken, options.oracleToken) ||
    (options.evidenceReadToken !== undefined && tokenMatches(evidenceToken, options.evidenceReadToken));
  // Drain active HTTP requests on close, preserving the existing Fastify contract.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, forceCloseConnections: false });
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
  app.addHook("onClose", async () => oracle.close());
  app.get("/healthz", async () => ({ status: "ok", policyHash: oracle.policyHash }));

  // A response deadline does not cancel the store probe. Keep sharing the same
  // pending operation until it settles instead of multiplying database queries.
  let readinessInFlight: Promise<void> | undefined;
  const probeReadiness = (): Promise<void> => {
    if (readinessInFlight !== undefined) return readinessInFlight;
    const probe = Promise.resolve().then(() => oracle.checkReadiness());
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
      return reply.status(503).send({ status: "not_ready" });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  });

  app.post("/v1/sensors", async (request, reply) => {
    if (!tokenMatches(request.headers["x-admin-token"], options.adminToken)) {
      throw new DomainError("invalid administrator token", 401, "UNAUTHORIZED");
    }
    return reply.status(201).send(await oracle.registerSensor(request.body));
  });
  app.post("/v1/observations", async (request, reply) =>
    reply.status(202).send(await oracle.ingestObservation(request.body)));

  app.post("/v1/assessments/run", async (request, reply) => {
    if (!tokenMatches(request.headers["x-oracle-token"], options.oracleToken)) {
      throw new DomainError("invalid oracle token", 401, "UNAUTHORIZED");
    }
    return reply.status(201).send(await oracle.runAssessment(request.body));
  });
  app.get("/v1/evidence-receipts/:receiptId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!canReadEvidence(request.headers["x-oracle-token"], request.headers["x-evidence-token"])) {
      throw new DomainError("invalid oracle token", 401, "UNAUTHORIZED");
    }
    const { receiptId } = z.object({ receiptId: z.string().regex(/^0x[0-9a-f]{64}$/) }).parse(request.params);
    return oracle.getEvidenceReceipt(receiptId);
  });
  app.get("/v1/assessments/:assessmentId/evidence-receipts", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!canReadEvidence(request.headers["x-oracle-token"], request.headers["x-evidence-token"])) {
      throw new DomainError("invalid oracle token", 401, "UNAUTHORIZED");
    }
    const { assessmentId } = z.object({ assessmentId: z.string().regex(/^0x[0-9a-f]{64}$/) }).parse(request.params);
    const query = z.object({
      limit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).transform(Number).optional(),
      after: z.string().regex(/^0x[0-9a-f]{64}$/).optional()
    }).strict().parse(request.query);
    return oracle.listEvidenceReceipts(assessmentId, query.limit ?? 20, query.after);
  });
  app.get("/v1/regions/:regionId/metrics/:metric/latest", async request => {
    const parameters = z.object({ regionId: z.string().min(2), metric: z.string().min(2) }).parse(request.params);
    return oracle.latestAssessment(parameters.regionId, parameters.metric);
  });
  return app;
};
