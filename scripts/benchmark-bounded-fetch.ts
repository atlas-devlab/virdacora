import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fetchBoundedUSGSJSON, USGS_RESPONSE_MAX_BYTES } from "../services/environmental-case/src/bounded-fetch.js";

const URL = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items?synthetic-benchmark=1";
const BODY_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const ITERATIONS = 3;

// The prior CLI implementation, retained only as the local benchmark baseline.
async function previousResponseText(url: string): Promise<string> {
  if (new globalThis.URL(url).origin !== "https://api.waterdata.usgs.gov") throw new Error("Untrusted fetch origin");
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
  const raw = await response.text();
  if (raw.length > 10_000_000) throw new Error("Source response exceeds size limit");
  return raw;
}

function oversizedFixture() {
  const work = { producedBytes: 0, producedChunks: 0, cancelled: 0, ended: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (work.producedBytes === BODY_BYTES) { work.ended = true; controller.close(); return; }
      const size = Math.min(CHUNK_BYTES, BODY_BYTES - work.producedBytes);
      const chunk = Buffer.alloc(size, 0x78);
      // A valid JSON string, generated as needed rather than preallocated.
      if (work.producedBytes === 0) chunk[0] = 0x22;
      if (work.producedBytes + size === BODY_BYTES) chunk[size - 1] = 0x22;
      work.producedBytes += size;
      work.producedChunks++;
      controller.enqueue(chunk);
    },
    cancel() { work.cancelled++; }
  }, { highWaterMark: 0 });
  return { work, response: new Response(body, { headers: { "content-type": "application/json" } }) };
}

async function measure(implementation: "previous-response-text" | "bounded-fetch", round: number) {
  const fixture = oversizedFixture();
  const originalFetch = globalThis.fetch;
  // No request can leave this process: both implementations receive this stream.
  globalThis.fetch = async () => fixture.response;
  let error: string | null = null;
  const start = performance.now();
  try {
    await (implementation === "bounded-fetch" ? fetchBoundedUSGSJSON(URL) : previousResponseText(URL));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const durationMs = performance.now() - start;
  if (error === null || !error.includes(implementation === "bounded-fetch" ? "byte limit" : "size limit")) {
    throw new Error(`Benchmark implementation did not reject the intended oversize body: ${error}`);
  }
  if (implementation === "bounded-fetch" &&
      (fixture.work.producedBytes > USGS_RESPONSE_MAX_BYTES + CHUNK_BYTES || fixture.work.cancelled !== 1)) {
    throw new Error("Bounded benchmark consumed too much work or failed cancellation");
  }
  if (implementation === "previous-response-text" && fixture.work.producedBytes !== BODY_BYTES) {
    throw new Error("Previous benchmark did not consume the complete baseline body");
  }
  return { implementation, round, durationMs, rejected: true, error, ...fixture.work };
}

async function checkValidFixture() {
  const raw = JSON.stringify({ fixture: "synthetic-only", text: "comunità 🌿".repeat(128) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from(raw), { headers: { "content-type": "application/json" } });
  try {
    const previous = await previousResponseText(URL), bounded = await fetchBoundedUSGSJSON(URL);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    if (previous !== raw || bounded !== raw) throw new Error("Valid synthetic body changed");
    return { bytes: Buffer.byteLength(raw), rawSha256: digest(raw), previousSha256: digest(previous), boundedSha256: digest(bounded), exactMatch: true };
  } finally { globalThis.fetch = originalFetch; }
}

const validFixture = await checkValidFixture();
await measure("previous-response-text", 0);
await measure("bounded-fetch", 0);
const runs = [];
for (let round = 1; round <= ITERATIONS; round++) {
  // Alternate order: elapsed time remains illustrative local fixture evidence.
  const order = round % 2 === 1 ? ["previous-response-text", "bounded-fetch"] as const : ["bounded-fetch", "previous-response-text"] as const;
  for (const implementation of order) runs.push(await measure(implementation, round));
}
const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!;
const summary = Object.fromEntries((["previous-response-text", "bounded-fetch"] as const).map(implementation => {
  const selected = runs.filter(run => run.implementation === implementation);
  return [implementation, {
    measuredRuns: selected.length,
    medianDurationMs: median(selected.map(run => run.durationMs)),
    producedBytesEveryRun: [...new Set(selected.map(run => run.producedBytes))],
    producedChunksEveryRun: [...new Set(selected.map(run => run.producedChunks))]
  }];
}));
const boundedBytes = runs.find(run => run.implementation === "bounded-fetch")!.producedBytes;
console.log(JSON.stringify({
  version: "bounded-usgs-transport-fixture-benchmark-v1",
  recordedAtUTC: new Date().toISOString(),
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  usesNetwork: false,
  environmentalDataOpened: false,
  byteBoundary: USGS_RESPONSE_MAX_BYTES,
  syntheticBodyBytes: BODY_BYTES,
  chunkBytes: CHUNK_BYTES,
  warmupRunsPerImplementation: 1,
  validFixture,
  runs,
  summary,
  syntheticWorkAvoidedBytes: BODY_BYTES - boundedBytes,
  syntheticWorkAvoidedPercent: (BODY_BYTES - boundedBytes) / BODY_BYTES * 100,
  limitation: "Synthetic local stream with highWaterMark zero; elapsed times depend on machine and allocation history. This is not a remote-service speed, peak-memory or forecast-quality benchmark. One upstream chunk can exceed the remaining byte budget; it is rejected before being retained."
}, null, 2));
