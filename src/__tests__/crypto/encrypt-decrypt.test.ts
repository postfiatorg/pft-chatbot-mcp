import { describe, it, expect } from "vitest";
import sodium from "../../crypto/sodium.js";
import {
  encryptPayloadForRecipients,
  encryptBinaryForRecipients,
} from "../../crypto/encrypt.js";
import {
  decryptPayload,
  decryptBinaryPayload,
  isEncryptedBlob,
} from "../../crypto/decrypt.js";

async function makeKeypair() {
  await sodium.ready;
  return sodium.crypto_box_keypair();
}

describe("encryptPayloadForRecipients / decryptPayload (text round-trip)", () => {
  it("encrypts and decrypts a simple message for one recipient", async () => {
    const kp = await makeKeypair();
    const plaintext = "Hello from the test suite";
    const blob = await encryptPayloadForRecipients(plaintext, [kp.publicKey]);

    expect(blob.version).toBe(1);
    expect(blob.enc).toBe("ENC_X25519_XCHACHA20P1305");
    expect(blob.recipients).toHaveLength(1);

    const result = await decryptPayload(blob, kp.privateKey, kp.publicKey);
    expect(result).toBe(plaintext);
  });

  it("encrypts for two recipients and both can decrypt", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const plaintext = '{"thread_id":"t1","message":"multi"}';

    const blob = await encryptPayloadForRecipients(plaintext, [
      kp1.publicKey,
      kp2.publicKey,
    ]);
    expect(blob.recipients).toHaveLength(2);

    const r1 = await decryptPayload(blob, kp1.privateKey, kp1.publicKey);
    const r2 = await decryptPayload(blob, kp2.privateKey, kp2.publicKey);
    expect(r1).toBe(plaintext);
    expect(r2).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const blob = await encryptPayloadForRecipients("secret", [kp1.publicKey]);

    await expect(
      decryptPayload(blob, kp2.privateKey, kp2.publicKey)
    ).rejects.toThrow("No recipient shard");
  });
});

describe("encryptBinaryForRecipients / decryptBinaryPayload (binary round-trip)", () => {
  it("encrypts and decrypts binary content", async () => {
    const kp = await makeKeypair();
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    const blob = await encryptBinaryForRecipients(original, [kp.publicKey]);

    expect(blob.version).toBe(1);
    expect(isEncryptedBlob(blob)).toBe(true);

    const decrypted = await decryptBinaryPayload(blob, kp.privateKey, kp.publicKey);
    expect(Buffer.compare(decrypted, original)).toBe(0);
  });

  it("preserves exact bytes for a large buffer", async () => {
    const kp = await makeKeypair();
    await sodium.ready;
    const original = Buffer.from(sodium.randombytes_buf(4096));

    const blob = await encryptBinaryForRecipients(original, [kp.publicKey]);
    const decrypted = await decryptBinaryPayload(blob, kp.privateKey, kp.publicKey);
    expect(Buffer.compare(decrypted, original)).toBe(0);
  });
});

describe("content_hash integrity", () => {
  it("blob.content_hash matches sha256 of original text", async () => {
    const { createHash } = await import("node:crypto");
    const kp = await makeKeypair();
    const plaintext = "verify this hash";
    const blob = await encryptPayloadForRecipients(plaintext, [kp.publicKey]);

    const expected = createHash("sha256")
      .update(Buffer.from(plaintext, "utf8"))
      .digest("hex");
    expect(blob.content_hash).toBe(expected);
  });

  it("blob.content_hash matches sha256 of original binary", async () => {
    const { createHash } = await import("node:crypto");
    const kp = await makeKeypair();
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const blob = await encryptBinaryForRecipients(original, [kp.publicKey]);

    const expected = createHash("sha256").update(original).digest("hex");
    expect(blob.content_hash).toBe(expected);
  });

  it("decryption throws on tampered content_hash", async () => {
    const kp = await makeKeypair();
    const blob = await encryptPayloadForRecipients("original", [kp.publicKey]);
    blob.content_hash = "0000000000000000000000000000000000000000000000000000000000000000";

    await expect(
      decryptPayload(blob, kp.privateKey, kp.publicKey)
    ).rejects.toThrow("Content hash mismatch");
  });
});

describe("empty content edge cases", () => {
  it("encrypts and decrypts empty string", async () => {
    const kp = await makeKeypair();
    const blob = await encryptPayloadForRecipients("", [kp.publicKey]);
    const result = await decryptPayload(blob, kp.privateKey, kp.publicKey);
    expect(result).toBe("");
  });

  it("encrypts and decrypts empty buffer", async () => {
    const kp = await makeKeypair();
    const empty = Buffer.alloc(0);
    const blob = await encryptBinaryForRecipients(empty, [kp.publicKey]);
    const result = await decryptBinaryPayload(blob, kp.privateKey, kp.publicKey);
    expect(result.length).toBe(0);
  });
});

describe("isEncryptedBlob", () => {
  it("returns true for a valid blob", () => {
    expect(
      isEncryptedBlob({
        version: 1,
        enc: "ENC_X25519_XCHACHA20P1305",
        nonce: "abc",
        ciphertext: "def",
        recipients: [],
      })
    ).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob(undefined)).toBe(false);
  });

  it("returns false for plain JSON", () => {
    expect(isEncryptedBlob({ message: "hello" })).toBe(false);
  });

  it("returns false for wrong enc suite", () => {
    expect(
      isEncryptedBlob({
        version: 1,
        enc: "AES_GCM",
        nonce: "x",
        ciphertext: "y",
        recipients: [],
      })
    ).toBe(false);
  });
});
