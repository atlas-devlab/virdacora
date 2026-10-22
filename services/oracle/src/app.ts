import { buildHttpApp } from "./adapters/http/build-app.js";
import { validateEvidenceReadToken, type OracleCredentials } from "./adapters/http/auth.js";
import { createTerraLexPolicy } from "./adapters/policy/terralex.js";
import { createOracleUseCases } from "./application/use-cases.js";
import type { ObservationStore } from "./application/ports/observation-store.js";

// Backward-compatible composition facade. Business rules live in application
// and domain; concrete HTTP/policy adapters are wired here, outside those layers.
export interface AppOptions extends OracleCredentials {
  store: ObservationStore;
  policySource: string;
  now?: () => Date;
}

export const buildApp = (options: AppOptions) => {
  validateEvidenceReadToken(options);
  const useCases = createOracleUseCases({ store: options.store,
    policy: createTerraLexPolicy(options.policySource), now: options.now ?? (() => new Date()) });
  return buildHttpApp({ useCases, adminToken: options.adminToken, oracleToken: options.oracleToken,
    ...(options.evidenceReadToken === undefined ? {} : { evidenceReadToken: options.evidenceReadToken }) });
};
