# Virdacora

<p align="center"><img src="docs/assets/virdacora-logo-v1.png" alt="Virdacora — Le prove dell’ambiente, la voce delle comunità" width="560"></p>

**Le prove dell’ambiente, la voce delle comunità.**

Formerly TerraVoce. Virdacora is the adopted project name; trademark registration
has not been completed. The repository is public.
See the [identity and compatibility notes](docs/BRAND_IT_EN.md),
[source terms](LICENSE_POLICY.md) and [Italian/English introduction](docs/LINKEDIN_POST_IT_EN.md).

An open source research prototype for making environmental data and decisions
traceable and reproducible.

Virdacora's long-term mission is a global environmental coordination system:
distributed AI analysis, resilient public evidence, blockchain funding for
verifiable interventions, and decision rights for affected communities and young
people. The local prototypes below test individual parts of that mission.

The examples follow both synthetic observations and a pinned real USGS oxygen
dataset through a simple risk model, explicit policy rules, and civic decisions
on a local simulated blockchain. The real-data case verifies delivery of a
data-review report and gates payment on two result reviews.

**Status: research MVP.** There is no public-chain deployment, live environmental
pilot, real treasury funding, connected physical actuator, or independent audit.
The risk model and its risk/confidence scores are demonstration heuristics,
without field validation. Virdacora is the adopted name; TerraLex remains a working name and
refers here to the experimental policy language in this repository.

> Per una spiegazione completa in italiano, leggi la
> [guida operativa](GUIDA_OPERATIVA.md).

Future Willamette acquisitions use a bounded UTF-8 transport: see the
[Italian/English implementation and synthetic benchmark](docs/BOUNDED_TRANSPORT_IT_EN.md).
This does not recapture or change the archived experiments.

## First real-data case: review USGS oxygen measurements

The [real-data module](services/environmental-case/README.md) replays 673 approved
USGS measurements from the Willamette River at Portland. Chronological 1-hour
evaluation gives 335 pairs: current-model MAE 0.242 mg/L versus persistence
0.205 mg/L. The simpler baseline performs better on this window. There are no
low-oxygen events under the illustrative threshold, so alert detection remains
unevaluated. This is one reproducible territorial module of the global mission.

