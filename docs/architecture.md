# Virdacora architecture

The Oracle implementation separates domain, application/ports, adapters and a
composition facade. See the [IT/EN module map and behavioral invariants](CLEAN_ARCHITECTURE_IT_EN.md).
The authority flow below is unchanged; this structural refactor adds no LLM or
satellite adapter.

This document describes the intended architecture. The current research MVP
uses synthetic sensor data and a deterministic mathematical risk model. Oracle
participants and treasury operations are simulated locally; independently
operated oracle replicas, a public deployment and a field pilot are future work.

## Design decision

AI inference does not run inside the blockchain. Models are too expensive to
execute on-chain, model weights are difficult to reproduce across runtimes, and
opaque inference would make consensus depend on a vendor. Instead, independent
oracle operators run the same open model and attest to a canonical evidence
hash. Contracts enforce quorum, authorization, delays, budgets, and execution.

## Components

1. Sensors sign canonical observations with Ed25519 keys.
2. Oracle replicas verify signatures and retain the raw observations.
3. The assessment engine computes anomaly, trend, forecast, confidence, and
   risk using a versioned deterministic model.
4. TerraLex evaluates whether an assessment may create an autonomous reversible
   action. The compiled policy and its hash are public.
5. Oracle operators attest the evidence hash on-chain. A proposal can reference
   evidence only after the configured quorum is reached.
6. TerraAct routes the proposal through an autonomous challenge window or a
   two-chamber vote, depending on risk.
7. The treasury releases one stable funding asset only through an executable
   proposal. Autonomous spending also has an immutable epoch cap.

## Trust boundaries

```text
sensor key -> signed observation -> oracle quorum -> evidence hash
                                                |
TerraLex source -> canonical compiler -> policy hash
                                                |
                                                v
community registry -> TerraAct governor -> locked treasury -> recipient
         youth chamber ----^       ^
         guardian pause -----------|
```

Raw data and model artifacts may be mirrored through object storage and
content-addressed networks. Only hashes, concise metadata, votes, and treasury
state belong on-chain.

## Deployment target

The contracts are EVM portable. The first deployment should use a low-cost
public testnet on an OP Stack-compatible L2. Production administration must be a
multisig behind a timelock; deployer keys must renounce direct control after the
bootstrap ceremony.

