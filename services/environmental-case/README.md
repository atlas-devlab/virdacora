# Territorial archived-data review

This package connects one real historical USGS dataset to the existing Oracle,
policy and local civic/escrow demonstration. It is a module of Virdacora's original
mission: verifiable environmental evidence, bounded action, accountable work and
decision rights for affected communities and young people.

`dataset.ts`, `replay.ts` and `case.ts` reuse the research importer and deterministic
case. `territorial-review.ts` adds the payment-review boundary: reload original
archive bytes for every review, reproduce the funded case, bind the exact submitted
result hash and compare the complete delivery. The caller must obtain the trusted
case/result commitments from the escrow; the helper does not authenticate a chain.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @terravoce/environmental-case test
pnpm territorial:check
pnpm territorial:e2e
```

The first run writes `outputs/territorial-job`. That directory must not already
exist. For a subsequent PowerShell run, set a new local evidence directory:

```powershell
$env:VIRDACORA_TERRITORIAL_OUTPUT = Join-Path $PWD 'outputs/territorial-job-next'
pnpm territorial:e2e
```

The runner does not contact an environmental API, start a public RPC, load a real
wallet or use an LLM. It deploys a local mock token (actual fixture symbol TUSD;
the job labels its valueless units TEST), governance, bridge and escrow. It checks
positive, altered and insufficient deliveries and saves source/case commitments,
candidate documents, fresh-review results, stages, exact balances and transaction
receipts. Local transaction hashes are not public explorer links.

The current archival numerical version is the existing
`terravoce-linear-risk-v2-oxygen-units`; original observations, numeric results,
policy and forecast method are preserved. Versioned IDs differ from the earlier
v1 research receipt, which remains historical evidence. See the compatibility
erratum for the first run's corrected summary-label issue.

The reviewers and civic identities are simulated in one process. Hashes and
importer signatures do not establish physical truth, calibration, independently
operated reviewers, water safety or environmental restoration. No compensation
is paid for falsely claiming such outcomes. The two chambers govern this example;
holding an ENV token grants no environmental vote.

See [the frozen criteria](../../docs/TERRITORIAL_JOB_PROTOCOL_IT_EN.md),
[the executed walkthrough](../../docs/TERRITORIAL_JOB_RESULTS_IT_EN.md) and
[the archived USGS manifest](../../docs/datasets/usgs-willamette/manifest.json).
