import { timingSafeEqual } from "node:crypto";

export interface OracleCredentials {
  adminToken: string;
  oracleToken: string;
  evidenceReadToken?: string;
}

export const tokenMatches = (provided: unknown, expected: string): boolean => {
  if (typeof provided !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

// An unset/empty environment variable disables this optional role. Do not trim
// other values into a different credential or substitute a development secret.
export const evidenceReadTokenFromEnv = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

export const validateEvidenceReadToken = (credentials: OracleCredentials): void => {
  const token = credentials.evidenceReadToken;
  if (token === undefined) return;
  // ASCII makes configuration portable to HTTP headers. Length is a format
  // constraint, not a test of randomness; operators must generate random bytes.
  if (typeof token !== "string" || token.length < 32 || token.length > 256 || /[^!-~]/.test(token) ||
      token === credentials.adminToken || token === credentials.oracleToken) {
    throw new Error("invalid evidence read token configuration");
  }
};
