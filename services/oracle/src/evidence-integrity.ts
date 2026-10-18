import {
  observationId,
  sensorRegistrationSchema,
  signedObservationSchema,
  verifyObservation
} from "@terravoce/protocol";
import { z } from "zod";

import { DomainError } from "./errors.js";
import type { ObservationStore, StoredObservation } from "./store.js";

const archivedWindowSchema = z.array(z.object({
  observationId: z.custom<StoredObservation["observationId"]>(value =>
    typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value)),
  observation: signedObservationSchema.strict()
}).strict()).max(512);
const registeredSensorSchema = sensorRegistrationSchema.extend({ active: z.boolean() }).strict();

const invalidEvidence = () => new DomainError(
  "archived observation evidence is invalid", 422, "INVALID_ARCHIVED_EVIDENCE"
);

export const verifyArchivedObservations = async (
  entries: unknown,
  selection: { regionId: string; metric: string },
  store: Pick<ObservationStore, "getSensor">
): Promise<StoredObservation[]> => {
  // Parse the entire window synchronously. These independent snapshots, rather
  // than mutable references returned by a store, are later passed to analysis.
  const parsed = archivedWindowSchema.safeParse(entries);
  if (!parsed.success) throw invalidEvidence();
  const snapshots = parsed.data;
  const ids = new Set<string>();
  const sequences = new Set<string>();
  for (const { observationId: id, observation } of snapshots) {
    if (observation.regionId !== selection.regionId || observation.metric !== selection.metric) {
      throw invalidEvidence();
    }
    const { signature: _signature, ...unsigned } = observation;
    const sequenceKey = JSON.stringify([observation.sensorId, observation.sequence]);
    if (observationId(unsigned) !== id || ids.has(id) || sequences.has(sequenceKey)) {
      throw invalidEvidence();
    }
    ids.add(id);
    sequences.add(sequenceKey);
  }

  // Cache only within this run. No positive key result survives into another
  // request. Registry I/O failures intentionally propagate as availability errors.
  const publicKeys = new Map<string, string>();
  for (const { observation } of snapshots) {
    let publicKey = publicKeys.get(observation.sensorId);
    if (publicKey === undefined) {
      const sensor = registeredSensorSchema.safeParse(await store.getSensor(observation.sensorId));
      if (!sensor.success || sensor.data.sensorId !== observation.sensorId ||
          sensor.data.regionId !== observation.regionId) {
        throw invalidEvidence();
      }
      // Inactivity prevents new ingestion; it does not retroactively revoke an
      // archived signature. There is no historical key registry in this MVP.
      publicKey = sensor.data.publicKeyDerBase64;
      publicKeys.set(observation.sensorId, publicKey);
    }
    let verified = false;
    try {
      verified = verifyObservation(observation, publicKey);
    } catch {
      // Invalid DER or signature/schema details must not enter client errors.
    }
    if (!verified) throw invalidEvidence();
  }
  return snapshots;
};
