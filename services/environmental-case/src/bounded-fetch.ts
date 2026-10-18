import { TextDecoder } from "node:util";

export const USGS_RESPONSE_MAX_BYTES = 10_000_000;
export const USGS_RESPONSE_TIMEOUT_MS = 30_000;

export interface BoundedUSGSOptions {
  /** Callers may tighten, but never exceed, the acquisition boundary. */
  maxBytes?: number;
  timeoutMs?: number;
}

function withinBoundary(value: number, ceiling: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`Invalid USGS ${name}`);
  }
  return value;
}

/** Race the entire operation against one deadline, including a stalled body. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); }
    );
    if (signal.aborted) aborted();
  });
}

/** Start cleanup without extending the request deadline on a stalled peer. */
function cancelBody(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
  if (body) void body.cancel(reason).catch(() => {});
}

/**
 * Fetch future USGS snapshots without buffering an unbounded publisher body.
 * The byte budget applies to the body exposed by fetch (after HTTP decoding).
 * This validates JSON media type and exact UTF-8, while JSON/schema validation
 * remains the dataset validator's job. No retries or historical fallback occur.
 */
export async function fetchBoundedUSGSJSON(url: string, options: BoundedUSGSOptions = {}): Promise<string> {
  const destination = new URL(url);
  if (destination.origin !== "https://api.waterdata.usgs.gov" ||
      destination.username || destination.password || destination.hash) {
    throw new Error("Untrusted fetch origin or URL credentials/fragment");
  }
  const maxBytes = withinBoundary(options.maxBytes ?? USGS_RESPONSE_MAX_BYTES, USGS_RESPONSE_MAX_BYTES, "byte budget");
  const timeoutMs = withinBoundary(options.timeoutMs ?? USGS_RESPONSE_TIMEOUT_MS, USGS_RESPONSE_TIMEOUT_MS, "timeout");
  const controller = new AbortController();
  const timeout = new Error(`USGS response timed out after ${timeoutMs} ms`);
  timeout.name = "TimeoutError";
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pendingResponse = fetch(destination, { signal: controller.signal, redirect: "error" }).then(value => {
      // Also dispose of a late response from a transport that ignores abortion.
      if (controller.signal.aborted) {
        cancelBody(value.body, controller.signal.reason);
        throw controller.signal.reason;
      }
      return value;
    });
    response = await abortable(pendingResponse, controller.signal);
    if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
    if (!response.body) throw new Error("USGS response body is missing");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType ?? "")) {
      throw new Error("USGS response is not a JSON media type");
    }
    reader = response.body.getReader();
    // Peer-controlled chunk boundaries must not create one retained object per
    // byte. Keep at most ceil(maxBytes / 65536) slabs, allocated only as needed.
    const slabs: Buffer[] = [];
    let slab: Buffer | undefined;
    let used = 0;
    let allocated = 0;
    let bytes = 0;
    for (;;) {
      const chunk = await abortable(reader.read(), controller.signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("Source response exceeds byte limit");
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        if (slab === undefined || used === slab.byteLength) {
          slab = Buffer.allocUnsafe(Math.min(65_536, maxBytes - allocated));
          allocated += slab.byteLength;
          slabs.push(slab);
          used = 0;
        }
        const copied = Math.min(chunk.value.byteLength - offset, slab.byteLength - used);
        slab.set(chunk.value.subarray(offset, offset + copied), used);
        used += copied;
        offset += copied;
      }
    }
    // All preceding slabs are full; total length excludes the last slab's
    // uninitialized tail, so no padding bytes enter validation or the hash.
    const raw = Buffer.concat(slabs, bytes);
    // Validate without using the decoder's BOM-stripped return value for hashes.
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return raw.toString("utf8");
  } catch (error) {
    controller.abort(error);
    if (reader) void reader.cancel(error).catch(() => {});
    else cancelBody(response?.body ?? null, error);
    throw error;
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}
