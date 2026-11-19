// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { parseArgs } from "node:util";

const usage = "Usage: pnpm --silent territorial:verify-discrete --bundle <directory> --anchor <trusted SHA-256>";

async function main(): Promise<void> {
  let bundle: string;
  let anchor: string;
  try {
    const { values } = parseArgs({ options: {
      bundle: { type: "string" }, anchor: { type: "string" }, help: { type: "boolean" },
    } });
    if (values.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    if (!values.bundle || !values.anchor) throw new Error("Missing bundle directory or trusted anchor.");
    bundle = values.bundle;
    anchor = values.anchor;
  } catch {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const { verifyDiscreteTerritorialBundle } = await import("../services/environmental-case/src/discrete-bundle.js");
    const report = await verifyDiscreteTerritorialBundle(bundle, anchor);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    process.stderr.write(`Discrete territorial verification failed. ${message}\n`);
    process.exitCode = 1;
  }
}

await main();
