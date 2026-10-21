import { describe, expect, it } from "vitest";

import { evidenceReadTokenFromEnv, validateEvidenceReadToken, type OracleCredentials } from "./auth.js";

const adminToken = "synthetic-admin-private-marker-32-bytes";
const oracleToken = "synthetic-oracle-private-marker-32-bytes";
const reader = "synthetic-reader-private-marker-32-bytes";
const credentials = { adminToken, oracleToken };

describe("optional evidence reader configuration", () => {
  it("disables the environment role only when unset or exactly empty, without a fallback credential", () => {
    expect(evidenceReadTokenFromEnv(undefined)).toBeUndefined();
    expect(evidenceReadTokenFromEnv("")).toBeUndefined();
    expect(() => validateEvidenceReadToken(credentials)).not.toThrow();
  });

  it("preserves configured bytes rather than silently trimming them", () => {
    expect(evidenceReadTokenFromEnv(reader)).toBe(reader);
    expect(evidenceReadTokenFromEnv(` ${reader}`)).toBe(` ${reader}`);
    expect(evidenceReadTokenFromEnv(" ")).toBe(" ");
  });

  it("accepts distinct visible ASCII credentials at both length boundaries", () => {
    for (const token of ["!".repeat(32), "~".repeat(256), reader]) {
      expect(() => validateEvidenceReadToken({ ...credentials, evidenceReadToken: token })).not.toThrow();
    }
  });

  it.each([
    { name: "explicit empty app credential", token: "" },
    { name: "too short", token: "x".repeat(31) },
    { name: "too long", token: "x".repeat(257) },
    { name: "leading space", token: ` ${reader}` },
    { name: "internal space", token: `${reader} ${reader}` },
    { name: "tab", token: `${reader}\t` },
    { name: "final newline", token: `${reader}\n` },
    { name: "CRLF", token: `${reader}\r\n` },
    { name: "control character", token: `${reader}\0` },
    { name: "DEL", token: `${reader}\x7f` },
    { name: "non-ASCII", token: `${reader}\u00e9` },
    { name: "admin collision", token: adminToken },
    { name: "oracle collision", token: oracleToken },
    { name: "runtime null", token: null },
    { name: "runtime array", token: [reader] }
  ])("rejects $name with a static error containing no credential bytes", ({ token }) => {
    let caught: unknown;
    try {
      validateEvidenceReadToken({ ...credentials, evidenceReadToken: token } as OracleCredentials);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("invalid evidence read token configuration");
    for (const secret of [adminToken, oracleToken, reader]) expect((caught as Error).message).not.toContain(secret);
  });
});
