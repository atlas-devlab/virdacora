import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { oracleHttpContractScenario } from "../test/architecture-scenario.js";

it("preserves the pre-refactor public HTTP responses, exact signed packets and analytical hashes", async () => {
  const baseline = JSON.parse(await readFile(new URL("../test/fixtures/oracle-http-baseline.json", import.meta.url), "utf8")) as unknown;
  expect(await oracleHttpContractScenario()).toEqual(baseline);
});
