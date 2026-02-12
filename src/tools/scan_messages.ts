import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { scanMessages, type ScannedMessage } from "../chain/scanner.js";

export const scanMessagesSchema = z.object({
  since_ledger: z
    .number()
    .optional()
    .describe("Only return messages from this ledger index onwards"),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of transactions to scan (default 100)"),
  direction: z
    .enum(["inbound", "outbound", "both"])
    .optional()
    .describe("Filter by message direction (default: inbound)"),
});

export type ScanMessagesParams = z.infer<typeof scanMessagesSchema>;

export async function executeScanMessages(
  config: Config,
  keypair: BotKeypair,
  params: ScanMessagesParams
): Promise<string> {
  const messages = await scanMessages(config, keypair.address, {
    sinceLedger: params.since_ledger,
    limit: params.limit,
  });

  const direction = params.direction || "inbound";
  const filtered =
    direction === "both"
      ? messages
      : messages.filter((m) => m.direction === direction);

  const results = filtered.map((m: ScannedMessage) => ({
    tx_hash: m.txHash,
    sender: m.sender,
    recipient: m.recipient,
    direction: m.direction,
    amount_drops: m.amountDrops,
    amount_pft: m.amountDrops !== "0"
      ? (Number(m.amountDrops) / 1_000_000).toString()
      : "0",
    issued_currency: m.issuedCurrencyAmount,
    memo_type: m.memoType,
    cid: m.cid,
    thread_id: m.threadId,
    content_kind: m.contentKind,
    is_encrypted: m.isEncrypted,
    ledger_index: m.ledgerIndex,
    timestamp: m.timestamp,
    timestamp_iso: m.timestamp
      ? new Date(m.timestamp * 1000).toISOString()
      : null,
  }));

  if (results.length === 0) {
    return JSON.stringify({
      messages: [],
      count: 0,
      next_cursor: params.since_ledger || null,
      hint: "No new messages found. Call scan_messages again later, or pass a since_ledger to resume from a specific point.",
    }, null, 2);
  }

  // Compute the cursor: the highest ledger index seen + 1, so the next
  // scan picks up only new messages (deduplication).
  const maxLedger = Math.max(...results.map((r) => r.ledger_index));

  return JSON.stringify({
    messages: results,
    count: results.length,
    next_cursor: maxLedger + 1,
    hint: `Found ${results.length} message(s). Pass since_ledger=${maxLedger + 1} on your next scan_messages call to get only new messages.`,
  }, null, 2);
}
