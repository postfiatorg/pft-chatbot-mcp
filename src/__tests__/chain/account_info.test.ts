import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccountInfo } from "../../chain/scanner.js";
import { executeCheckBalance } from "../../tools/check_balance.js";
import { executeGetWalletInfo } from "../../tools/get_wallet_info.js";
import type { Config } from "../../config.js";
import type { BotKeypair } from "../../crypto/keys.js";
const config = { pftlRpcUrl: "https://unused.invalid" } as Config;
const keypair = { address: "synthetic", wallet: { publicKey: "test" }, x25519PublicKey: new Uint8Array(32) } as BotKeypair;
afterEach(() => vi.unstubAllGlobals());
describe("account_info HTTP status", () => {
  it.each([executeCheckBalance, executeGetWalletInfo])("rejects an account-info outage in %s", async (handler) => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const { method } = JSON.parse(init.body);
      return method === "account_info"
        ? new Response('{"error":"upstream unavailable"}', { status: 503, statusText: "Service Unavailable" })
        : Response.json({ result: { lines: [] } });
    }));
    await expect(handler(config, keypair)).rejects.toThrow("account_info failed: 503 Service Unavailable");
  });
  it("reports HTTP failure even when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad Gateway", { status: 502 })));
    await expect(getAccountInfo(config.pftlRpcUrl, "synthetic")).rejects.toThrow("account_info failed: 502");
  });
  it("preserves successful account data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: { account_data: { Balance: "1200000", MessageKey: "message-key", RegularKey: "regular-key" } } })));
    await expect(getAccountInfo(config.pftlRpcUrl, "synthetic")).resolves.toEqual({ publicKey: "regular-key", balance: "1200000", messageKey: "message-key" });
  });
  it("preserves successful-HTTP RPC error handling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: { error: "actNotFound" } })));
    await expect(getAccountInfo(config.pftlRpcUrl, "synthetic")).rejects.toThrow("account_info error: actNotFound");
  });
});
