# Virdacora

<p align="center"><img src="docs/assets/virdacora-logo-v1.png" alt="Virdacora — Le prove dell’ambiente, la voce delle comunità" width="560"></p>

**Le prove dell’ambiente, la voce delle comunità.**

Formerly TerraVoce. Virdacora is the adopted project name; trademark registration
has not been completed. The repository is public.
See the [identity and compatibility notes](docs/BRAND_IT_EN.md),
[source terms](LICENSE_POLICY.md) and [Italian/English introduction](docs/LINKEDIN_POST_IT_EN.md).

An open source research prototype for making environmental data and decisions
traceable and reproducible.

The current example follows synthetic dissolved-oxygen observations through a
simple risk model, explicit policy rules, and a community decision on a local
simulated blockchain.

**Status: research MVP.** There is no public-chain deployment, live environmental
pilot, real treasury funding, connected physical actuator, or independent audit.
The risk model and its risk/confidence scores are demonstration heuristics,
without field validation. Virdacora is the adopted name; TerraLex remains a working name and
refers here to the experimental policy language in this repository.

> Per una spiegazione completa in italiano, leggi la
> [guida operativa](GUIDA_OPERATIVA.md).

Oracle storage, request-boundary fixes and the reproducible synthetic performance
comparison are explained in [Italian and English](docs/ORACLE_RESILIENCE_IT_EN.md).
Run `pnpm benchmark:oracle` for the local indexed-store comparison.

The [real PostgreSQL validation (IT/EN)](docs/POSTGRES_VALIDATION_IT_EN.md)
tests storage constraints, concurrent writers and signed API requests against
an isolated PostgreSQL 18 server. Run `pnpm test:postgres` with the explicit
dedicated local test URL; the ordinary unit suite does not imply database validation.

The [shared timestamp ordering rule (IT/EN)](docs/TIMESTAMP_ORDER_IT_EN.md)
aligns memory, PostgreSQL and analysis using separate millisecond ordering keys.
Existing PostgreSQL volumes require migration 002 before running the new writer.

The [PostgreSQL recovery checks (IT/EN)](docs/POSTGRES_RECOVERY_IT_EN.md)
cover clean shutdown, SIGKILL and a blocked write using a fresh Docker volume.
Run `pnpm test:postgres:recovery` with Docker available. The runner never uses
a production database URL; `/healthz` remains liveness rather than DB readiness.

The [database readiness check (IT/EN)](docs/DATABASE_READINESS_IT_EN.md)
adds `/readyz`: 200 when the configured store passes a read-only probe, 503 when
unavailable. Compose uses this endpoint for Oracle health; liveness stays separate.

The [controlled Oracle shutdown (IT/EN)](docs/ORACLE_SHUTDOWN_IT_EN.md)
drains active HTTP requests and closes storage on SIGTERM/SIGINT, with a
20-second application deadline and 25-second Compose grace period.
Run `pnpm test:oracle:shutdown` with Docker to test actual Linux signals and a
blocked signed-observation write against an isolated PostgreSQL instance.

## Research branches and original mission

The mission is to combine verifiable environmental analysis, distributed
coordination, checkable interventions and decision rights for affected
communities and young people. Token ownership does not buy environmental votes.
The current `main` demonstration remains the synthetic prototype described below.
Later real-data, forecasting, source-discovery and first-attestor experiments
are on [the research branch](https://github.com/atlas-devlab/virdacora/tree/feat/autonomous-source-evidence)
and the stacked pull requests; they have not all been merged into `main`.
[Current research presentation](https://github.com/atlas-devlab/virdacora/blob/feat/autonomous-source-evidence/docs/PROJECT_PRESENTATION_IT_EN.md).

## First goal: replay one open oxygen dataset

Replay **one openly licensed dissolved-oxygen time series from one monitoring
station, offline**. Compare the current model with a simple prediction that uses
the latest measured value, and report the errors. This replay is not implemented
yet; [issue #3](https://github.com/atlas-devlab/virdacora/issues/3) is the place to
suggest a dataset or help with the experiment. The result should be reproducible
by another person. See the [validation criteria](CONTRIBUTING.md#validation-target-for-the-replay).

## Everyone can take part

You do not need coding experience or an environmental qualification to ask a
question, share an idea, improve an explanation, translate a paragraph, or report
what happened when you tried the demo. Questions about what is unclear are useful.

| Small first step | Where to start |
| --- | --- |
| Ask a question, try the demo, or clarify or translate one part of the walkthrough. | [Issue #1](https://github.com/atlas-devlab/virdacora/issues/1) |
| Suggest a public oxygen dataset, or ask about a demonstration threshold. | [Issue #3](https://github.com/atlas-devlab/virdacora/issues/3) |
| If you want to contribute code, add one negative test for an existing policy rule. | [Issue #2](https://github.com/atlas-devlab/virdacora/issues/2) |

For a small change, fork the repository and open a pull request without waiting
for an assignment. A short issue comment can help avoid duplicate work. Larger
changes should start with a discussion. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Puoi partecipare anche senza saper programmare:** una domanda, un'idea, una
traduzione o una prova della demo sono già contributi utili.

## How it works

1. Sensors sign observations with Ed25519; the oracle checks signatures and
   observation sequence numbers.
2. The oracle produces a reproducible assessment and evidence hash.
3. TerraLex compiles and evaluates a restricted environmental policy, including
   allowed actions, budget limits and a challenge window.
4. Smart contracts record evidence and policy versions, govern proposals, and
   constrain treasury transfers.
5. Affected-community and youth chambers participate in governance. Ownership of
   the experimental ENV token does not grant environmental voting rights.

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/terralex` | Policy parser, compiler, evaluator and CLI |
| `packages/protocol` | Signed observation and assessment schemas |
| `packages/contracts` | Evidence, policy, civic governance, treasury and ENV contracts |
| `services/oracle` | Sensor API, deterministic analysis, storage and policy evaluation |
| `policies` | Demonstration policy for Po Delta water oxygen |
| `docs` | Architecture, API, invariants, threat model, deployment and validation |

## Run the current demo locally

Install **Node.js 24 or later** and **pnpm 11.7.0**, matching `package.json`.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm terralex compile ../../policies/po-water-v1.terra
pnpm demo
pnpm e2e
```

`pnpm terralex` runs the CLI from `packages/terralex`, so the policy path above
is relative to that package. Run the command itself from the repository root.

`pnpm e2e` uses Hardhat's local simulated network and generated demo identities.
It does not require a wallet, an RPC provider, or real funds. Build the workspace
before running individual package tests, because internal package exports point
to their compiled output.

For the optional PostgreSQL-backed local service, install Docker and run:

```sh
docker compose up -d --build
```

Process liveness is `http://localhost:8877/healthz`; database readiness is
`http://localhost:8877/readyz`. Stop the services with
`docker compose stop` to preserve the local database volume. Compose uses
development credentials; keep this demonstration on a trusted local machine.
The example configuration contains placeholders, and the Node process reads
configuration from environment variables rather than automatically loading `.env`.
See [deployment notes](docs/deployment.md) for configuration and production gates.

See [validation](docs/VALIDATION.md) for the checks rerun for this source publication
and the boundaries of that verification.

## License

Default source terms are [AGPLv3, version 3 only](LICENSE). Earlier MIT
permissions and explicit MIT/Apache notices are retained; see
[LICENSE_POLICY.md](LICENSE_POLICY.md). External data and dependencies retain
their own terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The name and logo follow [TRADEMARK_POLICY.md](TRADEMARK_POLICY.md).
