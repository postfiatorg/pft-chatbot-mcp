import { z } from "zod";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";
import { encryptPayloadForRecipients } from "../crypto/encrypt.js";
import { resolveRecipientKey } from "../crypto/resolve_key.js";
import { buildKeystoneEnvelopeMemo } from "../chain/pointer.js";
import { preparePayment, signAndSubmit } from "../chain/submitter.js";

export const sendMessageSchema = z.object({
  recipient: z
    .string()
    .describe("PFTL wallet address of the recipient (r-address)"),
  message: z.string().describe("The message text to send"),
  content_type: z
    .string()
    .optional()
    .describe('MIME type of the content (default: "text")'),
  amount_pft: z
    .string()
    .optional()
    .describe("Amount of PFT to send (e.g. \"10\" for 10 PFT). Converted to drops automatically. Default: 0.000001 PFT (1 drop)."),
  amount_drops: z
    .string()
    .optional()
    .describe("Amount of PFT in drops for fine control (1 PFT = 1,000,000 drops). Ignored if amount_pft is set."),
  attachments: z
    .array(
      z.object({
        cid: z.string().describe("IPFS CID of the uploaded content (from upload_content)"),
        content_type: z.string().describe('MIME type (e.g. "image/png", "application/pdf", "text/markdown")'),
        filename: z.string().describe("Display filename (e.g. \"chart.png\", \"report.pdf\")"),
        size_bytes: z.number().describe("Original file size in bytes (from upload_content response). Displayed in recipient's UI."),
        encrypted: z.boolean().optional().describe("True if the attachment content at this CID is encrypted (uploaded via upload_content with encrypt_for)."),
      })
    )
    .optional()
    .describe("Attach IPFS content uploaded via upload_content. Include size_bytes from the upload response for proper FE display. Set encrypted: true for attachments uploaded with encrypt_for."),
  reply_to_tx: z
    .string()
    .optional()
    .describe("Transaction hash this message is replying to"),
  thread_id: z
    .string()
    .optional()
    .describe("Thread ID to continue a conversation"),
  share_with_tasknode: z
    .boolean()
    .optional()
    .describe(
      "Share message with the TaskNode for task processing and server-side previews. " +
        "When true (default), the encrypted blob includes a recipient shard for the TaskNode. " +
        "Set false for fully private end-to-end encrypted messages."
    ),
});

export type SendMessageParams = z.infer<typeof sendMessageSchema>;

export async function executeSendMessage(
  config: Config,
  keypair: BotKeypair,
  grpcClient: KeystoneClient,
  params: SendMessageParams
): Promise<string> {
  // 1. Resolve recipient's encryption key
  const recipientKey = await resolveRecipientKey(
    config.pftlRpcUrl,
    params.recipient
  );

  // 2. Determine PFT amount in drops
  let amountDrops: string;
  if (params.amount_pft) {
    // Convert PFT to drops (1 PFT = 1,000,000 drops)
    const pftValue = parseFloat(params.amount_pft);
    if (isNaN(pftValue) || pftValue < 0) {
      throw new Error(`Invalid amount_pft: "${params.amount_pft}". Must be a positive number.`);
    }
    amountDrops = Math.round(pftValue * 1_000_000).toString();
  } else {
    amountDrops = params.amount_drops || "1";
  }

  const amountPft = (Number(amountDrops) / 1_000_000).toString();

  // 3. Determine tasknode sharing
  const shareWithTasknode =
    params.share_with_tasknode !== false && config.tasknodeEncryptionKey != null;

  // 4. Build plaintext payload (matches pftasks format)
  const payload: Record<string, unknown> = {
    thread_id: params.thread_id || "",
    sender_address: keypair.address,
    recipient_address: params.recipient,
    content_type: shareWithTasknode
      ? params.content_type || "text"
      : "encrypted",
    message: params.message,
    amount_drops: amountDrops,
    created_at: new Date().toISOString(),
    reply_to_tx: params.reply_to_tx || undefined,
  };

  if (params.attachments && params.attachments.length > 0) {
    payload.attachments = params.attachments.map((a) => ({
      cid: a.cid,
      uri: `ipfs://${a.cid}`,
      content_type: a.content_type,
      filename: a.filename,
      size_bytes: a.size_bytes,
      ...(a.encrypted ? { encrypted: true } : {}),
    }));
  }

  const plaintext = JSON.stringify(payload);

  // 5. Encrypt for bot + recipient (+ optionally tasknode)
  const recipientKeys: Uint8Array[] = [
    keypair.x25519PublicKey,
    recipientKey,
  ];
  if (shareWithTasknode) {
    recipientKeys.push(config.tasknodeEncryptionKey!);
  }
  const encryptedBlob = await encryptPayloadForRecipients(
    plaintext,
    recipientKeys
  );

  // 6. Upload encrypted blob to IPFS via gRPC
  const blobBytes = Buffer.from(JSON.stringify(encryptedBlob), "utf8");
  const storeResult = await grpcClient.storeContent(
    blobBytes,
    "application/json"
  );

  const cid = storeResult.descriptor.uri.replace("ipfs://", "");

  // 7. Build Keystone v1 envelope memo
  const contentHash = createHash("sha256").update(blobBytes).digest("hex");
  const memo = await buildKeystoneEnvelopeMemo({
    cid,
    contentHash,
    contentLength: blobBytes.length,
    contentType: "application/json",
  });

  // 8. Prepare the Payment transaction
  const prepared = await preparePayment(
    config,
    keypair.wallet,
    params.recipient,
    amountDrops,
    memo
  );

  // 9. Sign and submit
  const result = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  if (result.result !== "tesSUCCESS") {
    return JSON.stringify(
      {
        error: `Transaction failed: ${result.result}`,
        tx_hash: result.txHash,
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      tx_hash: result.txHash,
      cid,
      thread_id: params.thread_id || null,
      recipient: params.recipient,
      amount_pft: amountPft,
      amount_drops: amountDrops,
      result: result.result,
    },
    null,
    2
  );
}
