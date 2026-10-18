import { afterEach, describe, expect, it, vi } from "vitest";

import { TEST_DATABASE_ENV, validateTestDatabaseUrl } from "../test/postgres-fixture.js";

const secret = "do-not-print-test-password-93";
const local = (database: string, suffix = "") =>
  `postgresql://test-user:${secret}@127.0.0.1:55432/${database}${suffix}`;

afterEach(() => vi.unstubAllEnvs());

describe("real PostgreSQL test configuration boundary", () => {
  it("requires the explicit test URL even if production DATABASE_URL exists", () => {
    vi.stubEnv("DATABASE_URL", local("virdacora_test"));
    vi.stubEnv(TEST_DATABASE_ENV, undefined);
    expect(() => validateTestDatabaseUrl(process.env[TEST_DATABASE_ENV]))
      .toThrow(`${TEST_DATABASE_ENV} is required`);
  });

  it.each([undefined, "", " ", "\t\n"])("rejects a missing or blank URL: %j", value => {
    expect(() => validateTestDatabaseUrl(value)).toThrow(`${TEST_DATABASE_ENV} is required`);
  });

  it.each([
    "postgres://test-user@127.0.0.1/virdacora_test",
    "postgresql://test-user@localhost:55432/virdacora_test_ci",
    "postgresql://test-user@[::1]:55432/virdacora_test_20261018",
    local("virdacora_test"),
    local("virdacora_test_local42")
  ].map((value, index) => ({ value, caseNumber: index + 1 })))
    ("accepts an explicit loopback host and dedicated test database (case $caseNumber)", ({ value }) => {
    const validated = new URL(validateTestDatabaseUrl(value));
    expect(["postgres:", "postgresql:"]).toContain(validated.protocol);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(validated.hostname);
    expect(validated.search).toBe("");
    expect(validated.hash).toBe("");
    expect(decodeURIComponent(validated.pathname.slice(1)))
      .toMatch(/^virdacora_test(?:_[a-z0-9]+)?$/);
  });

  const rejected = [
    local("postgres"),
    local("template1"),
    local("virdacora"),
    local("virdacora_production"),
    local("virdacora_test_backup/other"),
    local("virdacora_test%2Fother"),
    local("virdacora_test%ZZ"),
    local("VIRDACORA_TEST"),
    `postgresql://test-user:${secret}@db.example.com/virdacora_test`,
    `postgresql://test-user:${secret}@localhost.example.com/virdacora_test`,
    `postgresql://test-user:${secret}@0.0.0.0/virdacora_test`,
    `postgresql://test-user:${secret}@192.0.2.1/virdacora_test`,
    `https://test-user:${secret}@127.0.0.1/virdacora_test`,
    `file:///virdacora_test#${secret}`,
    `not a URL ${secret}`,
    local("virdacora_test", "?host=remote.example.com"),
    local("virdacora_test", "?hostaddr=192.0.2.1"),
    local("virdacora_test", "?%68ost=remote.example.com"),
    local("virdacora_test", "?database=production"),
    local("virdacora_test", "?dbname=production"),
    local("virdacora_test", "?user=superuser"),
    local("virdacora_test", "?password=replaced"),
    local("virdacora_test", "?port=5432"),
    local("virdacora_test", "?options=-csearch_path%3Dpublic"),
    local("virdacora_test", "?sslmode=disable"),
    local("virdacora_test", "#ignored"),
    local("virdacora_test", "#host=remote.example.com")
  ];

  it.each(rejected.map((value, index) => ({ value, caseNumber: index + 1 })))
    ("rejects unsafe destination or connection override (case $caseNumber) without exposing secrets", ({ value }) => {
      let caught: unknown;
      try {
        validateTestDatabaseUrl(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain(value);
    });
});
