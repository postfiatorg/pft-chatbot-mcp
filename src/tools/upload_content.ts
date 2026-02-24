import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";
import { encryptBinaryForRecipients } from "../crypto/encrypt.js";
import { resolveRecipientKey } from "../crypto/resolve_key.js";

// IPFS storage is capped at 10 MB per file on the Keystone gateway.
// Encrypted blobs are slightly larger than the original due to AEAD overhead + base64 + JSON wrapper,
// so the raw content limit is set conservatively below 10 MB.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const uploadContentSchema = z.object({
  content: z
    .string()
    .describe("The content to upload (text, JSON, base64-encoded binary)"),
  content_type: z
    .string()
    .describe('MIME type (e.g., "application/json", "text/plain", "image/png")'),
  encoding: z
    .enum(["utf8", "base64"])
    .optional()
    .describe('Content encoding: "utf8" (default) or "base64" for binary'),
  encrypt_for: z
    .string()
    .optional()
    .describe(
      "Recipient PFTL wallet address. When set, encrypts the content for this recipient (and the bot) " +
      "before uploading. The resulting CID points to an encrypted blob. Pass encrypted: true and " +
      "size_bytes when referencing this attachment in send_message."
    ),
});

export type UploadContentParams = z.infer<typeof uploadContentSchema>;

export async function executeUploadContent(
  config: Config,
  grpcClient: KeystoneClient,
  params: UploadContentParams,
  keypair?: BotKeypair
): Promise<string> {
  const encoding = params.encoding || "utf8";
  const buffer =
    encoding === "base64"
      ? Buffer.from(params.content, "base64")
      : Buffer.from(params.content, "utf8");

  const originalSize = buffer.length;

  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Content too large for upload: ${buffer.length} bytes ` +
        `(max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB). ` +
        "Split into smaller parts."
    );
  }

  if (params.encrypt_for) {
    if (!keypair) {
      throw new Error("Bot keypair required for encrypted upload");
    }

    const recipientKey = await resolveRecipientKey(
      config.pftlRpcUrl,
      params.encrypt_for
    );

    const encryptedBlob = await encryptBinaryForRecipients(buffer, [
      keypair.x25519PublicKey,
      recipientKey,
    ]);

    const blobBytes = Buffer.from(JSON.stringify(encryptedBlob), "utf8");
    const result = await grpcClient.storeContent(blobBytes, "application/json");
    const cid = result.descriptor.uri.replace("ipfs://", "");

    return JSON.stringify(
      {
        cid,
        uri: result.descriptor.uri,
        content_type: params.content_type,
        size: originalSize,
        encrypted: true,
        content_hash: encryptedBlob.content_hash,
      },
      null,
      2
    );
  }

  const result = await grpcClient.storeContent(buffer, params.content_type);
  const cid = result.descriptor.uri.replace("ipfs://", "");

  return JSON.stringify(
    {
      cid,
      uri: result.descriptor.uri,
      content_type: result.descriptor.contentType,
      size: Number(result.descriptor.contentLength),
      content_hash: result.descriptor.contentHash
        ? Buffer.from(result.descriptor.contentHash).toString("hex")
        : null,
    },
    null,
    2
  );
}
