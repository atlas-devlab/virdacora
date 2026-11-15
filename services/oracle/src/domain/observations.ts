import type { SensorRegistration, SignedObservation } from "@terravoce/protocol";

export interface StoredSensor extends SensorRegistration {
  active: boolean;
}

export interface StoredObservation {
  observationId: `0x${string}`;
  observation: SignedObservation;
}

// Domain verification requires only this lookup capability, independently of
// any HTTP server, application store aggregate or persistence implementation.
export interface SensorRegistry {
  getSensor(sensorId: string): Promise<StoredSensor | undefined>;
}
