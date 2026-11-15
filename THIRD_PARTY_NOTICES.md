# Third-party notices

Virdacora uses external packages installed by pnpm. Their license and copyright
notices remain applicable. The exact dependency versions and integrity hashes
are recorded in `pnpm-lock.yaml`.

Direct runtime dependencies include OpenZeppelin Contracts, Zod, Chevrotain,
Fastify and node-postgres. Development tools include Hardhat and its toolbox,
TypeScript, tsx and Vitest. Read the license files distributed with the installed
packages before redistributing them.

Docker uses Node.js and PostgreSQL base images, whose components retain their
respective licenses. These images and dependency source trees are not vendored
in this repository.

The MIT SPDX headers in the project Solidity contracts have been preserved.
The original project MIT notice is retained in [LICENSES/MIT-legacy.txt](LICENSES/MIT-legacy.txt);
those permissions are not revoked by the new default AGPL source license.
The recovered philosophical research downloads, build outputs, local runtime
data and tooling archives are excluded from this source publication.

## Archived USGS environmental data

`docs/datasets/usgs-willamette` contains the previously captured U.S. Geological
Survey Water Data for the Nation oxygen observations for station `USGS-14211720`,
2025-08-01 through 2025-08-15 UTC. The retained manifest records the exact source
and station URLs, retrieval time and hashes. Its source terms are recorded as
`US Government work; public domain`; those data do not acquire the project's
AGPL source-code license. Attribution does not imply USGS endorsement or a
producer signature. Upstream data can be revised; this run uses the archived
snapshot and performs no new environmental acquisition.
