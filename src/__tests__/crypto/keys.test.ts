import { describe, it, expect } from "vitest";
import { deriveBotKeypair, recipientId } from "../../crypto/keys.js";
import { createHash } from "node:crypto";

const TEST_SEED = "sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r"; // deterministic test seed

describe("deriveBotKeypair", () => {
  it("derives consistent keypairs from the same seed", async () => {
    const kp1 = await deriveBotKeypair(TEST_SEED);
    const kp2 = await deriveBotKeypair(TEST_SEED);

    expect(kp1.address).toBe(kp2.address);
    expect(Buffer.from(kp1.x25519PublicKey).toString("hex")).toBe(
      Buffer.from(kp2.x25519PublicKey).toString("hex")
    );
    expect(Buffer.from(kp1.x25519PrivateKey).toString("hex")).toBe(
      Buffer.from(kp2.x25519PrivateKey).toString("hex")
    );
  });

  it("X25519 keys are 32 bytes", async () => {
    const kp = await deriveBotKeypair(TEST_SEED);
    expect(kp.x25519PublicKey.length).toBe(32);
    expect(kp.x25519PrivateKey.length).toBe(32);
  });

  it("wallet address starts with r", async () => {
    const kp = await deriveBotKeypair(TEST_SEED);
    expect(kp.address).toMatch(/^r[a-zA-Z0-9]+$/);
  });
});

describe("recipientId", () => {
  it("returns SHA-256 hex of the public key", async () => {
    const kp = await deriveBotKeypair(TEST_SEED);
    const rid = recipientId(kp.x25519PublicKey);
    const expected = createHash("sha256").update(kp.x25519PublicKey).digest("hex");
    expect(rid).toBe(expected);
    expect(rid).toHaveLength(64);
  });
});