The path includes source hashes/quality flags, Oracle ingestion, TerraLex,
the existing proposal bridge, community/youth voting, a committed follow-up
report and two-review escrow payment. Governance, reviewers and funds are
simulated; no physical sampling or independent field review has occurred.
After `pnpm build`, run `pnpm case:replay`, `pnpm case:verify` and `pnpm case:e2e`.
[Issue #3](https://github.com/atlas-devlab/virdacora/issues/3) remains a place to
discuss methods and limitations. See the [validation criteria](CONTRIBUTING.md#validation-target-for-the-replay).

## Observation-only multivariate forecasting experiment

A separate [Willamette experiment](docs/WILLAMETTE_FORECAST_EXPERIMENT.md) joins
real oxygen, temperature and signed instantaneous discharge measurements.
Training, selection, interval calibration and final evaluation use separate
chronological phases. The small summer improvement does not transfer to the
predeclared autumn and winter windows: frozen-model MAE is 0.306 versus 0.102
mg/L in autumn, and 1.279 versus 0.012 mg/L in winter. Its unchanged empirical
interval has zero winter coverage. An independent Python implementation checks
the numerical calculations against the TypeScript implementation; this is a
code cross-check by the same project, not an independent scientific audit.
The experiment is unsuitable for operational promotion. No operational Oracle,
governance or funding behavior changes. Run `pnpm forecast:replay` and
`pnpm forecast:verify` after building. This remains a reusable part of the
environmental coordination mission. Run
`python3 scripts/audit_willamette.py --external --summary`
to reproduce the seasonal check offline. See the executed
[audit notebook](docs/notebooks/willamette-forecast-audit.ipynb).

A subsequent [training-source readiness audit](docs/WILLAMETTE_TRAINING_READINESS.md)
archives four 2024 seasonal windows with 2,559 complete one-hour pairs. It also
exposes missing forecast origins: autumn has only 90.15% expected-grid coverage.
That readiness audit itself does not fit a model or claim forecast skill.

The subsequent [fixed four-season test](docs/WILLAMETTE_MULTISEASON_EXPERIMENT.md)
learns the same eight-feature ridge recipe on those 2,559 training pairs and
freezes the weights before acquiring four later 2025 windows. On 2,591 test pairs,
equal-season mean MAE is 0.109945 versus persistence 0.110874 mg/L: a 0.84%
point gain, with losses in winter, spring and autumn. The predeclared 48-hour
block-bootstrap interval for the absolute gain spans -0.003821 to 0.005414 mg/L;
24/72-hour checks also include zero. The result fails the declared improvement
rule. Two archived summer targets below the illustrative 5 mg/L threshold are
not anticipated. The 10% aspiration is not an acceptance gate. No model promotion
or operational behavior changes. Reproduce offline with
`python scripts/experiment_multiseason.py verify-fit` and `verify`.
See the executed [four-season notebook](docs/notebooks/willamette-multiseason.ipynb).

A subsequent [hourly error diagnosis](docs/WILLAMETTE_HOURLY_DIAGNOSTICS.md)
([English](docs/WILLAMETTE_HOURLY_DIAGNOSTICS_EN.md)) reconstructs all 2,591 pairs,
separates past-history groups from retrospective target groups, and retains
record-level context for the two low summer targets. Future context is marked
explicitly; no model is fitted or promoted. Run `pnpm forecast:diagnose:verify`
to reproduce the committed diagnosis using local archives.

The [one-hour stability protocol](docs/WILLAMETTE_STABILITY_PROTOCOL.md)
([English](docs/WILLAMETTE_STABILITY_PROTOCOL_EN.md)) fixes a single past-only
persistence fallback and four separate 28-day verification windows. Capture
and evaluation code was committed and pushed before requesting those targets.
The [completed real-data test](docs/WILLAMETTE_STABILITY_RESULTS_EN.md)
([Italian](docs/WILLAMETTE_STABILITY_RESULTS.md)) uses 5,213 pairs with all four
coverage screens passing. Equal-season MAE is 0.089023 mg/L for persistence,
0.093555 for the frozen ridge and 0.092470 with fallback: the modification
improves ridge by 1.16% but remains 3.87% worse than persistence. The declared
outcome is `no-overall-improvement`; 24/48/72-hour exploratory intervals retain
that comparison's signs. Secondary RMSE improves against persistence in each
window, without replacing the primary criterion. No model is refitted or
promoted. Run `pnpm forecast:stability:verify` for offline replay and
`python scripts/audit_stability_evidence.py .` for the separate arithmetic
check. See the [executed notebook](docs/notebooks/willamette-stability.ipynb).

The subsequent [error-mechanism diagnosis](docs/WILLAMETTE_ERROR_MECHANISMS_EN.md)
([Italian](docs/WILLAMETTE_ERROR_MECHANISMS.md)) accounts for the same 5,213
pairs: gains on changing published values do not offset corrections when the
target stays unchanged. It includes two deterministic extreme examples and an
[executed companion notebook](docs/notebooks/willamette-error-mechanisms.ipynb).
Run `python scripts/diagnose_stability_errors.py verify` to reproduce it offline.
This is post-hoc development evidence; a small-correction filter remains a
proposal, with no new threshold, fit or final validation.

The [threshold-development plan](docs/WILLAMETTE_THRESHOLD_DEVELOPMENT_EN.md)
([Italian](docs/WILLAMETTE_THRESHOLD_DEVELOPMENT.md)) now fixes five candidate
thresholds, a shared rule and an internal chronological split of those already
inspected windows. A past-only filter and synthetic selection checks are
implemented; the preflight checks timestamps and pinned input hashes only.
The separately committed scoring runner subsequently selected 0.10 mg/L on
the first development parts. On the later, already-inspected parts, equal-window
MAE decreases from 0.093487 to 0.088022 mg/L, with no window loss. This remains
development evidence. See the offline [development verifier](scripts/evaluate_threshold_development.py).

The [Owasco Lake transfer](docs/OWASCO_LAKE_TRANSFER_EN.md)
([Italian](docs/OWASCO_LAKE_TRANSFER.md)) freezes that threshold and the same
Willamette weights before acquiring one July 2020 window from a near-surface
EXO 1 sonde. All methods share 1,275 of 1,332 expected pairs (95.72% coverage).
MAE is 0.038667 mg/L for persistence and 0.038692 for the filter; it changes only
four forecasts and does not demonstrate improvement. Exploratory paired block
intervals include zero. The [executed notebook](docs/notebooks/owasco-lake-transfer.ipynb)
and offline replay retain the negative result, raw evidence and scope limits.
No lake tuning, operational promotion or governance changes occur.

The [two-track follow-up, in Italian and English](docs/OWASCO_TWO_TRACK_RESULTS_IT_EN.md)
decomposes July's saved errors into fixed reporting bins and evaluates the same
frozen pipeline on a previously uninspected August 1–29 window. August has
1,306 accepted pairs: filtered MAE is 0.055453 mg/L versus 0.055513 for
persistence, but all three exploratory gain intervals include zero. The result
is inconclusive; the original July result and operational system remain intact.

The [two-hour direction diagnostic, in Italian and English](docs/OWASCO_DIRECTION_DIAGNOSTIC.md)
then checks a single past-only selector on those already-open July/August rows.
It retains the last observation unless the frozen ridge correction and the
two-hour oxygen change have the same nonzero sign. Full-cohort MAE increases
from 0.038667 to 0.039046 mg/L in July and from 0.055513 to 0.055610 in August.
The adopted development screen fails in both months: this candidate stops, with
no September acquisition, refit, threshold search or operational promotion.
Code and protocol were committed before the first selector score; offline
replay preserves the original evidence and explicitly labels post-target examples.

The [fixed attenuation check, in Italian and English](docs/OWASCO_ATTENUATED_CORRECTION_IT_EN.md)
then reduces only the amplitude beyond the inherited 0.100 mg/L gate, using
the exact saved regression predictions on those already-open months. July MAE
is 0.038692 mg/L versus persistence's 0.038667; August is 0.055436 versus
0.055513. The joint development screen fails because both months had to improve.
The candidate stops; its frozen code, full-cohort evidence, actual helps/failures
and offline arithmetic audit remain reviewable, with no refit or September data.

## Awash irrigation observation and prediction game

The separate [Awash learning game](docs/AWASH_IRRIGATION_GAME.md) archives small
FAO WaPOR evapotranspiration and precipitation windows near Wonji, Ethiopia.
A history-only persistence prediction was saved and pushed before target
acquisition: 2.9814 versus the next period's FAO estimate of 3.0417 mm/day,
absolute error 0.0603 mm/day. This is one retrospective round using revised
source estimates, not established forecasting skill or measured irrigation.
Native rainfall pixels remain coarse; missing values are not zero-filled.
The research evidence envelope cannot claim verified withdrawals, ecological
improvement or funding eligibility. Run `pnpm irrigation:verify` offline.
The Willamette forecast and operational Oracle/governance remain separate.

## Bounded autonomous source discovery and adversarial evidence

The [autonomous source test](docs/AUTONOMOUS_SOURCE_TEST.md) searches a public
USGS catalog using territory and metric rules, excluding the already-connected
station. It discovers USGS-14182500 without hardcoding that selected identifier,
archives 97 approved oxygen observations, and reproduces the commitment in
separate local verification processes. The existing evidence contract registers
the batch with three of four local test identities; no action or funding follows.

Tampered archives and two isolated malicious attestations are rejected. The
test also demonstrates residual failures: coherent initial publisher falsification,
three colluding authorized attestors, and capture of the enrollment administrator.
The registry now isolates complete candidate envelopes: one malicious first
attestor cannot lock incorrect metadata and block three later concordant votes.
The [contract correction and adversarial test in English](docs/FIRST_ATTESTOR_FIX_EN.md)
and [Italian](docs/FIRST_ATTESTOR_FIX.md) preserve
the original failing report and verify the corrected local behavior.
It does not establish independent operators, physical truth, public-chain
publication, a networked ABCI outage run, or globally autonomous discovery.
After building, run `pnpm source:verify` and `pnpm source:e2e` offline.

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
| `services/autonomy` | Replicated Oracle certification and 3-of-4 proposal bridge |
| `services/ai-advisor` | Local observation-only language advisor with verified citations |
| `services/environmental-case` | Real USGS data review, chronological replay and result reproduction |
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

The health endpoint is `http://localhost:8877/healthz`. Stop the services with
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

## Replica del servizio Oracle

Il [ponte Open Autonomy](services/autonomy/README.md) aggiunge consenso 3-di-4 tra
Oracle replicati e un contratto che presenta proposte reversibili al Governor.
La prova locale spegne un nodo completo e verifica il blocco con due nodi spenti,
mantenendo i diritti delle camere civiche e la protezione della tesoreria.

## AI locale in modalità osservazione

Il [modulo AI advisor](services/ai-advisor/README.md) integra un modello locale
in modalità osservazione: seleziona fatti e citazioni verificabili per spiegare
un assessment e suggerisce un campionamento aggiuntivo oppure si astiene.
Qwen3 1.7B è stato selezionato su una piccola suite sintetica; il rapporto
[di validazione](docs/AI_VALIDATION.md) include anche il modello scartato.
L'advisor non presenta proposte sulla blockchain. Il primo replay numerico su
dati USGS reali è disponibile nel modulo environmental-case e mostra che la
regressione attuale non supera la baseline su quella finestra. Il collegamento
dell'advisory al consenso resta da implementare, come descritto nel
[progetto tecnico](docs/AI_DESIGN.md).

## Esperimento Owasco: protocollo ed esito della regressione locale

Il [protocollo IT/EN della regressione locale LAD](docs/OWASCO_LOCAL_MEDIAN_PROTOCOL_IT_EN.md)
fissa luglio 2020 per l'addestramento e agosto per un solo controllo di sviluppo
dell'ossigeno a un'ora, con MAE contro l'ultima misura come criterio principale.
La PR #20 conservava soltanto il protocollo e i controlli di integrità, senza
addestramento. La successiva PR #21 implementa ed esegue quella ricetta:
il singolo fit su luglio sceglie coefficienti tutti nulli. Su agosto la nuova
candidata coincide con l'ultima misura in tutte le 1.306 righe: MAE identica,
0,055513 mg/L, e guadagno zero. Esito **STOP_CANDIDATE**, senza promozione.
Settembre resta chiuso. Agosto era già stato studiato e non è una validazione
cieca. English explanation and reproducible checks accompany both stages.

L'[implementazione ed esecuzione IT/EN](docs/OWASCO_LOCAL_MEDIAN_EXECUTION_IT_EN.md)
separa il fit di luglio dal successivo controllo su agosto, con provenienza
degli ingressi e audit matematico distinto. Lo stato effettivo e i limiti sono
riportati nelle ricevute e nel documento; il solo passaggio dei test software
non dimostra capacità predittiva sul lago.
