// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parse } from "csv-parse/sync";

export interface StationWindow {
  stationId: string;
  start: string;
  end: string;
}

export interface WaterOxygenReading {
  stationId: string;
  stationName: string | null;
  seriesId: string | null;
  activityId: string | null;
  recordId: string | null;
  organization: string | null;
  observedAtUtc: string | null;
  reportedTime: { date: string | null; time: string | null; zone: string | null } | null;
  valueText: string | null;
  unit: string | null;
  valueMgL: number | null;
  status: string | null;
  qualifiers: string[];
  detectionCondition: string | null;
}

export interface OxygenSourceBatch {
  schema: "virdacora-oxygen-source-v1";
  provider: "usgs" | "wqp" | "water-rangers";
  sourceUrl: string;
  termsUrl: string;
  attribution: string | null;
  retrievedAt: string | null;
  sourceSha256: string;
  inputRows: number;
  readings: WaterOxygenReading[];
}

const maxSourceBytes = 8 * 1024 * 1024;
const maxCsvRecords = 20_000;
const dayMilliseconds = 86_400_000;

function dateStart(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Dates must use YYYY-MM-DD.");
  const start = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid calendar date.");
  }
  return start;
}

export function validateStationWindow({ stationId, start, end }: StationWindow): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,95}$/i.test(stationId)) throw new Error("Invalid monitoring station identifier.");
  const span = dateStart(end) - dateStart(start);
  if (span < 0 || span >= 31 * dayMilliseconds) throw new Error("Choose a window of 1 to 31 calendar days.");
}

export function normalizeOxygenValue(valueText: string | null, unit: string | null): number | null {
  const text = valueText?.trim();
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  const normalized = unit?.trim().toLowerCase().replaceAll("μ", "µ");
  if (normalized === "mg/l") return value;
  if (normalized === "µg/l" || normalized === "ug/l") return value / 1000;
  return null;
}

export function decodeSource(bytes: Uint8Array) {
  if (bytes.byteLength > maxSourceBytes) throw new Error("The source exceeds the 8 MiB limit.");
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

export async function readProviderResponse(url: URL, fetchImpl: typeof fetch, options: RequestInit = {}) {
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(url, { ...options, redirect: "error", signal });
  if (response.status !== 200 || Number(response.headers.get("content-length")) > maxSourceBytes || !response.body) {
    await response.body?.cancel();
    if (response.status !== 200) throw new Error(`The data provider returned HTTP ${response.status}.`);
    throw new Error("The provider response is empty or exceeds the 8 MiB limit.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > maxSourceBytes) {
        await reader.cancel();
        throw new Error("The provider response exceeds the 8 MiB limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return decodeSource(Buffer.concat(chunks, total));
}

export async function readLocalSourceCsv(path: string) {
  if (path === "-" || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^[/\\]{2}/.test(path)) {
    throw new Error("Choose a local CSV file.");
  }
  const before = await lstat(path);
  if (!before.isFile() || before.size > maxSourceBytes) throw new Error("Choose a local CSV file of at most 8 MiB.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > maxSourceBytes || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Choose a local CSV file of at most 8 MiB.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxSourceBytes - total + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxSourceBytes) throw new Error("The local CSV exceeds the 8 MiB limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

export function parseSourceCsv(text: string, requiredHeaders: string[]): Record<string, string>[] {
  let hasHeader = false;
  let rowCount = 0;
  const records = parse(text, {
    bom: true, skip_empty_lines: true, max_record_size: 64 * 1024,
    columns(header: string[]) {
      hasHeader = true;
      if (new Set(header).size !== header.length || header.some(key => key === "__proto__")) {
        throw new Error("The CSV contains duplicate or invalid column names.");
      }
      for (const name of requiredHeaders) {
        if (!header.includes(name)) throw new Error(`The CSV is missing the required column ${name}.`);
      }
      return header;
    },
    on_record(record: Record<string, string>) {
      rowCount += 1;
      if (rowCount > maxCsvRecords) throw new Error("The CSV exceeds the 20,000-row limit.");
      return record;
    },
  }) as Record<string, string>[];
  if (!hasHeader) throw new Error("The response does not contain a CSV header.");
  return records;
}
