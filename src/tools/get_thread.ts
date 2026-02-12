import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { scanMessages, type ScannedMessage } from "../chain/scanner.js";
import { fetchIpfsJson } from "../ipfs/gateway.js";
import {
  decryptPayload,
  hasRecipientShard,
} from "../crypto/decrypt.js";

export const getThreadSchema = z.object({
  thread_id: z
    .string()
    .optional()
    .describe("Thread ID to fetch all messages for"),
  contact_address: z
    .string()
    .optional()
    .describe("Wallet address to fetch all messages exchanged with"),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of transactions to scan (default: 200)"),
  decrypt: z
    .boolean()
    .optional()
    .describe("Whether to decrypt message contents (default: true)"),
});

export type GetThreadParams = z.infer<typeof getThreadSchema>;

export async function executeGetThread(
  config: Config,
  keypair: BotKeypair,
  params: GetThreadParams
): Promise<string> {
  if (!params.thread_id && !params.contact_address) {
    return "Error: provide either thread_id or contact_address";
  }

  const allMessages = await scanMessages(config, keypair.address, {
    limit: params.limit || 200,
  });

  // Filter by thread_id or contact address
  let filtered: ScannedMessage[];
  if (params.thread_id) {
    filtered = allMessages.filter((m) => m.threadId === params.thread_id);
  } else {
    filtered = allMessages.filter(
      (m) =>
        m.sender === params.contact_address ||
        m.recipient === params.contact_address
    );
  }

  if (filtered.length === 0) {
    return "No messages found in this thread.";
  }

  // Sort by ledger index (chronological)
  filtered.sort((a, b) => a.ledgerIndex - b.ledgerIndex);

  const shouldDecrypt = params.decrypt !== false;
  const results: any[] = [];

  for (const msg of filtered) {
    const entry: any = {
      tx_hash: msg.txHash,
      sender: msg.sender,
      recipient: msg.recipient,
      direction: msg.direction,
      amount_drops: msg.amountDrops,
      timestamp: msg.timestamp
        ? new Date(msg.timestamp * 1000).toISOString()
        : null,
      cid: msg.cid,
      is_encrypted: msg.isEncrypted,
    };

    // Attempt decryption if requested and possible
    if (shouldDecrypt && msg.cid && msg.isEncrypted) {
      try {
        const blob = await fetchIpfsJson(config, msg.cid);
        if (hasRecipientShard(blob, keypair.x25519PublicKey)) {
          const plaintext = await decryptPayload(
            blob,
            keypair.x25519PrivateKey,
            keypair.x25519PublicKey
          );
          try {
            const parsed = JSON.parse(plaintext);
            entry.message =
              parsed.message || parsed.content || parsed.text || plaintext;
            entry.content_type = parsed.content_type || "text";
          } catch {
            entry.message = plaintext;
            entry.content_type = "text";
          }
          entry.decrypted = true;
        } else {
          entry.decrypted = false;
          entry.message = "[encrypted - not addressed to this bot]";
        }
      } catch (err: any) {
        entry.decrypted = false;
        entry.decrypt_error = err.message;
      }
    }

    results.push(entry);
  }

  return JSON.stringify(
    {
      thread_id: params.thread_id || null,
      contact_address: params.contact_address || null,
      message_count: results.length,
      messages: results,
    },
    null,
    2
  );
}
