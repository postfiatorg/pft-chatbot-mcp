import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { decodeFinancialSignal } from "../signals/codec.js";
import { executeGetMessage } from "./get_message.js";

export const decodeFinancialSignalSchema = z.object({
  tx_hash: z
    .string()
    .optional()
    .describe("Transaction hash of the signal message to decode"),
  cid: z
    .string()
    .optional()
    .describe("IPFS CID of the encrypted signal payload to decode"),
});

export type DecodeFinancialSignalParams = z.infer<
  typeof decodeFinancialSignalSchema
>;

const SIGNAL_CONTENT_TYPE = "application/x-pft-signal+proto";

/**
 * Fetch, decrypt, and protobuf-decode a financial signal message.
 *
 * Flow:
 *   1. Delegates to get_message for fetch + decrypt (handles IPFS + crypto).
 *   2. Checks content_type == "application/x-pft-signal+proto".
 *   3. Base64-decodes the message field → raw protobuf bytes.
 *   4. Decodes AgentFinancialSignal + nested kind-specific payload.
 *   5. Returns structured JSON an agent can act on programmatically.
 */
export async function executeDecodeFinancialSignal(
  config: Config,
  keypair: BotKeypair,
  params: DecodeFinancialSignalParams
): Promise<string> {
  if (!params.tx_hash && !params.cid) {
    return JSON.stringify(
      { error: "Provide either tx_hash or cid" },
      null,
      2
    );
  }

  // Step 1: fetch + decrypt via existing get_message logic
  const rawResult = await executeGetMessage(config, keypair, {
    tx_hash: params.tx_hash,
    cid: params.cid,
  });

  let msg: any;
  try {
    msg = JSON.parse(rawResult);
  } catch {
    return rawResult;
  }

  if (msg.error) return rawResult;

  // Step 2: verify this is a financial signal
  if (msg.content_type !== SIGNAL_CONTENT_TYPE) {
    return JSON.stringify(
      {
        error:
          `Not a financial signal message. ` +
          `Expected content_type "${SIGNAL_CONTENT_TYPE}", ` +
          `got "${msg.content_type}". Use get_message to read it as plain text.`,
        tx_hash: msg.tx_hash ?? null,
        cid: msg.cid ?? null,
        actual_content_type: msg.content_type ?? null,
      },
      null,
      2
    );
  }

  // Step 3: base64 → bytes
  let signalBytes: Buffer;
  try {
    signalBytes = Buffer.from(msg.message as string, "base64");
  } catch {
    return JSON.stringify(
      { error: "Failed to base64-decode signal payload", cid: msg.cid },
      null,
      2
    );
  }

  // Step 4: protobuf decode
  let decoded;
  try {
    decoded = await decodeFinancialSignal(signalBytes);
  } catch (err: any) {
    return JSON.stringify(
      {
        error: `Protobuf decode failed: ${err.message}`,
        tx_hash: msg.tx_hash ?? null,
        cid: msg.cid ?? null,
      },
      null,
      2
    );
  }

  // Step 5: return envelope metadata + decoded signal
  return JSON.stringify(
    {
      tx_hash:     msg.tx_hash ?? null,
      cid:         msg.cid ?? null,
      sender:      msg.sender ?? null,
      recipient:   msg.recipient ?? null,
      amount_drops:msg.amount_drops ?? null,
      thread_id:   msg.thread_id ?? null,
      timestamp:   msg.timestamp ?? null,
      signal:      decoded,
    },
    null,
    2
  );
}
