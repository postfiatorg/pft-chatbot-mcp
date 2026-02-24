import { describe, it, expect } from "vitest";
import { sendMessageSchema } from "../../tools/send_message.js";

describe("sendMessageSchema", () => {
  it("accepts message with size_bytes and encrypted on attachments", () => {
    const result = sendMessageSchema.safeParse({
      recipient: "rRecipient123",
      message: "Here is the file",
      attachments: [
        {
          cid: "bafkreitest",
          content_type: "application/pdf",
          filename: "report.pdf",
          size_bytes: 12345,
          encrypted: true,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments![0].size_bytes).toBe(12345);
      expect(result.data.attachments![0].encrypted).toBe(true);
    }
  });

  it("accepts attachments without size_bytes (backward compat)", () => {
    const result = sendMessageSchema.safeParse({
      recipient: "rRecipient123",
      message: "legacy",
      attachments: [
        {
          cid: "bafkreitest",
          content_type: "text/markdown",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments![0].size_bytes).toBeUndefined();
      expect(result.data.attachments![0].encrypted).toBeUndefined();
    }
  });

  it("accepts message without attachments", () => {
    const result = sendMessageSchema.safeParse({
      recipient: "rRecipient123",
      message: "just text",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing recipient", () => {
    const result = sendMessageSchema.safeParse({
      message: "no recipient",
    });
    expect(result.success).toBe(false);
  });
});
