import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REQUIRE_DATABASE_ENV, TEST_DATABASE_ENV, validateTestDatabaseUrl
} from "../services/oracle/test/postgres-fixture.js";

try {
  validateTestDatabaseUrl(process.env[TEST_DATABASE_ENV]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid PostgreSQL test configuration");
  process.exit(1);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const reportDirectory = fileURLToPath(new URL("../outputs/postgres-integration/", import.meta.url));
const reportFile = fileURLToPath(new URL("../outputs/postgres-integration/results.json", import.meta.url));
mkdirSync(reportDirectory, { recursive: true });
const result = spawnSync(process.execPath, [vitest, "run",
  "services/oracle/src/postgres.integration.test.ts", "--reporter=verbose", "--reporter=json",
  `--outputFile.json=${reportFile}`], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: { ...process.env, [REQUIRE_DATABASE_ENV]: "1" }
});
if (result.error !== undefined) {
  console.error("Unable to start the PostgreSQL integration test process");
  process.exit(1);
}
process.exit(result.status ?? 1);
