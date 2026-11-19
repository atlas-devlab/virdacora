// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { prepareCase } from "../services/environmental-case/src/case.js";
import { verifyImportedTerritorialBundle } from "../services/environmental-case/src/imported-review.js";
import { captureWillametteSnapshot } from "../services/environmental-case/src/willamette-capture.js";

const usage = "Usage: pnpm --silent territorial:willamette --output <new-directory>";
const execute = promisify(execFile);
const contractsFolder = fileURLToPath(new URL("../packages/contracts/", import.meta.url));
const contractsRequire = createRequire(new URL("../packages/contracts/package.json", import.meta.url));

async function runCapture(outputFolder: string) {
  const policy = await readFile(new URL("../policies/usgs-data-review-v1.terra", import.meta.url));
  const hardhatPackage = contractsRequire.resolve("hardhat/package.json");
  const { bin } = JSON.parse(await readFile(hardhatPackage, "utf8")) as { bin: { hardhat: string } };
  const hardhat = resolve(dirname(hardhatPackage), bin.hardhat);

  await mkdir(dirname(outputFolder), { recursive: true });
  await mkdir(outputFolder);
  const captured = await captureWillametteSnapshot();
  const expectedCase = prepareCase(captured.dataset, policy.toString("utf8"));
  const sourceFolder = resolve(outputFolder, "source");
  await mkdir(sourceFolder);
  await Promise.all([
    writeFile(resolve(sourceFolder, "continuous.json"), captured.continuous, { flag: "wx" }),
    writeFile(resolve(sourceFolder, "station.json"), captured.station, { flag: "wx" }),
    writeFile(resolve(sourceFolder, "policy.terra"), policy, { flag: "wx" }),
  ]);
  await writeFile(resolve(sourceFolder, "manifest.json"), JSON.stringify(captured.manifest, null, 2) + "\n", { flag: "wx" });

  const { stdout } = await execute(process.execPath, [hardhat, "run", "--no-compile", "scripts/territorial-job-e2e.ts"], {
    cwd: contractsFolder,
    windowsHide: true,
    timeout: 180_000,
    env: {
      ...process.env,
      VIRDACORA_TERRITORIAL_DATASET: sourceFolder,
      VIRDACORA_TERRITORIAL_OUTPUT: resolve(outputFolder, "simulation"),
      VIRDACORA_TERRITORIAL_CAPTURE_CASE_HASH: expectedCase.caseHash,
    },
  });

  // Trust the commitment emitted by the successful simulator process, not a
  // hash read from the directory whose contents are about to be verified.
  const matches = [...stdout.matchAll(/^VIRDACORA_TERRITORIAL_CAPTURE_ANCHOR=(0x[0-9a-f]{64})\r?$/gm)];
  const anchor = matches[0]?.[1];
  if (matches.length !== 1 || !anchor) throw new Error("The simulator did not provide one commitment anchor.");
  const verification = await verifyImportedTerritorialBundle(outputFolder, anchor);
  const summary = { completed: true, commitmentsSha256: anchor, verification };
  await writeFile(resolve(outputFolder, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  return { ...summary, outputFolder };
}

async function main() {
  let requestedOutput: string;
  try {
    const { values } = parseArgs({ options: { output: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    if (!values.output?.trim()) throw new Error("A new output directory is required.");
    requestedOutput = resolve(values.output);
  } catch {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const report = await runCapture(requestedOutput);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unexpected error.";
    process.stderr.write(`Willamette territorial run failed. ${reason}\n`);
    process.exitCode = 1;
  }
}

await main();
