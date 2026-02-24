import type { KeystoneClient, ProtoTimestamp } from "../grpc/client.js";

export function timestampToIso(ts: ProtoTimestamp | null | undefined): string | null {
  if (!ts) return null;
  const ms = parseInt(ts.seconds, 10) * 1000 + Math.floor((ts.nanos || 0) / 1e6);
  return new Date(ms).toISOString();
}

/**
 * Start a periodic heartbeat that calls PingAgent on the Keystone registry.
 * Returns a cleanup function that stops the loop.
 *
 * Uses setTimeout chaining (not setInterval) so a slow/stuck ping cannot
 * cause concurrent requests to pile up.
 *
 * The server hides agents that haven't pinged in 20 minutes, so the default
 * interval is 15 minutes to leave comfortable margin.
 */
export function startPingInterval(
  grpcClient: KeystoneClient,
  intervalMs: number
): () => void {
  if (intervalMs <= 0) {
    return () => {};
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const doPing = async () => {
    try {
      const res = await grpcClient.pingAgent();
      const iso = timestampToIso(res.lastPingAt);
      process.stderr.write(`[ping] OK – last_ping_at=${iso}\n`);
    } catch (err: any) {
      process.stderr.write(`[ping] WARN – ${err.message}\n`);
    }
  };

  const loop = async () => {
    if (stopped) return;
    await doPing();
    if (!stopped) {
      timer = setTimeout(loop, intervalMs);
    }
  };

  // Fire immediately, then re-schedule after each completion
  loop();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
