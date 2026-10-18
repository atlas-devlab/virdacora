import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { MemoryObservationStore, type StoredObservation } from "../services/oracle/src/store.js";

interface StoreUnderTest {
  addObservation(entry: StoredObservation): Promise<void>;
  listObservations(regionId: string, metric: string, limit: number): Promise<StoredObservation[]>;
}

// Retains the previous memory-store insertion/query algorithm as the comparison baseline.
class PreviousMemoryStore implements StoreUnderTest {
  private readonly observations = new Map<`0x${string}`, StoredObservation>();
  private readonly sequenceKeys = new Set<string>();

  public async addObservation(entry: StoredObservation): Promise<void> {
    const sequenceKey = `${entry.observation.sensorId}:${entry.observation.sequence}`;
    if (this.observations.has(entry.observationId) || this.sequenceKeys.has(sequenceKey)) {
      throw new Error("observation replay detected");
    }
    this.observations.set(entry.observationId, entry);
    this.sequenceKeys.add(sequenceKey);
  }

  public async listObservations(regionId: string, metric: string, limit: number): Promise<StoredObservation[]> {
    return [...this.observations.values()]
      .filter(({ observation }) => observation.regionId === regionId && observation.metric === metric)
      .sort((left, right) => {
        const time = Date.parse(left.observation.observedAt) - Date.parse(right.observation.observedAt);
        if (time !== 0) return time;
        return left.observationId.localeCompare(right.observationId);
      }).slice(-limit);
  }
}

const defaults = { rows: 100_000, regions: 100, "read-samples": 100, "write-samples": 5, seed: 4_125_131 };
const config = { ...defaults };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]?.replace(/^--/, "") as keyof typeof defaults;
  const value = Number(args[index + 1]);
  if (!Object.hasOwn(defaults, name) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("usage: benchmark-oracle-store.ts [--rows N] [--regions N] [--read-samples N] [--write-samples N] [--seed N]");
  }
  config[name] = value;
}
if (config.rows < config.regions || config["read-samples"] < 20 || config["write-samples"] < 5 || config.seed > 0xffffffff) {
  throw new Error("rows must cover all regions, read-samples >= 20, write-samples >= 5, seed <= 2^32-1");
}

const metric = "water.oxygen.mg_l";
const limit = 512;
const corpus: StoredObservation[] = Array.from({ length: config.rows }, (_, index) => ({
  observationId: `0x${index.toString(16).padStart(64, "0")}`,
  observation: {
    sensorId: `synthetic-sensor-${index % config.regions}`,
    regionId: `synthetic-region-${index % config.regions}`,
    metric, value: 5 + (index % 10) / 10, unit: "mg/L",
    observedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(index / (config.regions * 4)) * 1000).toISOString(),
    sequence: index, signature: "YQ=="
  }
}));

const shuffle = (rows: StoredObservation[]): StoredObservation[] => {
  const result = [...rows];
  let state = config.seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
};

const summary = (samples: number[]) => {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: sorted.length,
    medianMs: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    minimumMs: sorted[0]!, maximumMs: sorted[sorted.length - 1]!
  };
};
const fill = async (store: StoreUnderTest, rows: StoredObservation[]): Promise<number> => {
  const start = performance.now();
  for (const row of rows) await store.addObservation(row);
  return performance.now() - start;
};

const scenarios = [];
// Warm both insertion implementations on a smaller synthetic set before measuring.
await fill(new PreviousMemoryStore(), corpus.slice(0, 1000));
await fill(new MemoryObservationStore(), corpus.slice(0, 1000));
for (const [arrivalOrder, rows] of [["chronological", corpus], ["shuffled", shuffle(corpus)]] as const) {
  const writes = { previous: [] as number[], indexed: [] as number[] };
  let previous: StoreUnderTest = new PreviousMemoryStore();
  let indexed: StoreUnderTest = new MemoryObservationStore();
  for (let trial = 0; trial < config["write-samples"]; trial += 1) {
    previous = new PreviousMemoryStore();
    indexed = new MemoryObservationStore();
    if (trial % 2 === 0) {
      writes.previous.push(await fill(previous, rows));
      writes.indexed.push(await fill(indexed, rows));
    } else {
      writes.indexed.push(await fill(indexed, rows));
      writes.previous.push(await fill(previous, rows));
    }
  }
  // Verify the complete returned payload, not just row counts, for every region.
  for (let region = 0; region < config.regions; region += 1) {
    const key = `synthetic-region-${region}`;
    if (!isDeepStrictEqual(await previous.listObservations(key, metric, limit), await indexed.listObservations(key, metric, limit))) {
      throw new Error(`query equivalence failed in ${arrivalOrder}, region ${region}`);
    }
  }
  for (let trial = 0; trial < 20; trial += 1) {
    const key = `synthetic-region-${trial % config.regions}`;
    await previous.listObservations(key, metric, limit);
    await indexed.listObservations(key, metric, limit);
  }
  const reads = { previous: [] as number[], indexed: [] as number[] };
  let rowsReturned = 0;
  for (let trial = 0; trial < config["read-samples"]; trial += 1) {
    const key = `synthetic-region-${trial % config.regions}`;
    for (const name of (trial % 2 === 0 ? ["previous", "indexed"] : ["indexed", "previous"]) as (keyof typeof reads)[]) {
      const start = performance.now();
      const result = await (name === "previous" ? previous : indexed).listObservations(key, metric, limit);
      reads[name].push(performance.now() - start);
      rowsReturned += result.length;
    }
  }
  const previousRead = summary(reads.previous);
  const indexedRead = summary(reads.indexed);
  const previousWrite = summary(writes.previous);
  const indexedWrite = summary(writes.indexed);
  scenarios.push({
    arrivalOrder,
    queryPayloadsEqualForAllRegions: true,
    rowsReturnedAcrossBothImplementations: rowsReturned,
    reads: { previous: previousRead, indexed: indexedRead,
      medianSpeedupPreviousOverIndexed: previousRead.medianMs / indexedRead.medianMs,
      p95SpeedupPreviousOverIndexed: previousRead.p95Ms / indexedRead.p95Ms },
    wholeCorpusWrites: { previous: previousWrite, indexed: indexedWrite,
      medianTimeRatioIndexedOverPrevious: indexedWrite.medianMs / previousWrite.medianMs,
      p95TimeRatioIndexedOverPrevious: indexedWrite.p95Ms / previousWrite.p95Ms }
  });
}

console.log(JSON.stringify({
  schemaVersion: "oracle-memory-store-synthetic-benchmark-v1",
  completedAtUTC: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  syntheticOnly: true, config: { ...config, queryLimit: limit },
  methodology: {
    fixture: "Identical deterministic synthetic payloads, including timestamp ties, for both implementations.",
    baseline: "Previous insertion/full-scan/filter/sort/tail implementation retained inline; no snapshot copies.",
    timing: "performance.now; alternating implementation order; read samples are one query each; write samples are one complete corpus insertion each.",
    p95: "Nearest-rank p95. Five default write samples make that p95 the largest sample, not a stable service tail estimate.",
    garbageCollection: "Not forced; timings may include allocation and garbage-collection noise.",
    scope: "Local memory-store operations only; excludes HTTP, signature verification, PostgreSQL, blockchain and forecasting.",
    tradeoff: "Snapshot copies and an additional per-series timestamp index add allocations. Appends are fast; binary search for late arrivals still needs O(series length) array shifting. All observations remain retained, without a memory cap."
  },
  scenarios
}, null, 2));
