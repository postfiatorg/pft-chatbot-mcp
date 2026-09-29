import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccountLines } from "../../chain/scanner.js";
import { executeCheckBalance } from "../../tools/check_balance.js";
import { executeGetWalletInfo } from "../../tools/get_wallet_info.js";
import type { Config } from "../../config.js";
import type { BotKeypair } from "../../crypto/keys.js";

const usd = { currency: "USD", account: "issuer1", balance: "3", limit: "100" };
const pft = { currency: "PFT", account: "issuer2", balance: "12", limit: "100" };
const config = { pftlRpcUrl: "https://unused.invalid" } as Config;
const keypair = { address: "synthetic", wallet: { publicKey: "test" }, x25519PublicKey: new Uint8Array(32) } as BotKeypair;
function rpc(pages: object[]) {
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === "account_info") return Response.json({ result: { account_data: { Balance: "1000000" } } });
    calls.push(request.params[0]);
    if (!pages.length) throw new Error("Unexpected extra page");
    return Response.json({ result: pages.shift() });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("account_lines pagination", () => {
  it.each([executeCheckBalance, executeGetWalletInfo])("includes later-page balances in %s", async (handler) => {
    const calls = rpc([{ lines: [usd], ledger_hash: "fixed-ledger", marker: { page: 2 } }, { lines: [pft] }]);
    const result = JSON.parse(await handler(config, keypair));
    expect(result.trust_lines ?? result.all_trust_lines).toHaveLength(2);
    if (handler === executeGetWalletInfo) expect(result.pft_trust_line).toMatchObject({ active: true, balance: "12" });
    expect(calls[1]).toEqual({ account: "synthetic", ledger_hash: "fixed-ledger", marker: { page: 2 } });
  });
  it("continues an empty page and pins the numeric ledger when no hash is returned", async () => {
    const calls = rpc([{ lines: [], ledger_index: 100, marker: "next" }, { lines: [pft] }]);
    expect(await getAccountLines(config.pftlRpcUrl, "synthetic")).toEqual([{ currency: "PFT", issuer: "issuer2", balance: "12", limit: "100" }]);
    expect(calls[1]).toEqual({ account: "synthetic", ledger_index: 100, marker: "next" });
  });
  it("refuses pagination without a stable ledger identity", async () => {
    rpc([{ lines: [usd], marker: "next" }]);
    await expect(getAccountLines(config.pftlRpcUrl, "synthetic")).rejects.toThrow("missing ledger identity");
  });
  it("rejects HTTP failures instead of displaying an empty balance list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(getAccountLines(config.pftlRpcUrl, "synthetic")).rejects.toThrow("account_lines failed: 503");
  });
  it("preserves single-page mapping and defaults", async () => {
    const calls = rpc([{ lines: [usd, {}] }]);
    expect(await getAccountLines(config.pftlRpcUrl, "synthetic")).toEqual([
      { currency: "USD", issuer: "issuer1", balance: "3", limit: "100" },
      { currency: "", issuer: "", balance: "0", limit: "0" },
    ]);
    expect(calls).toHaveLength(1);
  });
  it("propagates later-page errors instead of returning partial balances", async () => {
    rpc([{ lines: [usd], ledger_index: 100, marker: "next" }, { error: "lgrNotFound" }]);
    await expect(getAccountLines(config.pftlRpcUrl, "synthetic")).rejects.toThrow("lgrNotFound");
  });
  it("rejects repeated markers instead of looping or returning duplicate lines", async () => {
    const calls = rpc([{ lines: [usd], ledger_index: 100, marker: "same" }, { lines: [pft], marker: "same" }]);
    await expect(getAccountLines(config.pftlRpcUrl, "synthetic")).rejects.toThrow("repeated pagination marker");
    expect(calls).toHaveLength(2);
  });
});
