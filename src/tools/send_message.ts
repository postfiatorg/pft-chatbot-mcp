import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";
import { encryptPayloadForRecipients } from "../crypto/encrypt.js";
import { buildPfPointerMemo, POINTER_FLAGS } from "../chain/pointer.js";
import { preparePayment, signAndSubmit } from "../chain/submitter.js";
import { getAccountInfo } from "../chain/scanner.js";
import sodium from "../crypto/sodium.js";
import { createHash } from "node:crypto";

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
        filename: z.string().optional().describe("Optional display filename"),
      })
    )
    .optional()
    .describe("Attach IPFS content (images, docs, etc.) uploaded via upload_content. Each attachment needs the CID and MIME type."),
  reply_to_tx: z
    .string()
    .optional()
    .describe("Transaction hash this message is replying to"),
  thread_id: z
    .string()
    .optional()
    .describe("Thread ID to continue a conversation"),
});

export type SendMessageParams = z.infer<typeof sendMessageSchema>;

/**
 * Resolve the recipient's X25519 public key for encryption.
 * Tries: 1) MessageKey from chain, 2) derive from SigningPubKey
 */
async function resolveRecipientKey(
  rpcUrl: string,
  recipientAddress: string
): Promise<Uint8Array> {
  await sodium.ready;

  const info = await getAccountInfo(rpcUrl, recipientAddress);

  // Try MessageKey first (explicit X25519 key published on-chain)
  if (info.messageKey) {
    return Buffer.from(info.messageKey, "hex");
  }

  // Fall back to deriving from SigningPubKey (Ed25519 -> Curve25519)
  if (info.publicKey && info.publicKey.length >= 64) {
    // PFTL public keys are prefixed with ED for Ed25519
    let pubkeyHex = info.publicKey;
    if (pubkeyHex.toUpperCase().startsWith("ED")) {
      pubkeyHex = pubkeyHex.slice(2);
    }
    const ed25519Pubkey = Buffer.from(pubkeyHex, "hex");
    if (ed25519Pubkey.length === 32) {
      return sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pubkey);
    }
  }

  throw new Error(
    `Cannot resolve encryption key for ${recipientAddress}. ` +
      `The recipient has no MessageKey set and the SigningPubKey could not be converted.`
  );
}

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

  // 3. Build plaintext payload (matches pftasks format)
  const payload: Record<string, unknown> = {
    thread_id: params.thread_id || "",
    sender_address: keypair.address,
    recipient_address: params.recipient,
    content_type: params.content_type || "text",
    message: params.message,
    amount_drops: amountDrops,
    created_at: new Date().toISOString(),
    reply_to_tx: params.reply_to_tx || undefined,
  };

  // Include attachments if provided (images, docs, etc.)
  if (params.attachments && params.attachments.length > 0) {
    payload.attachments = params.attachments.map((a) => ({
      cid: a.cid,
      uri: `ipfs://${a.cid}`,
      content_type: a.content_type,
      filename: a.filename || undefined,
    }));
  }

  const plaintext = JSON.stringify(payload);

  // 4. Encrypt for recipient + bot (2 shards)
  const encryptedBlob = await encryptPayloadForRecipients(plaintext, [
    keypair.x25519PublicKey, // bot can read its own messages
    recipientKey, // recipient can decrypt
  ]);

  // 5. Upload encrypted blob to IPFS via gRPC
  const blobBytes = Buffer.from(JSON.stringify(encryptedBlob), "utf8");
  const storeResult = await grpcClient.storeContent(
    blobBytes,
    "application/json"
  );

  // Extract CID from the descriptor URI (ipfs://bafk...)
  const cid = storeResult.descriptor.uri.replace("ipfs://", "");

  // 6. Build pf.ptr.v4 pointer memo
  const memo = await buildPfPointerMemo({
    cid,
    kind: "CHAT",
    schema: 1,
    threadId: params.thread_id,
    flags: POINTER_FLAGS.encrypted,
  });

  // 7. Prepare the Payment transaction
  const prepared = await preparePayment(
    config,
    keypair.wallet,
    params.recipient,
    amountDrops,
    memo
  );

  // 8. Sign and submit
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
