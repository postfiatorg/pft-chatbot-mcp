import { describe, it, expect, vi, beforeEach } from "vitest";
import sodium from "../../crypto/sodium.js";
import { encryptBinaryForRecipients } from "../../crypto/encrypt.js";
import { executeGetAttachment } from "../../tools/get_attachment.js";
import type { BotKeypair } from "../../crypto/keys.js";

// Mock fetchIpfsBytes
vi.mock("../../ipfs/gateway.js", () => ({
  fetchIpfsBytes: vi.fn(),
}));

import { fetchIpfsBytes } from "../../ipfs/gateway.js";
const mockFetchBytes = vi.mocked(fetchIpfsBytes);

async function makeKeypair(): Promise<BotKeypair> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return {
    wallet: {} as any,
    x25519PublicKey: kp.publicKey,
    x25519PrivateKey: kp.privateKey,
    address: "rTestAddress",
  };
}

const dummyConfig = {
  botSeed: "",
  pftlRpcUrl: "",
  pftlWssUrl: "",
  ipfsGatewayUrl: "https://example.com",
  keystoneGrpcUrl: "",
  keystoneApiKey: null,
  pingIntervalMs: 0,
};

describe("executeGetAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns raw bytes for non-encrypted binary content", async () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockFetchBytes.mockResolvedValue(raw);
    const kp = await makeKeypair();

    const result = JSON.parse(
      await executeGetAttachment(dummyConfig, kp, { cid: "bafktest" })
    );

    expect(result.was_encrypted).toBe(false);
    expect(result.size_bytes).toBe(4);
    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64")).toEqual(raw);
  });

  it("returns raw bytes for non-encrypted JSON content", async () => {
    const jsonObj = { message: "hello", data: [1, 2, 3] };
    const raw = Buffer.from(JSON.stringify(jsonObj), "utf8");
    mockFetchBytes.mockResolvedValue(raw);
    const kp = await makeKeypair();

    const result = JSON.parse(
      await executeGetAttachment(dummyConfig, kp, {
        cid: "bafkjson",
        encoding: "utf8",
      })
    );

    expect(result.was_encrypted).toBe(false);
    // Returns the original raw bytes, not re-serialized
    expect(result.size_bytes).toBe(raw.length);
  });

  it("auto-detects and decrypts an encrypted blob", async () => {
    const kp = await makeKeypair();
    const originalContent = Buffer.from("secret file content");
    const blob = await encryptBinaryForRecipients(originalContent, [
      kp.x25519PublicKey,
    ]);
    const blobBytes = Buffer.from(JSON.stringify(blob), "utf8");
    mockFetchBytes.mockResolvedValue(blobBytes);

    const result = JSON.parse(
      await executeGetAttachment(dummyConfig, kp, { cid: "bafkenc" })
    );

    expect(result.was_encrypted).toBe(true);
    expect(result.size_bytes).toBe(originalContent.length);
    const decrypted = Buffer.from(result.content, "base64");
    expect(decrypted.toString("utf8")).toBe("secret file content");
  });

  it("propagates decryption errors instead of silently falling back", async () => {
    const kp = await makeKeypair();
    const wrongKp = await makeKeypair();
    const originalContent = Buffer.from("private data");
    // Encrypt for a DIFFERENT key, so the bot can't decrypt
    const blob = await encryptBinaryForRecipients(originalContent, [
      wrongKp.x25519PublicKey,
    ]);
    const blobBytes = Buffer.from(JSON.stringify(blob), "utf8");
    mockFetchBytes.mockResolvedValue(blobBytes);

    await expect(
      executeGetAttachment(dummyConfig, kp, { cid: "bafkwrongkey" })
    ).rejects.toThrow("No recipient shard");
  });

  it("returns utf8 encoding when requested", async () => {
    const text = "Hello, world!";
    const raw = Buffer.from(text, "utf8");
    mockFetchBytes.mockResolvedValue(raw);
    const kp = await makeKeypair();

    const result = JSON.parse(
      await executeGetAttachment(dummyConfig, kp, {
        cid: "bafktxt",
        encoding: "utf8",
      })
    );

    expect(result.encoding).toBe("utf8");
    expect(result.content).toBe(text);
  });
});
