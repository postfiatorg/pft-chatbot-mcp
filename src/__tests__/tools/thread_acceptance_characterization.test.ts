import { afterEach, describe, expect, it, vi } from "vitest";
import sodium from "../../crypto/sodium.js";
import { encryptPayloadForRecipients } from "../../crypto/encrypt.js";
import { buildKeystoneEnvelopeMemo, buildPfPointerMemo } from "../../chain/pointer.js";
import { scanMessages } from "../../chain/scanner.js";
import { executeGetThread } from "../../tools/get_thread.js";
import type { Config } from "../../config.js";
import type { BotKeypair } from "../../crypto/keys.js";

// Synthetic transport only: actual protobuf decoder, scanner, tool and sodium.
// No wallet seed, signatures, live chain, IPFS request or module replacement.
const config = {
  pftlRpcUrl: "https://rpc.fixture.invalid", ipfsGatewayUrl: "https://ipfs.fixture.invalid",
} as Config;
const bot = "rFixtureBot", contact = "rFixtureContact", outsider = "rFixtureOutsider";
afterEach(() => vi.unstubAllGlobals());

async function fixture(format: "keystone" | "pointer", sender = outsider, recipient = bot) {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const keypair = { address: bot, x25519PublicKey: pair.publicKey, x25519PrivateKey: pair.privateKey } as BotKeypair;
  const blob = await encryptPayloadForRecipients(JSON.stringify({
    thread_id: "known-thread", sender_address: sender, recipient_address: recipient, message: "fixture-message",
  }), [pair.publicKey]);
  const memo = format === "keystone"
    ? await buildKeystoneEnvelopeMemo({ cid: "fixture-cid", contentHash: "ab".repeat(32), contentLength: 1 })
    : await buildPfPointerMemo({ cid: "fixture-cid", threadId: "known-thread" });
  const transaction = { tx: {
    TransactionType: "Payment", Account: sender, Destination: recipient, Amount: "1", hash: "fixture-hash",
    Memos: [{ Memo: { MemoType: memo.memoTypeHex, MemoFormat: memo.memoFormatHex, MemoData: memo.memoDataHex } }],
  }, meta: { TransactionResult: "tesSUCCESS" }, ledger_index: 100 };
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === config.pftlRpcUrl) return new Response(JSON.stringify({ result: { transactions: [transaction] } }));
    if (String(url) === "https://ipfs.fixture.invalid/ipfs/fixture-cid") return new Response(JSON.stringify(blob));
    throw new Error("Unexpected fixture transport URL");
  });
  vi.stubGlobal("fetch", transport);
  return { keypair, transport };
}

describe("current thread acceptance reachability characterization", () => {
  it("Keystone scanner has CID but no thread ID even for a legitimate contact", async () => {
    await fixture("keystone", contact);
    const messages = await scanMessages(config, bot);
    expect(messages).toHaveLength(1);
    expect(messages[0].cid).toBe("fixture-cid");
    expect(messages[0].threadId).toBeNull();
    expect(messages[0].sender).toBe(contact);
  });
  it("outsider Keystone payload cannot enter an authorized thread-ID lookup at this pin", async () => {
    const { keypair, transport } = await fixture("keystone");
    expect(await executeGetThread(config, keypair, { thread_id: "known-thread", contact_address: contact })).toBe("No messages found in this thread.");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("legitimate Keystone payload is also absent from a thread-ID lookup", async () => {
    const { keypair } = await fixture("keystone", contact);
    expect(await executeGetThread(config, keypair, { thread_id: "known-thread", contact_address: contact })).toBe("No messages found in this thread.");
  });
  it("contact lookup decrypts legitimate Keystone bytes through actual sodium", async () => {
    const { keypair } = await fixture("keystone", contact);
    const result = JSON.parse(await executeGetThread(config, keypair, { contact_address: contact }));
    expect(result.message_count).toBe(1);
    expect(result.messages[0]).toMatchObject({ sender: contact, recipient: bot, decrypted: true, message: "fixture-message" });
  });
  it("contact lookup excludes an outsider Keystone message", async () => {
    const { keypair, transport } = await fixture("keystone");
    expect(await executeGetThread(config, keypair, { contact_address: contact })).toBe("No messages found in this thread.");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("legacy pointer thread-ID lookup excludes an outsider despite claimed thread ID", async () => {
    const { keypair } = await fixture("pointer");
    expect(await executeGetThread(config, keypair, { thread_id: "known-thread", contact_address: contact })).toBe("No messages found in this thread.");
  });
  it("legacy legitimate participant remains readable and decrypted", async () => {
    const { keypair } = await fixture("pointer", contact);
    const result = JSON.parse(await executeGetThread(config, keypair, { thread_id: "known-thread", contact_address: contact }));
    expect(result.message_count).toBe(1);
    expect(result.messages[0]).toMatchObject({ sender: contact, recipient: bot, decrypted: true, message: "fixture-message" });
  });
  it("fails closed when thread-ID lookup supplies no trusted contact context", async () => {
    const { keypair } = await fixture("pointer");
    expect(await executeGetThread(config, keypair, { thread_id: "known-thread" })).toBe("Error: thread_id requires contact_address to authorize thread participants");
  });
  it("legitimate outbound participant messages remain readable", async () => {
    const { keypair } = await fixture("pointer", bot, contact);
    const result = JSON.parse(await executeGetThread(config, keypair, { thread_id: "known-thread", contact_address: contact }));
    expect(result.messages[0]).toMatchObject({ sender: bot, recipient: contact, direction: "outbound", decrypted: true });
  });
  it("rejects an expected contact addressing a different recipient", async () => {
    const { keypair } = await fixture("pointer", contact, outsider);
    expect(await executeGetThread(config, keypair, { thread_id: "known-thread", contact_address: contact })).toBe("No messages found in this thread.");
  });
});
