import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildApp } from "./app.js";
import { PostgresObservationStore } from "./postgres-store.js";
import { registerGracefulShutdown } from "./shutdown.js";
import { MemoryObservationStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const policyPath = resolve(process.env.POLICY_PATH ?? "../../policies/po-water-v1.terra");
const policySource = await readFile(policyPath, "utf8");
const store = process.env.DATABASE_URL
  ? new PostgresObservationStore(process.env.DATABASE_URL)
  : new MemoryObservationStore();

const app = buildApp({
  store,
  policySource,
  adminToken: process.env.ADMIN_API_TOKEN ?? "development-admin-token",
  oracleToken: process.env.ORACLE_API_TOKEN ?? "development-oracle-token"
});

registerGracefulShutdown(app);

await app.listen({ host, port });
console.log(`TerraVoce oracle listening on http://${host}:${port}`);

