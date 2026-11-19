# Third-party notices

Virdacora uses external packages installed by pnpm. Their license and copyright
notices remain applicable. The exact dependency versions and integrity hashes
are recorded in `pnpm-lock.yaml`.

Direct runtime dependencies include OpenZeppelin Contracts, Zod, Chevrotain,
Fastify, node-postgres and `csv-parse`. Development tools include Hardhat and
its toolbox, TypeScript, tsx and Vitest. Read the license files distributed with
the installed packages before redistributing them.

`csv-parse` is distributed under MIT. Its package includes the copyright
notice for Adaltas and the full license text.

Docker uses Node.js and PostgreSQL base images, whose components retain their
respective licenses. These images and dependency source trees are not vendored
in this repository.

The MIT SPDX headers in the project Solidity contracts have been preserved.
The original project MIT notice remains available in
[LICENSES/MIT-legacy.txt](LICENSES/MIT-legacy.txt). For the historical MIT and
AGPL snapshots, see [LICENSE_POLICY.md](LICENSE_POLICY.md).
The recovered philosophical research downloads, build outputs, local runtime
data and tooling archives are excluded from this source publication.

## Archived USGS environmental data

`docs/datasets/usgs-willamette` contains the previously captured U.S. Geological
Survey Water Data for the Nation oxygen observations for station `USGS-14211720`,
2025-08-01 through 2025-08-15 UTC. The retained manifest records the exact source
and station URLs, retrieval time and hashes. Its source terms are recorded as
`US Government work; public domain`. These terms also apply to USGS observations
reproduced in project evidence records. Attribution does not imply USGS endorsement
or a producer signature. Upstream data can be revised. This run uses the archived
snapshot and performs no new environmental acquisition.

## External water-data sources

The on-demand source command records the origin and attribution with each
batch. Credit the U.S. Geological Survey for USGS-produced data under its
[copyright and credit guidance](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits).
For Water Quality Portal, retain the submitting organization and include the
[portal citation](https://waterqualitydata.us/beta/portal_userguide/#cite-the-water-quality-portal).
Consult the originating organization's terms for the selected results.

Water Rangers datasets available for download come with a dataset-specific
attribution and the [Open Data Commons Attribution License](https://opendatacommons.org/licenses/by/1-0/).
Keep that attribution with any reused export. See the
[Water Rangers data sharing guide](https://data.waterrangers.com/api/faq).
