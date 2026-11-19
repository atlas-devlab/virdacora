// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const contractsFolder = fileURLToPath(new URL("../packages/contracts/", import.meta.url));
const contractsRequire = createRequire(new URL("../packages/contracts/package.json", import.meta.url));

export async function runTerritorialSimulation(bundle: string, caseHash: string, mode?: "discrete") {
  const hardhatPackage = contractsRequire.resolve("hardhat/package.json");
  const { bin } = JSON.parse(await readFile(hardhatPackage, "utf8")) as { bin: { hardhat: string } };
  const hardhat = resolve(dirname(hardhatPackage), bin.hardhat);
  const { stdout } = await execute(process.execPath, [hardhat, "run", "--no-compile", "scripts/territorial-job-e2e.ts"], {
    cwd: contractsFolder, windowsHide: true, timeout: 180_000,
    env: {
      ...process.env,
      VIRDACORA_TERRITORIAL_MODE: mode,
      VIRDACORA_TERRITORIAL_DATASET: resolve(bundle, "source"),
      VIRDACORA_TERRITORIAL_OUTPUT: resolve(bundle, "simulation"),
      VIRDACORA_TERRITORIAL_CAPTURE_CASE_HASH: caseHash,
    },
  });

  // Obtain the commitment anchor from the successful simulator process, separately
  // from the source and output files that the offline verifier will inspect.
  const matches = [...stdout.matchAll(/^VIRDACORA_TERRITORIAL_CAPTURE_ANCHOR=(0x[0-9a-f]{64})\r?$/gm)];
  const anchor = matches[0]?.[1];
  if (matches.length !== 1 || !anchor) throw new Error("The simulator did not provide one commitment anchor.");
  return anchor;
}
