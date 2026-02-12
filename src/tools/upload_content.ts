import { z } from "zod";
import type { Config } from "../config.js";
import type { KeystoneClient } from "../grpc/client.js";

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
});

export type UploadContentParams = z.infer<typeof uploadContentSchema>;

export async function executeUploadContent(
  config: Config,
  grpcClient: KeystoneClient,
  params: UploadContentParams
): Promise<string> {
  // Convert content to buffer
  const encoding = params.encoding || "utf8";
  const buffer =
    encoding === "base64"
      ? Buffer.from(params.content, "base64")
      : Buffer.from(params.content, "utf8");

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
