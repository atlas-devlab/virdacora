import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBoundedUSGSJSON, USGS_RESPONSE_MAX_BYTES, USGS_RESPONSE_TIMEOUT_MS } from "./bounded-fetch.js";

const url = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items?f=json";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function streamed(chunks: Uint8Array[], options: { status?: number; mediaType?: string; headers?: Record<string, string> } = {}) {
  const state = { producedBytes: 0, producedChunks: 0, cancelled: 0 };
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) { controller.close(); return; }
      const chunk = chunks[index++]!;
      state.producedBytes += chunk.byteLength;
      state.producedChunks++;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled++; }
  }, { highWaterMark: 0 });
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": options.mediaType ?? "application/json", ...options.headers }
  });
  return { state, response, body };
}

function mockResponse(response: Response) {
  const mock = vi.fn(async (_destination: unknown, _options?: RequestInit) => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Bounded transport for future USGS captures", () => {
  it("preserves valid UTF-8 bytes and hash with one request and redirects forbidden", async () => {
    const raw = '{"river":"Willamette","community":"comunità 🌿"}\n';
    const fixture = streamed([Buffer.from(raw)]), request = mockResponse(fixture.response);
    const value = await fetchBoundedUSGSJSON(url);
    expect(value).toBe(raw);
    expect(digest(value)).toBe(digest(Buffer.from(raw)));
    expect(fixture.state.cancelled).toBe(0);
    expect(fixture.body.locked).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toEqual(new URL(url));
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("retains a UTF-8 BOM instead of silently changing bytes before hashing", async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"value":1}')]);
    mockResponse(streamed([raw]).response);
    const result = await fetchBoundedUSGSJSON(url);
    expect(Buffer.from(result)).toEqual(raw);
    expect(digest(result)).toBe(digest(raw));
  });

  it.each(["application/json; charset=utf-8", "application/geo+json", "application/vnd.ogc.fg+json; charset=UTF-8"])("accepts JSON media type %s", async mediaType => {
    mockResponse(streamed([Buffer.from("{}")], { mediaType }).response);
    expect(await fetchBoundedUSGSJSON(url)).toBe("{}");
  });

  it("accepts a response exactly at the byte boundary", async () => {
    const raw = Buffer.from('{"value":"é"}');
    mockResponse(streamed([raw.subarray(0, 7), raw.subarray(7)]).response);
    expect(await fetchBoundedUSGSJSON(url, { maxBytes: raw.byteLength })).toBe(raw.toString("utf8"));
  });

  it("rejects one byte above the boundary, aborts, cancels, and stops producing chunks", async () => {
    const fixture = streamed([Buffer.alloc(10, 0x20), Buffer.alloc(1, 0x20), Buffer.alloc(100, 0x20)]);
    const request = mockResponse(fixture.response);
    await expect(fetchBoundedUSGSJSON(url, { maxBytes: 10 })).rejects.toThrow("byte limit");
    expect(fixture.state).toEqual({ producedBytes: 11, producedChunks: 2, cancelled: 1 });
    expect((request.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(fixture.body.locked).toBe(false);
  });

  it("counts multibyte characters as UTF-8 bytes rather than UTF-16 characters", async () => {
    const raw = '"' + "€".repeat(5) + '"';
    expect(raw.length).toBeLessThan(10);
    mockResponse(streamed([Buffer.from(raw)]).response);
    await expect(fetchBoundedUSGSJSON(url, { maxBytes: 10 })).rejects.toThrow("byte limit");
  });

  it("allows a valid multibyte code point split across response chunks", async () => {
    const raw = Buffer.from('{"value":"🌿é"}');
    mockResponse(streamed(Array.from(raw, byte => Uint8Array.of(byte))).response);
    expect(await fetchBoundedUSGSJSON(url)).toBe(raw.toString("utf8"));
  });

  it("reassembles many single-byte chunks across slab boundaries without changing bytes", async () => {
    const raw = Buffer.from(JSON.stringify({ text: "comunità 🌿".repeat(10_000) }));
    const fixture = streamed(Array.from(raw, byte => Uint8Array.of(byte)));
    mockResponse(fixture.response);
    const result = await fetchBoundedUSGSJSON(url, { maxBytes: raw.byteLength });
    expect(Buffer.from(result)).toEqual(raw);
    expect(digest(result)).toBe(digest(raw));
    expect(fixture.state.producedChunks).toBe(raw.byteLength);
    expect(fixture.state.cancelled).toBe(0);
  });

  it.each([Uint8Array.of(0xff), Uint8Array.of(0xe2, 0x82)])("rejects invalid or truncated UTF-8 instead of replacement decoding", async bytes => {
    const fixture = streamed([bytes]), request = mockResponse(fixture.response);
    await expect(fetchBoundedUSGSJSON(url)).rejects.toThrow();
    expect((request.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(fixture.body.locked).toBe(false);
  });

  it.each([{}, { "content-length": "1" }])("enforces streamed bytes with absent or understated Content-Length %j", async headers => {
    const fixture = streamed([Buffer.alloc(10), Buffer.alloc(1), Buffer.alloc(20)], { headers });
    mockResponse(fixture.response);
    await expect(fetchBoundedUSGSJSON(url, { maxBytes: 10 })).rejects.toThrow("byte limit");
    expect(fixture.state.producedBytes).toBe(11);
    expect(fixture.state.cancelled).toBe(1);
  });

  it("does not mistake advertised wire length for decoded body size", async () => {
    mockResponse(streamed([Buffer.from("{}")], { headers: { "content-length": "999999999", "content-encoding": "gzip" } }).response);
    expect(await fetchBoundedUSGSJSON(url, { maxBytes: 2 })).toBe("{}");
  });

  it.each([429, 503])("cancels HTTP %i bodies without reading them or retrying", async status => {
    const fixture = streamed([Buffer.alloc(1024)], { status }), request = mockResponse(fixture.response);
    await expect(fetchBoundedUSGSJSON(url)).rejects.toThrow(`USGS HTTP ${status}`);
    expect(fixture.state).toEqual({ producedBytes: 0, producedChunks: 0, cancelled: 1 });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["text/html", "text/html; note=json", "application/notjson"])("cancels rejected media type %s without reading it", async mediaType => {
    const fixture = streamed([Buffer.from("<html>blocked</html>")], { mediaType });
    mockResponse(fixture.response);
    await expect(fetchBoundedUSGSJSON(url)).rejects.toThrow("JSON media type");
    expect(fixture.state).toEqual({ producedBytes: 0, producedChunks: 0, cancelled: 1 });
  });

  it("rejects a missing content type and cancels the body", async () => {
    const fixture = streamed([Buffer.from("{}")]);
    fixture.response.headers.delete("content-type");
    mockResponse(fixture.response);
    await expect(fetchBoundedUSGSJSON(url)).rejects.toThrow("JSON media type");
    expect(fixture.state.cancelled).toBe(1);
  });

  it("rejects a successful response with no body", async () => {
    mockResponse(new Response(null, { status: 200, headers: { "content-type": "application/json" } }));
    await expect(fetchBoundedUSGSJSON(url)).rejects.toThrow("body is missing");
  });

  it("uses the same deadline for request headers and a stalled response body", async () => {
    vi.useFakeTimers();
    // No pull completion: the peer has returned headers but does not deliver a body.
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const request = mockResponse(new Response(body, { headers: { "content-type": "application/json" } }));
    const assertion = expect(fetchBoundedUSGSJSON(url, { timeoutMs: 10 })).rejects.toThrow("timed out after 10 ms");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
    expect((request.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes seven milliseconds spent waiting for headers in a ten millisecond total deadline", async () => {
    vi.useFakeTimers();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled++; }
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(body, { headers: { "content-type": "application/json" } })), 7);
    })));
    const pending = fetchBoundedUSGSJSON(url, { timeoutMs: 10 });
    const assertion = expect(pending).rejects.toThrow("timed out after 10 ms");
    const rejected = vi.fn();
    void pending.catch(rejected);
    await vi.advanceTimersByTimeAsync(7);
    expect(rejected).not.toHaveBeenCalled();
    expect(body.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(rejected).toHaveBeenCalledOnce();
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled request and cancels a response that arrives after its deadline", async () => {
    vi.useFakeTimers();
    const fixture = streamed([Buffer.from("{}")]);
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const assertion = expect(fetchBoundedUSGSJSON(url, { timeoutMs: 10 })).rejects.toThrow("timed out after 10 ms");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    finish(fixture.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.state.cancelled).toBe(1);
    expect(fixture.state.producedBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend the deadline waiting for a peer's stalled cancellation", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}); },
      cancel() { return new Promise(() => {}); }
    }, { highWaterMark: 0 });
    mockResponse(new Response(body, { headers: { "content-type": "application/json" } }));
    const assertion = expect(fetchBoundedUSGSJSON(url, { timeoutMs: 10 })).rejects.toThrow("timed out after 10 ms");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a body read error, aborts the request and releases its reader", async () => {
    const failure = new Error("fixture connection lost");
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
    const request = mockResponse(new Response(body, { headers: { "content-type": "application/json" } }));
    await expect(fetchBoundedUSGSJSON(url)).rejects.toBe(failure);
    expect((request.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(body.locked).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("propagates a fetch failure without a retry or fallback", async () => {
    const failure = new Error("fixture publisher unavailable"), request = vi.fn(async () => { throw failure; });
    vi.stubGlobal("fetch", request);
    await expect(fetchBoundedUSGSJSON(url)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    "https://example.org/data", "http://api.waterdata.usgs.gov/data", "https://api.waterdata.usgs.gov.evil.example/data",
    "https://user@api.waterdata.usgs.gov/data", "https://:password@api.waterdata.usgs.gov/data",
    "https://api.waterdata.usgs.gov/data#fragment", "https://api.waterdata.usgs.gov:8443/data"
  ])("rejects untrusted URL %s before requesting", async destination => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(fetchBoundedUSGSJSON(destination)).rejects.toThrow("Untrusted");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: NaN }, { maxBytes: USGS_RESPONSE_MAX_BYTES + 1 },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: USGS_RESPONSE_TIMEOUT_MS + 1 }
  ])("rejects invalid or weakened acquisition limits %j before requesting", async options => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(fetchBoundedUSGSJSON(url, options)).rejects.toThrow("Invalid USGS");
    expect(request).not.toHaveBeenCalled();
  });
});
