import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { PostgresObservationStore } from "../src/postgres-store.js";

export const TEST_DATABASE_ENV = "VIRDACORA_TEST_DATABASE_URL";
export const REQUIRE_DATABASE_ENV = "VIRDACORA_REQUIRE_POSTGRES_TESTS";
const schemaPattern = /^virdacora_test_[a-f0-9]{32}$/;

// No production DATABASE_URL fallback, query-string overrides, or remote servers.
// Messages deliberately omit the supplied value, which may contain a password.
export function validateTestDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${TEST_DATABASE_ENV} is required for real PostgreSQL tests`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${TEST_DATABASE_ENV} must be a valid PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("PostgreSQL tests require the postgres or postgresql URL protocol");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests require an explicit loopback host");
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("PostgreSQL test database name is invalid");
  }
  if (!/^virdacora_test(?:_[a-z0-9]+)?$/.test(database)) {
    throw new Error("PostgreSQL tests require a dedicated virdacora_test database");
  }
  // pg-connection-string can interpret query keys as connection overrides.
  if (url.search !== "" || url.hash !== "") {
    throw new Error("PostgreSQL test URLs must not contain query parameters or fragments");
  }
  return url.toString();
}

export interface PostgresFixture {
  schema: string;
  inspector: Pool;
  initialMigration: string;
  timestampMigration: string;
  migration: string;
  createStore(options?: { readOnly?: boolean }): PostgresObservationStore;
  closeStore(store: PostgresObservationStore): Promise<void>;
  // buildApp owns its store through onClose; replace that store's cleanup here.
  useStoreOwner(store: PostgresObservationStore, closeOwner: () => Promise<unknown>): void;
  close(): Promise<void>;
}

export async function createPostgresFixture(
  baseUrl: string,
  options: { legacySchema?: boolean } = {}
): Promise<PostgresFixture> {
  const validated = validateTestDatabaseUrl(baseUrl);
  const schema = `virdacora_test_${randomBytes(16).toString("hex")}`;
  if (!schemaPattern.test(schema)) throw new Error("Invalid generated test schema");
  const [initialMigration, timestampMigration] = await Promise.all([
    readFile(new URL("../db/001_init.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/002_timestamp_order.sql", import.meta.url), "utf8")
  ]);
  const migration = `${initialMigration}\n${timestampMigration}`;
  const admin = new Pool({ connectionString: validated, max: 1, connectionTimeoutMillis: 5_000,
    options: "-csearch_path=pg_catalog -cstatement_timeout=10000 -clock_timeout=5000" });
  let created = false;
  let closed = false;
  let inspector: Pool | undefined;
  const closers = new Map<PostgresObservationStore, () => Promise<unknown>>();
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const [store, closer] of closers) {
      closers.delete(store);
      try { await closer(); } catch (error) { errors.push(error); }
    }
    if (inspector !== undefined) {
      try { await inspector.end(); } catch (error) { errors.push(error); }
    }
    try {
      if (created) {
        if (!schemaPattern.test(schema)) throw new Error("Refusing unexpected schema cleanup");
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } catch (error) { errors.push(error); }
    try { await admin.end(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "PostgreSQL test cleanup failed");
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const scopedUrl = new URL(validated);
    scopedUrl.searchParams.set("options",
      `-csearch_path=${schema} -cstatement_timeout=10000 -clock_timeout=5000 -cidle_in_transaction_session_timeout=10000`);
    const connectionString = scopedUrl.toString();
    inspector = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
    const scope = await inspector.query<{ schema: string; searchPath: string }>(
      `SELECT current_schema() AS schema, current_setting('search_path') AS "searchPath"`);
    if (scope.rows[0]?.schema !== schema || scope.rows[0]?.searchPath !== schema) {
      throw new Error("PostgreSQL fixture schema isolation was not established");
    }
    await inspector.query(initialMigration);
    if (options.legacySchema !== true) await inspector.query(timestampMigration);
    return {
      schema, inspector, initialMigration, timestampMigration, migration,
      createStore(storeOptions = {}) {
        if (closed) throw new Error("PostgreSQL test fixture is closed");
        const storeUrl = new URL(connectionString);
        if (storeOptions.readOnly === true) {
          // This changes only the new test client's session default. It never
          // alters a database, role, inspector or another fixture's connection.
          storeUrl.searchParams.set("options", `${storeUrl.searchParams.get("options")} -cdefault_transaction_read_only=on`);
        }
        const store = new PostgresObservationStore(storeUrl.toString());
        closers.set(store, () => store.close());
        return store;
      },
      async closeStore(store) {
        const closer = closers.get(store);
        if (closer === undefined) throw new Error("Store is not owned by this fixture");
        closers.delete(store);
        await closer();
      },
      useStoreOwner(store, closeOwner) {
        if (!closers.has(store)) throw new Error("Store is not owned by this fixture");
        closers.set(store, closeOwner);
      },
      close
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "PostgreSQL test setup and cleanup failed");
    }
    throw error;
  }
}
