import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { fetchIpfsBytes } from "../ipfs/gateway.js";
import { isEncryptedBlob, decryptBinaryPayload } from "../crypto/decrypt.js";

export const getAttachmentSchema = z.object({
  cid: z
    .string()
    .describe("IPFS CID of the attachment to fetch"),
  encoding: z
    .enum(["base64", "utf8"])
    .optional()
    .describe('How to return the content: "base64" (default, for binary) or "utf8" (for text files)'),
});

export type GetAttachmentParams = z.infer<typeof getAttachmentSchema>;

export async function executeGetAttachment(
  config: Config,
  keypair: BotKeypair,
  params: GetAttachmentParams
): Promise<string> {
  const encoding = params.encoding || "base64";

  const rawBytes = await fetchIpfsBytes(config, params.cid);

  // Try to parse as JSON to detect encrypted blobs.
  // If it's not valid JSON, treat as raw binary.
  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(rawBytes.toString("utf8"));
  } catch {
    // Not JSON -- raw binary attachment
  }

  let resultBytes: Buffer;
  let wasEncrypted = false;

  if (parsedJson !== null && isEncryptedBlob(parsedJson)) {
    // Decryption errors must propagate -- do NOT catch here
    resultBytes = await decryptBinaryPayload(
      parsedJson,
      keypair.x25519PrivateKey,
      keypair.x25519PublicKey
    );
    wasEncrypted = true;
  } else {
    resultBytes = rawBytes;
  }

  const content = encoding === "base64"
    ? resultBytes.toString("base64")
    : resultBytes.toString("utf8");

  return JSON.stringify(
    {
      content,
      encoding,
      size_bytes: resultBytes.length,
      was_encrypted: wasEncrypted,
    },
    null,
    2
  );
}
