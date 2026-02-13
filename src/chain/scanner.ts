import type { Config } from "../config.js";
import {
  identifyMemoType,
  decodePfPointer,
  decodeKeystoneEnvelope,
  type DecodedMemo,
  type MemoType,
} from "./pointer.js";

/** Parsed amount for issued currencies (non-PFT tokens on PFTL) */
export interface IssuedCurrencyAmount {
  currency: string;
  issuer: string;
  value: string;
}

export interface ScannedMessage {
  txHash: string;
  sender: string;
  recipient: string;
  direction: "inbound" | "outbound";
  /** PFT amount in drops (native currency). 1 PFT = 1,000,000 drops. */
  amountDrops: string;
  /** Issued currency amount (for non-PFT tokens on the PFTL chain, null for native PFT) */
  issuedCurrencyAmount: IssuedCurrencyAmount | null;
  memoType: MemoType;
  /** CID from pf.ptr pointer, or null for keystone envelopes */
  cid: string | null;
  threadId: string | null;
  contentKind: string | null;
  isEncrypted: boolean;
  ledgerIndex: number;
  timestamp: number;
  decodedMemo: DecodedMemo;
}

/**
 * Call account_tx via JSON-RPC to fetch recent transactions for a wallet.
 */
async function accountTx(
  rpcUrl: string,
  account: string,
  limit: number = 100,
  ledgerIndexMin?: number
): Promise<any[]> {
  const params: any = {
    account,
    limit,
    forward: false,
  };
  if (ledgerIndexMin) {
    params.ledger_index_min = ledgerIndexMin;
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_tx",
      params: [params],
    }),
  });

  if (!response.ok) {
    throw new Error(`account_tx failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as any;
  if (json.result?.error) {
    throw new Error(`account_tx error: ${json.result.error_message || json.result.error}`);
  }

  return json.result?.transactions || [];
}

/**
 * Resolve the close_time of a ledger to a Unix timestamp.
 * PFTL (like XRPL) epoch starts at 2000-01-01T00:00:00Z (946684800 seconds after Unix epoch).
 */
function rippleTimeToUnix(rippleTime: number): number {
  return rippleTime + 946684800;
}

/**
 * Scan the bot's wallet for recent messages.
 * Returns decoded messages with memo type, CID, sender, amount, etc.
 */
export async function scanMessages(
  config: Config,
  botAddress: string,
  options: { sinceLedger?: number; limit?: number } = {}
): Promise<ScannedMessage[]> {
  const txs = await accountTx(
    config.pftlRpcUrl,
    botAddress,
    options.limit || 100,
    options.sinceLedger
  );

  const messages: ScannedMessage[] = [];

  for (const entry of txs) {
    const tx = entry.tx || entry.tx_json;
    const meta = entry.meta || entry.metadata;

    if (!tx || !meta) continue;

    // Only process successful Payment transactions
    if (tx.TransactionType !== "Payment") continue;
    if (
      meta.TransactionResult !== "tesSUCCESS" &&
      meta.TransactionResult !== undefined
    )
      continue;

    // Must have memos
    const memos = tx.Memos;
    if (!memos || !Array.isArray(memos) || memos.length === 0) continue;

    for (let i = 0; i < memos.length; i++) {
      const memo = memos[i]?.Memo;
      if (!memo?.MemoType || !memo?.MemoData) continue;

      const memoTypeHex = memo.MemoType;
      const memoFormatHex = memo.MemoFormat || "";
      const memoDataHex = memo.MemoData;

      const memoType = identifyMemoType(memoTypeHex, memoFormatHex);
      if (memoType === "unknown") continue;

      let decodedMemo: DecodedMemo = null;
      let cid: string | null = null;
      let threadId: string | null = null;
      let contentKind: string | null = null;
      let isEncrypted = false;

      try {
        if (memoType === "pf.ptr") {
          const pointer = await decodePfPointer(memoDataHex);
          decodedMemo = pointer;
          cid = pointer.cid;
          threadId = pointer.threadId || null;
          contentKind = pointer.kind;
          isEncrypted = pointer.isEncrypted;

          // Only include CHAT messages by default
          if (pointer.kind !== "CHAT" && pointer.kind !== "4") continue;
        } else if (memoType === "keystone") {
          const envelope = await decodeKeystoneEnvelope(memoDataHex);
          decodedMemo = envelope;
          isEncrypted =
            envelope.encryption === "ENCRYPTION_MODE_PUBLIC_KEY" ||
            envelope.encryption === "ENCRYPTION_MODE_PROTECTED";
          // Extract CID from metadata if present
          cid = envelope.metadata?.cid || null;
        }
      } catch {
        // Skip memos we can't decode
        continue;
      }

      const sender = tx.Account;
      const recipient = tx.Destination;
      const direction = sender === botAddress ? "outbound" : "inbound";

      // Parse Amount: string = PFT drops (native), object = issued currency (other tokens)
      let amountDrops = "0";
      let issuedCurrencyAmount: IssuedCurrencyAmount | null = null;
      if (typeof tx.Amount === "string") {
        amountDrops = tx.Amount;
      } else if (tx.Amount && typeof tx.Amount === "object") {
        issuedCurrencyAmount = {
          currency: tx.Amount.currency,
          issuer: tx.Amount.issuer,
          value: tx.Amount.value,
        };
      }

      messages.push({
        txHash: tx.hash || entry.hash || "",
        sender,
        recipient,
        direction,
        amountDrops,
        issuedCurrencyAmount,
        memoType,
        cid,
        threadId,
        contentKind,
        isEncrypted,
        ledgerIndex: entry.ledger_index || tx.ledger_index || 0,
        timestamp: tx.date ? rippleTimeToUnix(tx.date) : 0,
        decodedMemo,
      });
    }
  }

  return messages;
}

/**
 * Fetch account_info for a wallet address.
 * Returns the public key and balance.
 */
export async function getAccountInfo(
  rpcUrl: string,
  address: string
): Promise<{
  publicKey: string;
  balance: string;
  messageKey?: string;
}> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address }],
    }),
  });

  const json = (await response.json()) as any;
  if (json.result?.error) {
    throw new Error(
      `account_info error: ${json.result.error_message || json.result.error}`
    );
  }

  const data = json.result?.account_data;
  return {
    publicKey: data?.RegularKey || data?.SigningPubKey || "",
    balance: data?.Balance || "0",
    messageKey: data?.MessageKey,
  };
}

/** A single trust line returned by account_lines */
export interface TrustLine {
  currency: string;
  issuer: string;
  balance: string;
  limit: string;
}

/**
 * Fetch account_lines for a wallet address.
 * Returns the list of trust lines (issued currency balances and limits).
 */
export async function getAccountLines(
  rpcUrl: string,
  address: string
): Promise<TrustLine[]> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_lines",
      params: [{ account: address }],
    }),
  });

  const json = (await response.json()) as any;
  if (json.result?.error) {
    throw new Error(
      `account_lines error: ${json.result.error_message || json.result.error}`
    );
  }

  const lines = json.result?.lines || [];
  return lines.map((line: any) => ({
    currency: line.currency || "",
    issuer: line.account || "",
    balance: line.balance || "0",
    limit: line.limit || "0",
  }));
}
