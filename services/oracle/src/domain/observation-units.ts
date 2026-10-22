import type { UnsignedObservation } from "@terravoce/protocol";

import { DomainError } from "./errors.js";

export const OXYGEN_METRIC = "water.oxygen.mg_l";

// This registry is deliberately limited to oxygen mass concentration. It does
// not infer conversions for other metrics, ppm or oxygen saturation. Never
// replace fields on a signed observation, even on a copy: its signature must
// keep describing the original value and exact unit spelling.
export const valueForAnalysis = (
  observation: Pick<UnsignedObservation, "metric" | "value" | "unit">
): number => {
  if (observation.metric !== OXYGEN_METRIC) return observation.value;

  let divisor: number;
  switch (observation.unit) {
    case "mg/L":
      divisor = 1;
      break;
    case "ug/L":
    case "\u00b5g/L": // micro sign
    case "\u03bcg/L": // Greek small letter mu
      divisor = 1_000;
      break;
    default:
      throw new DomainError("unsupported unit for oxygen concentration", 422, "INVALID_OBSERVATION_UNIT");
  }

  const value = observation.value / divisor;
  if (!Number.isFinite(value)) {
    throw new DomainError("oxygen concentration must be finite", 422, "INVALID_OBSERVATION_VALUE");
  }
  return value;
};
