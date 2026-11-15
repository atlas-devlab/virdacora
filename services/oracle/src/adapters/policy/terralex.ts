import { compileTerraLex, evaluatePolicy } from "@terravoce/terralex";

import type { PolicyPort } from "../../application/ports/policy.js";

export const createTerraLexPolicy = (source: string): PolicyPort => {
  const bundle = compileTerraLex(source);
  return {
    policyHash: bundle.policyHash,
    challengeSeconds: bundle.policy.challengeSeconds,
    evaluate: context => evaluatePolicy(bundle, context)
  };
};
