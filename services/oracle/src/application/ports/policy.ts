// Owned by the application. TerraLex is one adapter; HTTP, LLM providers and
// database drivers are not part of the deterministic authorization contract.
export interface PolicyContext {
  regionId: string;
  metric: string;
  risk: number;
  confidence: number;
  observations: number;
  requestedAction: string;
  requestedAmount: number;
  requestedAsset: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  policyHash: `0x${string}`;
  action?: {
    name: string;
    reversible: true;
    maxAmount: number;
    asset: string;
    challengeSeconds: number;
  };
}

export interface PolicyPort {
  readonly policyHash: `0x${string}`;
  readonly challengeSeconds: number;
  evaluate(context: PolicyContext): PolicyDecision;
}
