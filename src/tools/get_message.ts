import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { fetchIpfsJson } from "../ipfs/gateway.js";
import { decryptPayload, hasRecipientShard } from "../crypto/decrypt.js";
import { scanMessages } from "../chain/scanner.js";

export const getMessageSchema = z.object({
  tx_hash: z
    .string()
    .optional()
    .describe("Transaction hash of the message to retrieve"),
  cid: z
    .string()
    .optional()
    .describe("IPFS CID of the encrypted payload to retrieve"),
});

export type GetMessageParams = z.infer<typeof getMessageSchema>;

export async function executeGetMessage(
  config: Config,
  keypair: BotKeypair,
  params: GetMessageParams
): Promise<string> {
  if (!params.tx_hash && !params.cid) {
    return "Error: provide either tx_hash or cid";
  }

  let cid = params.cid || null;
  let sender = "";
  let recipient = "";
  let amountDrops = "0";
  let threadId = "";
  let timestamp = 0;

  // If tx_hash provided, scan for the specific transaction to get its CID
  if (params.tx_hash && !cid) {
    const messages = await scanMessages(config, keypair.address, { limit: 200 });
    const msg = messages.find((m) => m.txHash === params.tx_hash);
    if (!msg) {
      return `Error: transaction ${params.tx_hash} not found in recent history`;
    }
    cid = msg.cid;
    sender = msg.sender;
    recipient = msg.recipient;
    amountDrops = msg.amountDrops;
    threadId = msg.threadId || "";
    timestamp = msg.timestamp;

    if (!cid) {
      return "Error: transaction has no IPFS CID (may be a Keystone envelope with inline content)";
    }
  }

  // Fetch the encrypted payload from IPFS
  const blob = await fetchIpfsJson(config, cid!);

  // Check if we can decrypt it
  if (!hasRecipientShard(blob, keypair.x25519PublicKey)) {
    return JSON.stringify(
      {
        error: "Message was not encrypted for this bot",
        cid,
        sender,
        recipient,
        encrypted: true,
        can_decrypt: false,
      },
      null,
      2
    );
  }

  // Decrypt
  const plaintext = await decryptPayload(
    blob,
    keypair.x25519PrivateKey,
    keypair.x25519PublicKey
  );

  // Parse the decrypted content
  let parsed: any;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    parsed = { message: plaintext };
  }

  return JSON.stringify(
    {
      tx_hash: params.tx_hash || null,
      cid,
      sender: parsed.sender_address || sender,
      recipient: parsed.recipient_address || recipient,
      message: parsed.message || parsed.content || parsed.text || plaintext,
      content_type: parsed.content_type || "text",
      amount_drops: parsed.amount_drops || amountDrops,
      thread_id: parsed.thread_id || threadId,
      timestamp: timestamp
        ? new Date(timestamp * 1000).toISOString()
        : parsed.created_at || null,
    },
    null,
    2
  );
}
