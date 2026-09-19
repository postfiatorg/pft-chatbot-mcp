import * as grpc from "@grpc/grpc-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeystoneClient } from "../../grpc/client.js";

const originalDeadline = process.env.KEYSTONE_GRPC_DEADLINE_MS;

afterEach(() => {
  if (originalDeadline === undefined) {
    delete process.env.KEYSTONE_GRPC_DEADLINE_MS;
  } else {
    process.env.KEYSTONE_GRPC_DEADLINE_MS = originalDeadline;
  }
});

function fakeClientWithPendingPing() {
  const pingAgent = vi.fn((
    _request: unknown,
    _metadata: grpc.Metadata,
    optionsOrCallback: grpc.CallOptions | Function,
    callback?: (error: grpc.ServiceError | null, response: unknown) => void
  ) => {
    // A no-deadline call never receives a response. With call options, model
    // grpc-js reporting its deadline error without opening a connection.
    if (typeof optionsOrCallback === "function" || !callback) return;
    const error = Object.assign(new Error("deadline exceeded"), {
      code: grpc.status.DEADLINE_EXCEEDED,
    }) as grpc.ServiceError;
    queueMicrotask(() => callback(error, {}));
  });
  const client = Object.create(KeystoneClient.prototype) as KeystoneClient;
  Object.assign(client, { agentRegistry: { pingAgent }, apiKey: null });
  return { client, pingAgent };
}

async function outcome(call: Promise<unknown>): Promise<number | "pending"> {
  return Promise.race([
    call.then(
      () => grpc.status.OK,
      (error: grpc.ServiceError) => error.code
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
}

describe("Keystone gRPC deadline", () => {
  it("bounds a pending unary call with the default 30-second deadline", async () => {
    delete process.env.KEYSTONE_GRPC_DEADLINE_MS;
    const { client, pingAgent } = fakeClientWithPendingPing();
    const before = Date.now();

    expect(await outcome(client.pingAgent())).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(pingAgent).toHaveBeenCalledTimes(1);
    const options = pingAgent.mock.calls[0][2] as grpc.CallOptions;
    expect(options.deadline).toBeInstanceOf(Date);
    expect((options.deadline as Date).getTime() - before).toBeGreaterThanOrEqual(30_000);
    expect((options.deadline as Date).getTime() - before).toBeLessThan(30_100);
  });

  it("uses a configured shorter deadline without retrying the call", async () => {
    process.env.KEYSTONE_GRPC_DEADLINE_MS = "1250";
    const { client, pingAgent } = fakeClientWithPendingPing();
    const before = Date.now();

    expect(await outcome(client.pingAgent())).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(pingAgent).toHaveBeenCalledTimes(1);
    const options = pingAgent.mock.calls[0][2] as grpc.CallOptions;
    expect((options.deadline as Date).getTime() - before).toBeGreaterThanOrEqual(1250);
    expect((options.deadline as Date).getTime() - before).toBeLessThan(1350);
  });
});
