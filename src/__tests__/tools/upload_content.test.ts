import { describe, it, expect } from "vitest";
import { uploadContentSchema } from "../../tools/upload_content.js";

describe("uploadContentSchema", () => {
  it("accepts minimal params (content + content_type)", () => {
    const result = uploadContentSchema.safeParse({
      content: "Hello World",
      content_type: "text/plain",
    });
    expect(result.success).toBe(true);
  });

  it("accepts encrypt_for param", () => {
    const result = uploadContentSchema.safeParse({
      content: "c2VjcmV0",
      content_type: "application/pdf",
      encoding: "base64",
      encrypt_for: "rRecipientAddress123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.encrypt_for).toBe("rRecipientAddress123");
    }
  });

  it("rejects invalid encoding", () => {
    const result = uploadContentSchema.safeParse({
      content: "x",
      content_type: "text/plain",
      encoding: "hex",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing content", () => {
    const result = uploadContentSchema.safeParse({
      content_type: "text/plain",
    });
    expect(result.success).toBe(false);
  });
});

describe("executeUploadContent size guard", () => {
  it("rejects content larger than 10 MB", async () => {
    const { executeUploadContent } = await import("../../tools/upload_content.js");
    const largeContent = "x".repeat(11 * 1024 * 1024);
    const dummyConfig = {
      botSeed: "", pftlRpcUrl: "", pftlWssUrl: "",
      ipfsGatewayUrl: "", keystoneGrpcUrl: "", keystoneApiKey: null, pingIntervalMs: 0,
      tasknodeEncryptionKey: null, tasknodeKeySource: null,
    };
    const mockGrpc = {} as any;
    await expect(
      executeUploadContent(dummyConfig, mockGrpc, {
        content: largeContent,
        content_type: "text/plain",
      })
    ).rejects.toThrow("too large for upload");
  });
});
