import { DomainError } from "./errors.js";

// Date.parse is the ordering contract: epoch milliseconds, with fractional
// digits after the third ignored rather than rounded. Signed text is untouched.
export const timestampMilliseconds = (value: string): number => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new DomainError("timestamp must resolve to finite epoch milliseconds", 422, "INVALID_TIME");
  }
  return milliseconds;
};

// IDs are protocol ASCII hexadecimal strings. Never depend on a host locale.
export const compareIdsASCII = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareTimestampKeys = (
  leftMilliseconds: number,
  leftId: string,
  rightMilliseconds: number,
  rightId: string
): number => {
  const time = leftMilliseconds - rightMilliseconds;
  return time === 0 ? compareIdsASCII(leftId, rightId) : time;
};
