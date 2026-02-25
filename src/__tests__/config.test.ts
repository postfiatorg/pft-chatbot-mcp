import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig – TASKNODE_ENCRYPTION_PUBKEY", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_SEED: "test-seed-for-config-tests" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function freshLoadConfig() {
    const mod = await import("../config.js?t=" + Date.now());
    return mod.loadConfig();
  }

  it("uses testnet default key when env var is unset", async () => {
    delete process.env.TASKNODE_ENCRYPTION_PUBKEY;
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeInstanceOf(Uint8Array);
    expect(config.tasknodeEncryptionKey!.length).toBe(32);
    expect(config.tasknodeKeySource).toBe("testnet default");
  });

  it("disables sharing when set to empty string", async () => {
    process.env.TASKNODE_ENCRYPTION_PUBKEY = "";
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeNull();
    expect(config.tasknodeKeySource).toBeNull();
  });

  it("disables sharing when set to 'none'", async () => {
    process.env.TASKNODE_ENCRYPTION_PUBKEY = "none";
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeNull();
    expect(config.tasknodeKeySource).toBeNull();
  });

  it("accepts a valid 32-byte base64 key", async () => {
    const validKey = Buffer.alloc(32, 0x42).toString("base64");
    process.env.TASKNODE_ENCRYPTION_PUBKEY = validKey;
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeInstanceOf(Uint8Array);
    expect(config.tasknodeEncryptionKey!.length).toBe(32);
    expect(config.tasknodeKeySource).toBe("custom key");
  });

  it("throws on invalid base64 / wrong length", async () => {
    process.env.TASKNODE_ENCRYPTION_PUBKEY = "dG9vc2hvcnQ="; // "tooshort" -> 8 bytes
    await expect(freshLoadConfig()).rejects.toThrow("expected 32 bytes");
  });
});
