import { describe, it, expect, vi, afterEach } from "vitest";
import { startPingInterval, timestampToIso } from "../../liveness/ping.js";

describe("timestampToIso", () => {
  it("converts a proto timestamp to ISO string", () => {
    const ts = { seconds: "1700000000", nanos: 0 };
    const iso = timestampToIso(ts);
    expect(iso).toBe(new Date(1700000000000).toISOString());
  });

  it("returns null for null/undefined", () => {
    expect(timestampToIso(null)).toBeNull();
    expect(timestampToIso(undefined)).toBeNull();
  });
});

describe("startPingInterval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a no-op cleanup when intervalMs <= 0", () => {
    const mockClient = { pingAgent: vi.fn() } as any;
    const stop = startPingInterval(mockClient, 0);
    expect(typeof stop).toBe("function");
    expect(mockClient.pingAgent).not.toHaveBeenCalled();
    stop();
  });

  it("calls pingAgent immediately on start", async () => {
    const mockClient = {
      pingAgent: vi.fn().mockResolvedValue({
        lastPingAt: { seconds: "1700000000", nanos: 0 },
      }),
    } as any;

    const stop = startPingInterval(mockClient, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClient.pingAgent).toHaveBeenCalledTimes(1);
    stop();
  });

  it("cleanup stops the timeout chain", async () => {
    const mockClient = {
      pingAgent: vi.fn().mockResolvedValue({
        lastPingAt: { seconds: "1700000000", nanos: 0 },
      }),
    } as any;

    const stop = startPingInterval(mockClient, 100);
    await new Promise((r) => setTimeout(r, 50));
    stop();

    const callCount = mockClient.pingAgent.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    // No additional pings after stop
    expect(mockClient.pingAgent.mock.calls.length).toBe(callCount);
  });

  it("does not fire concurrent pings (setTimeout chain, not setInterval)", async () => {
    let resolvePing: () => void;
    const mockClient = {
      pingAgent: vi.fn().mockImplementation(
        () => new Promise<any>((resolve) => {
          resolvePing = () => resolve({ lastPingAt: { seconds: "1700000000", nanos: 0 } });
        })
      ),
    } as any;

    const stop = startPingInterval(mockClient, 50);
    // First ping is in-flight (not resolved yet)
    await new Promise((r) => setTimeout(r, 20));
    expect(mockClient.pingAgent).toHaveBeenCalledTimes(1);

    // Wait past the interval -- second ping should NOT fire while first is pending
    await new Promise((r) => setTimeout(r, 80));
    expect(mockClient.pingAgent).toHaveBeenCalledTimes(1);

    // Now resolve the first ping
    resolvePing!();
    await new Promise((r) => setTimeout(r, 10));

    // After resolution, the next timeout is scheduled (but hasn't fired yet)
    expect(mockClient.pingAgent).toHaveBeenCalledTimes(1);

    stop();
  });

  it("logs a warning on ping failure but does not throw", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const mockClient = {
      pingAgent: vi.fn().mockRejectedValue(new Error("network down")),
    } as any;

    const stop = startPingInterval(mockClient, 60_000);
    await new Promise((r) => setTimeout(r, 50));

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ping] WARN")
    );
    stop();
  });
});
