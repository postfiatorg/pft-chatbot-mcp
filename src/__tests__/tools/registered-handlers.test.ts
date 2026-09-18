import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The real entry point, MCP SDK registration, validation, wrappers and handlers
// run unchanged. Only transport/config/key derivation and external I/O are fixtures.
// No live seed, RPC, registry registration, cached API key or payment is used.
const fixture = vi.hoisted(() => ({
  serverTransport: undefined as any,
  calls: [] as Array<{ method: string; args: unknown[] }>,
  successfulPayment: false,
  config: {
    botSeed: "offline-unused-fixture", pftlRpcUrl: "https://rpc.invalid",
    pftlWssUrl: "wss://ws.invalid", ipfsGatewayUrl: "https://ipfs.invalid",
    keystoneGrpcUrl: "grpc.invalid:443", keystoneApiKey: "offline-fixture",
    pingIntervalMs: 0, tasknodeEncryptionKey: null, tasknodeKeySource: null,
  },
  fail(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    throw new Error("OFFLINE_TRANSPORT_FAILURE");
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class { constructor() { return fixture.serverTransport; } },
}));
vi.mock("../../config.js", () => ({
  loadConfig: () => fixture.config,
  cacheApiKey: () => { throw new Error("Unexpected cache write"); },
}));
vi.mock("../../crypto/keys.js", () => ({
  deriveBotKeypair: async () => ({
    address: "rOfflineFixture", wallet: { address: "rOfflineFixture" },
    x25519PublicKey: new Uint8Array(32), x25519PrivateKey: new Uint8Array(32),
  }),
}));
vi.mock("../../grpc/client.js", () => ({
  KeystoneClient: class {
    constructor() {
      return new Proxy(this, { get: (_target, key) => {
        if (key === "close" || key === "setApiKey") return () => {};
        return async (...args: unknown[]) => fixture.fail(`grpc.${String(key)}`, ...args);
      } });
    }
  },
}));
vi.mock("../../chain/submitter.js", () => ({
  preparePayment: async (...args: unknown[]) => {
    if (!fixture.successfulPayment) return fixture.fail("preparePayment", ...args);
    fixture.calls.push({ method: "preparePayment", args });
    return { txJson: { synthetic: true }, fee: "12" };
  },
  signAndSubmit: async (...args: unknown[]) => {
    if (!fixture.successfulPayment) return fixture.fail("signAndSubmit", ...args);
    fixture.calls.push({ method: "signAndSubmit", args });
    return { txHash: "OFFLINE_SYNTHETIC_HASH", result: "tesSUCCESS" };
  },
  publishMessageKey: async (...args: unknown[]) => fixture.fail("publishMessageKey", ...args),
}));

let client: Client;
const originalSignals = new Map<string, Function[]>();
beforeAll(async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) originalSignals.set(signal, process.listeners(signal));
  vi.stubGlobal("fetch", vi.fn(async (...args: unknown[]) => fixture.fail("fetch", ...args)));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  fixture.serverTransport = serverTransport;
  client = new Client({ name: "offline-handler-audit", version: "1.0.0" });
  await import("../../index.js");
  await client.connect(clientTransport);
});
beforeEach(() => { fixture.calls.length = 0; fixture.successfulPayment = false; });
afterAll(async () => {
  await client?.close();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!originalSignals.get(signal)!.includes(listener)) process.removeListener(signal, listener as any);
    }
  }
  vi.unstubAllGlobals();
});
const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["create_wallet", {}, { algorithm: 1 }],
  ["scan_messages", { limit: 1 }, { limit: "1" }],
  ["get_message", { cid: "fixture-cid" }, { cid: 1 }],
  ["send_message", { recipient: "rFixture", message: "fixture" }, { recipient: "rFixture", message: false }],
  ["register_bot", { name: "fixture", description: "fixture", capabilities: [] }, { name: "fixture", description: "fixture", capabilities: "text" }],
  ["search_bots", { query: "fixture" }, { limit: "1" }],
  ["get_bot", { agent_id: "fixture" }, { agent_id: [] }],
  ["delete_bot", {}, {}],
  ["upload_content", { content: "fixture", content_type: "text/plain" }, { content: 1, content_type: "text/plain" }],
  ["get_attachment", { cid: "fixture-cid" }, { cid: false }],
  ["check_balance", {}, {}],
  ["send_pft", { recipient: "rFixture", amount_drops: "1" }, { recipient: 1, amount_drops: "1" }],
  ["get_wallet_info", {}, {}],
  ["ping", {}, {}],
];
const text = (result: any): string => result.content.map((item: any) => item.text || "").join("\n");
describe("actual registered MCP tool paths, network blocked", () => {
  it("lists all fourteen scoped handlers; get_thread remains excluded", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name).filter(n => n !== "get_thread").sort()).toEqual(cases.map(c => c[0]).sort());
  });
  for (const [name, valid, malformed] of cases) {
    it(`${name}: schema-valid control executes real handler`, async () => {
      const result = await client.callTool({ name, arguments: valid });
      if (name === "create_wallet") {
        // Do not print or save the locally generated unfunded seed.
        const value = JSON.parse(text(result));
        expect(value.address).toMatch(/^r/);
        expect(value.activation.status).toBe("NOT_ACTIVATED");
        expect(fixture.calls).toHaveLength(0);
      } else {
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("OFFLINE_TRANSPORT_FAILURE");
        expect(fixture.calls.length).toBeGreaterThan(0);
      }
    });
    if (Object.keys(malformed).length) {
      it(`${name}: type conflict rejected before external I/O`, async () => {
        const result = await client.callTool({ name, arguments: malformed });
        expect(result.isError).toBe(true);
        expect(fixture.calls).toHaveLength(0);
      });
    }
    it(`${name}: non-object arguments rejected at protocol boundary`, async () => {
      await expect(client.callTool({ name, arguments: [] as any })).rejects.toThrow();
      expect(fixture.calls).toHaveLength(0);
    });
  }
  for (const name of ["send_message", "register_bot", "get_bot", "upload_content", "get_attachment", "send_pft"]) {
    it(`${name}: missing required fields rejected before I/O`, async () => {
      expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
      expect(fixture.calls).toHaveLength(0);
    });
  }
  for (const [name, upper] of [["scan_messages", 200], ["search_bots", 100]] as const) {
    for (const limit of [0, upper + 1]) {
      it(`${name}: limit ${limit} rejected before I/O`, async () => {
        expect((await client.callTool({ name, arguments: { limit } })).isError).toBe(true);
        expect(fixture.calls).toHaveLength(0);
      });
    }
    for (const limit of [1, upper]) {
      it(`${name}: boundary ${limit} reaches controlled I/O`, async () => {
        expect((await client.callTool({ name, arguments: { limit } })).isError).toBe(true);
        expect(fixture.calls.length).toBeGreaterThan(0);
      });
    }
  }
  it("get_message: missing selectors returns existing text error without I/O", async () => {
    const result = await client.callTool({ name: "get_message", arguments: {} });
    expect(text(result)).toBe("Error: provide either tx_hash or cid");
    expect(result.isError).not.toBe(true);
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("send_pft malformed amount and conflict regression expectations", () => {
  it("reports exact PFT and drops on synthetic payment success, without a live transfer", async () => {
    fixture.successfulPayment = true;
    const result = await client.callTool({ name: "send_pft", arguments: { recipient: "rFixture", amount_drops: "9007199254740993" } });
    expect(result.isError).not.toBe(true);
    const value = JSON.parse(text(result));
    expect(value.amount_drops).toBe("9007199254740993");
    expect(value.amount_pft).toBe("9007199254.740993");
    expect(value.tx_hash).toBe("OFFLINE_SYNTHETIC_HASH");
    expect(fixture.calls.map(c => c.method)).toEqual(["preparePayment", "signAndSubmit"]);
  });
  for (const amount_drops of ["1junk", "1.9"]) {
    it(`rejects malformed/inexact drops ${amount_drops} before payment preparation`, async () => {
      expect((await client.callTool({ name: "send_pft", arguments: { recipient: "rFixture", amount_drops } })).isError).toBe(true);
      expect(fixture.calls).toHaveLength(0);
    });
  }
  for (const amount_pft of ["1junk", "Infinity", "0.0000001"]) {
    it(`rejects malformed/nonrepresentable PFT ${amount_pft} before payment preparation`, async () => {
      expect((await client.callTool({ name: "send_pft", arguments: { recipient: "rFixture", amount_pft } })).isError).toBe(true);
      expect(fixture.calls).toHaveLength(0);
    });
  }
  it("rejects both mutually exclusive amount selectors before payment preparation", async () => {
    expect((await client.callTool({ name: "send_pft", arguments: { recipient: "rFixture", amount_pft: "1", amount_drops: "2" } })).isError).toBe(true);
    expect(fixture.calls).toHaveLength(0);
  });
  for (const [amounts, expectedDrops] of [
    [{ amount_drops: "9007199254740993" }, "9007199254740993"],
    [{ amount_pft: "9007199254.740993" }, "9007199254740993"],
    [{ amount_pft: "1.123456" }, "1123456"],
    [{ amount_pft: "0.000001" }, "1"],
    [{ amount_pft: ".5" }, "500000"],
    [{ amount_pft: "1." }, "1000000"],
  ] as Array<[Record<string, string>, string]>) {
    it(`preserves exact valid drops ${expectedDrops} from ${JSON.stringify(amounts)}`, async () => {
      await client.callTool({ name: "send_pft", arguments: { recipient: "rFixture", ...amounts } });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0].method).toBe("preparePayment");
      expect(fixture.calls[0].args[3]).toBe(expectedDrops);
    });
  }
  for (const amounts of [{}, { amount_pft: "0" }, { amount_drops: "-1" }, { amount_drops: "" }]) {
    it(`rejects missing or nonpositive amount ${JSON.stringify(amounts)}`, async () => {
      expect((await client.callTool({ name: "send_pft", arguments: { recipient: "rFixture", ...amounts } })).isError).toBe(true);
      expect(fixture.calls).toHaveLength(0);
    });
  }
});
