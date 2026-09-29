import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { fetchIpfsBytes, fetchIpfsJson } from "../../ipfs/gateway.js";

const config = { ipfsGatewayUrl: "https://primary.invalid" } as Config;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

for (const kind of ["json", "bytes"] as const) {
  describe(`${kind} gateway body timeout`, () => {
    const read = () => kind === "json" ? fetchIpfsJson(config, "test-cid") : fetchIpfsBytes(config, "test-cid");
    const success = () => new Response(kind === "json" ? '{"ok":true}' : "hello");
    function stalled(signal: AbortSignal) {
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
        },
      }));
    }
    it("aborts a body stalled after headers and falls back", async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn(async (_url, init) => {
        signals.push(init.signal);
        return signals.length === 1 ? stalled(init.signal) : success();
      });
      vi.stubGlobal("fetch", fetchMock);
      let result: unknown;
      const pending = read().then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(signals[0].aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await pending;
      expect(result).toEqual(kind === "json" ? { ok: true } : Buffer.from("hello"));
      expect(vi.getTimerCount()).toBe(0);
    });
    it("bounds all stalled gateways and rejects after the final attempt", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async (_url, init) => stalled(init.signal));
      vi.stubGlobal("fetch", fetchMock);
      let failure: Error | undefined;
      const pending = read().catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(48_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(failure?.message).toContain("Failed to fetch CID test-cid from all gateways");
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    });
    it("clears the deadline on successful consumption", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(async () => success()));
      expect(await read()).toEqual(kind === "json" ? { ok: true } : Buffer.from("hello"));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
}
