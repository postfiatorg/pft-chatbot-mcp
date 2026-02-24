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

  it("rejects attachments missing filename or size_bytes", () => {
    const noFilename = sendMessageSchema.safeParse({
      recipient: "rRecipient123",
      message: "missing filename",
      attachments: [
        {
          cid: "bafkreitest",
          content_type: "text/markdown",
          size_bytes: 1024,
        },
      ],
    });
    expect(noFilename.success).toBe(false);

    const noSize = sendMessageSchema.safeParse({
      recipient: "rRecipient123",
      message: "missing size",
      attachments: [
        {
          cid: "bafkreitest",
          content_type: "text/markdown",
          filename: "doc.md",
        },
      ],
    });
    expect(noSize.success).toBe(false);
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
