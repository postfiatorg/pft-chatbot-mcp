import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import type { BotKeypair } from "../../crypto/keys.js";
import type { KeystoneClient } from "../../grpc/client.js";
import sodium from "../../crypto/sodium.js";
import { resolveRecipientKey } from "../../crypto/resolve_key.js";
import { executeUploadContent } from "../../tools/upload_content.js";

vi.mock("../../crypto/resolve_key.js", () => ({ resolveRecipientKey: vi.fn() }));

const CAP = 10 * 1024 * 1024;
const config = { pftlRpcUrl: "http://unused.invalid" } as Config;
let keypair: BotKeypair;
const storeContent = vi.fn(async (bytes: Buffer, contentType: string) => ({
  descriptor: { uri: "ipfs://test", contentType, contentLength: bytes.length },
}));
const client = { storeContent } as unknown as KeystoneClient;

beforeAll(async () => {
  await sodium.ready;
  const bot = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(1));
  const recipient = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(2));
  keypair = { x25519PublicKey: bot.publicKey } as BotKeypair;
  vi.mocked(resolveRecipientKey).mockResolvedValue(recipient.publicKey);
});
beforeEach(() => { vi.clearAllMocks(); });

describe("upload payload size with real encryption and offline storage", () => {
  it.each([7_863_723, 8 * 1024 * 1024])(
    "rejects %i raw bytes whose encrypted envelope exceeds the cap before storage",
    async (size) => {
      await expect(executeUploadContent(config, client, {
        content: "x".repeat(size), content_type: "text/plain", encrypt_for: "test-recipient",
      }, keypair)).rejects.toThrow("Encrypted content too large for upload");
      expect(storeContent).not.toHaveBeenCalled();
    },
  );

  it.each(["utf8", "base64"] as const)(
    "accepts the largest fitting two-recipient envelope via %s",
    async (encoding) => {
      const raw = Buffer.alloc(7_863_722, 120);
      const result = JSON.parse(await executeUploadContent(config, client, {
        content: raw.toString(encoding), encoding, content_type: "application/octet-stream",
        encrypt_for: "test-recipient",
      }, keypair));
      expect(storeContent).toHaveBeenCalledTimes(1);
      expect(storeContent.mock.calls[0][0].length).toBe(CAP - 1);
      expect(storeContent.mock.calls[0][1]).toBe("application/json");
      expect(result).toMatchObject({ cid: "test", size: raw.length, encrypted: true });
    },
  );

  it("preserves plaintext uploads at the exact cap", async () => {
    const result = JSON.parse(await executeUploadContent(config, client, {
      content: "x".repeat(CAP), content_type: "text/plain",
    }));
    expect(storeContent.mock.calls[0][0].length).toBe(CAP);
    expect(result.size).toBe(CAP);
    expect(resolveRecipientKey).not.toHaveBeenCalled();
  });

  it("rejects oversized raw input before recipient lookup or storage", async () => {
    await expect(executeUploadContent(config, client, {
      content: "x".repeat(CAP + 1), content_type: "text/plain", encrypt_for: "test-recipient",
    }, keypair)).rejects.toThrow("Content too large for upload");
    expect(resolveRecipientKey).not.toHaveBeenCalled();
    expect(storeContent).not.toHaveBeenCalled();
  });
});
