# Contributing to Virdacora

Virdacora is a research prototype for making environmental data and decisions
traceable and reproducible. Everyone can contribute, in English or Italian.
You do not need to code or be an environmental specialist to ask a question,
share an idea, improve an explanation, translate a paragraph, or try the demo.

## Try the first archived replay

The Willamette example compares forecasts of dissolved oxygen with a baseline
that holds the latest measurement constant. Follow the
[offline review guide](docs/TERRITORIAL_REVIEW_IT_EN.md) to reproduce the
comparison and export the results. The example covers one monitoring station
and one approved archive. You can suggest another public dataset, review the
threshold assumptions or ask about the result in
[issue #3](https://github.com/atlas-devlab/virdacora/issues/3).

## Choose a small first step

| Task | A useful first result |
| --- | --- |
| [Ask a question, try the demo, or improve the walkthrough (#1)](https://github.com/atlas-devlab/virdacora/issues/1) | One unclear step reported, a short explanation or translation, or a reproducible run. |
| [Suggest a dataset or discuss a threshold (#3)](https://github.com/atlas-devlab/virdacora/issues/3) | A link to a public station series, a question about its meaning, or a sourced review of one assumption. |
| [Add a negative policy test (#2)](https://github.com/atlas-devlab/virdacora/issues/2) | For code contributors: one existing rejection rule covered by a meaningful test, preserving the valid demo policy hash. |

The repository is public. Agree access with the maintainer first.
Once access is available, check the issue for ongoing work. You can fork the repository, create a branch,
and open a focused pull request without being assigned first. An issue comment
is helpful for coordination, but assignment is not a prerequisite for a small
contribution. Open a proposal before a substantial architecture or grammar
change. Explain the problem, an example, and how the result would be verified.

Questions and ideas can stay in an issue; they do not need a pull request.

**Puoi partecipare anche senza saper programmare:** una domanda, un'idea, una
traduzione o una prova della demo sono già contributi utili.

## Development

Use Node.js 24 or later and pnpm 11.7.0. From the root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm e2e
```

The end-to-end demonstration runs on Hardhat's simulated local blockchain.
Use generated identities, synthetic observations and valueless test tokens.
Keep funded wallets, API credentials, sensor identities and personal data out
of commits, logs and issues. Do not commit generated builds or dependencies.

## Validation criteria for a new replay

Document the dataset's source, license, units, timestamps, station metadata,
measurement quality flags, and missing values. Choose a fixed forecast horizon
and use chronological evaluation without using future data in an earlier
prediction. Compare the current model with a persistence baseline: the latest
measurement becomes the prediction for the chosen horizon.

Report prediction errors and, under an explicitly stated oxygen threshold,
false alerts and missed low-oxygen events. Explain the limitations of the data
and threshold. The deliverable is complete when another person can reproduce
the comparison and error report from a documented command. Scientific claims
need supporting evidence and review; a successful replay alone does not
establish field validity or authorize an intervention.

## Pull requests

The CI workflow runs the build, checks, tests and local demonstrations on pushes
to `main` and pull requests. GitHub may require maintainer approval for a first
contribution from a fork. Passing checks support human review; they do not
establish scientific validity or automatically merge a contribution.

- Describe the concrete behavior before and after the change.
- Keep one coherent change per pull request.
- Add meaningful regression tests when behavior changes.
- Report the commands you ran and any verification you could not complete.
- Preserve deterministic policy evaluation and existing governance boundaries.
- Distinguish simulation results from field validation or an independent audit.

For credential exposure or a security issue that could affect real deployments,
use GitHub's private vulnerability reporting when enabled. Otherwise agree a
private channel with the maintainer before sharing sensitive details.

## License

New contributions use `PolyForm-Noncommercial-1.0.0` unless the affected file
has a specific MIT, Apache-2.0 or other notice. Preserve applicable terms and
attribution. Discuss any change to a file's license with the maintainer. Submit
only material you can license under the applicable terms. Contributors retain
copyright in their contributions. See
[LICENSE_POLICY.md](LICENSE_POLICY.md) and [TRADEMARK_POLICY.md](TRADEMARK_POLICY.md).
