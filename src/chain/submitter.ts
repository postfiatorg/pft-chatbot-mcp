import { Wallet } from "xrpl";
import type { Config } from "../config.js";

export interface PreparedTransaction {
  txJson: any;
  fee: string;
}

/** PFTL Amount: either PFT drops (string) or issued currency (object) */
export type PftlAmount =
  | string
  | { currency: string; issuer: string; value: string };

// ---------------------------------------------------------------------------
// HTTP JSON-RPC helpers (no WebSocket dependency)
// ---------------------------------------------------------------------------

/**
 * Call a JSON-RPC method and return its `result` object as-is, including an
 * RPC-level `error` field. Throws on transport failure, a non-2xx HTTP status,
 * an unparseable body, or a body without a `result` object.
 */
async function rpcRequest(rpcUrl: string, method: string, params: any = {}): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  if (!resp.ok) {
    throw new Error(`RPC ${method} HTTP ${resp.status}: ${resp.statusText}`);
  }
  const json = (await resp.json()) as any;
  if (json == null || typeof json.result !== "object" || json.result === null) {
    throw new Error(`RPC ${method}: response has no result object`);
  }
  return json.result;
}

/**
 * Call a JSON-RPC method on the PFTL HTTP endpoint; RPC errors throw.
 */
async function rpcCall(rpcUrl: string, method: string, params: any = {}): Promise<any> {
  const result = await rpcRequest(rpcUrl, method, params);
  if (result.error) {
    throw new Error(`RPC ${method}: ${result.error_message || result.error}`);
  }
  return result;
}

interface LedgerInfo {
  sequence: number;
  validatedSeq: number;
  feeDrops: string;
  networkId: number | undefined;
}

/**
 * Fetch account sequence, validated ledger, base fee, and network ID
 * from the PFTL HTTP RPC. Used to autofill transactions without WSS.
 */
async function fetchLedgerInfo(rpcUrl: string, account: string): Promise<LedgerInfo> {
  const [accountInfo, serverInfo] = await Promise.all([
    rpcCall(rpcUrl, "account_info", { account, ledger_index: "current" }),
    rpcCall(rpcUrl, "server_info", {}),
  ]);

  const sequence = accountInfo.account_data?.Sequence;
  if (sequence == null) {
    throw new Error("Could not read account Sequence from account_info");
  }

  const info = serverInfo.info;
  const validatedSeq = info?.validated_ledger?.seq;
  const baseFee = info?.validated_ledger?.base_fee_xrp;
  if (!validatedSeq) {
    throw new Error("Could not read validated_ledger from server_info");
  }

  const feeDrops = baseFee
    ? Math.ceil(parseFloat(baseFee) * 1_000_000).toString()
    : "12";

  return {
    sequence,
    validatedSeq,
    feeDrops,
    networkId: info?.network_id,
  };
}

/**
 * Final or provisional state of a submitted transaction.
 *
 * - `validated`: included in a validated ledger; `result` is the ledger's
 *   `meta.TransactionResult` (which may still be a `tec` failure code).
 * - `expired`: the validated ledger passed the transaction's
 *   `LastLedgerSequence` AND a `tx` lookup bounded to the ledgers it could
 *   have landed in returned `txnNotFound` with `searched_all: true`; it can
 *   never be applied and may safely be resent with a new sequence.
 * - `pending`: not final. Either still in flight when polling stopped, or
 *   `LastLedgerSequence` passed but absence could not be established
 *   authoritatively (lookup failed, HTTP error, bad JSON, another RPC error,
 *   or an incomplete search). It may already be validated; callers must not
 *   resend, and should check `txHash` first.
 * - `rejected`: `submit` returned something other than `tesSUCCESS` or
 *   `terQUEUED`; `result` is that provisional engine result.
 */
export type SubmissionStatus = "validated" | "expired" | "pending" | "rejected";

export interface SubmissionOutcome {
  txHash: string;
  /** Engine/ledger result code, or a short description for `pending`/`expired`. */
  result: string;
  status: SubmissionStatus;
  /** The transaction's LastLedgerSequence, when known. */
  lastLedgerSequence?: number;
  /** The last validated ledger observed while polling, when known. */
  lastValidatedLedger?: number;
}

export interface PollOptions {
  /** Delay between polls in ms (default 2000). */
  intervalMs?: number;
  /** Maximum number of polls (default 30). */
  maxAttempts?: number;
}

/**
 * Submit a signed transaction blob and poll until it is validated, expires,
 * or the polling budget runs out.
 *
 * Reliable submission: a transaction is reported as `expired` (final) only
 * when the validated ledger has passed its LastLedgerSequence and an
 * authoritative, ledger-ranged `tx` lookup confirms it is absent; anything
 * less (still in flight, or an unavailable/ambiguous final lookup) is
 * reported as `pending` (not final). Previously both
 * came back as a free-text "not yet validated" result that callers treated as
 * a failure, which invited resending a payment that could still validate.
 */
export async function submitAndPoll(
  rpcUrl: string,
  signedTxBlob: string,
  txHash: string,
  lastLedgerSequence?: number,
  options: PollOptions = {}
): Promise<SubmissionOutcome> {
  const intervalMs = options.intervalMs ?? 2000;
  const maxAttempts = options.maxAttempts ?? 30;

  // Lower bound for the authoritative final lookup: the transaction cannot be
  // in a ledger that was already validated before it was submitted. Without
  // this bound the final lookup cannot be ledger-ranged, so expiry is never
  // declared (the outcome stays `pending`).
  let minLedger: number | undefined;
  if (lastLedgerSequence != null) {
    try {
      const serverInfo = await rpcCall(rpcUrl, "server_info", {});
      const seq = serverInfo.info?.validated_ledger?.seq;
      if (typeof seq === "number") {
        minLedger = Math.min(seq, lastLedgerSequence);
      }
    } catch {
      // unknown: expiry cannot be established authoritatively
    }
  }

  const submitResult = await rpcCall(rpcUrl, "submit", {
    tx_blob: signedTxBlob,
  });

  const engineResult = submitResult.engine_result;
  if (engineResult !== "tesSUCCESS" && engineResult !== "terQUEUED") {
    return {
      txHash,
      result: engineResult || "unknown",
      status: "rejected",
      lastLedgerSequence,
    };
  }

  let lastValidatedLedger: number | undefined;
  let unresolvedExpiry: string | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    if (intervalMs > 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    try {
      const txResult = await rpcCall(rpcUrl, "tx", { transaction: txHash });
      if (txResult.validated) {
        const meta = txResult.meta || {};
        return {
          txHash,
          result: meta.TransactionResult || engineResult || "tesSUCCESS",
          status: "validated",
          lastLedgerSequence,
          lastValidatedLedger: txResult.ledger_index ?? lastValidatedLedger,
        };
      }
    } catch {
      // tx not found yet (or transient RPC error); keep polling
    }

    if (lastLedgerSequence != null) {
      let validatedSeq: unknown;
      try {
        const serverInfo = await rpcCall(rpcUrl, "server_info", {});
        validatedSeq = serverInfo.info?.validated_ledger?.seq;
      } catch {
        // server_info unavailable; expiry cannot be decided this round
      }
      if (typeof validatedSeq === "number") {
        lastValidatedLedger = validatedSeq;
        if (validatedSeq > lastLedgerSequence) {
          const final = await finalTxLookup(rpcUrl, txHash, minLedger, lastLedgerSequence);
          if (final.kind === "validated") {
            const meta = final.txResult.meta || {};
            return {
              txHash,
              result: meta.TransactionResult || engineResult || "tesSUCCESS",
              status: "validated",
              lastLedgerSequence,
              lastValidatedLedger: final.txResult.ledger_index ?? validatedSeq,
            };
          }
          if (final.kind === "absent") {
            return {
              txHash,
              result: `expired: LastLedgerSequence ${lastLedgerSequence} passed (validated ledger ${validatedSeq}) and tx returned txnNotFound with searched_all over ledgers ${minLedger}-${lastLedgerSequence}`,
              status: "expired",
              lastLedgerSequence,
              lastValidatedLedger: validatedSeq,
            };
          }
          // Not authoritative: the transaction may already be in a validated
          // ledger. Keep polling; never infer expiry from a failed lookup.
          unresolvedExpiry = `LastLedgerSequence ${lastLedgerSequence} passed (validated ledger ${validatedSeq}) but the final tx lookup was not authoritative (${final.reason})`;
        }
      }
    }
  }

  return {
    txHash,
    result: unresolvedExpiry
      ? `pending: ${unresolvedExpiry}; not declared expired, do not resend until tx_hash is confirmed absent`
      : `pending: submitted (${engineResult}) but not yet validated after ${Math.round((maxAttempts * intervalMs) / 1000)}s`,
    status: "pending",
    lastLedgerSequence,
    lastValidatedLedger,
  };
}

type FinalLookup =
  | { kind: "validated"; txResult: any }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

/**
 * The decisive lookup once the validated ledger has passed LastLedgerSequence.
 *
 * Only an authoritative not-found counts as `absent`: rippled's `tx` returns
 * error `txnNotFound`, and for a request bounded by `min_ledger`/`max_ledger`
 * it adds `searched_all: true` only when the server holds every ledger in the
 * range (false means it is missing some and cannot rule the transaction out).
 * Transport failures, HTTP errors, unparseable bodies, any other RPC error,
 * an incomplete search, an unbounded search, or a found-but-unvalidated
 * transaction are all `unknown`.
 */
async function finalTxLookup(
  rpcUrl: string,
  txHash: string,
  minLedger: number | undefined,
  maxLedger: number
): Promise<FinalLookup> {
  const params: any = { transaction: txHash };
  if (minLedger != null) {
    params.min_ledger = minLedger;
    params.max_ledger = maxLedger;
  }
  let result: any;
  try {
    result = await rpcRequest(rpcUrl, "tx", params);
  } catch (err) {
    return { kind: "unknown", reason: `tx lookup failed: ${(err as Error)?.message ?? String(err)}` };
  }
  if (result?.validated === true) {
    return { kind: "validated", txResult: result };
  }
  if (result?.error === "txnNotFound") {
    if (minLedger == null) {
      return { kind: "unknown", reason: "txnNotFound without a ledger range (submission ledger unknown)" };
    }
    if (result.searched_all === true) {
      return { kind: "absent" };
    }
    return { kind: "unknown", reason: `txnNotFound but searched_all=${String(result.searched_all)} for ledgers ${minLedger}-${maxLedger}` };
  }
  if (result?.error) {
    return { kind: "unknown", reason: `tx lookup error: ${result.error}` };
  }
  return { kind: "unknown", reason: "transaction found but not validated" };
}

/**
 * Apply common autofill fields to a transaction: Sequence, Fee,
 * LastLedgerSequence (with 120-ledger buffer), and NetworkID for sidechains.
 */
function applyAutofill(txJson: any, ledger: LedgerInfo): any {
  txJson.Fee = ledger.feeDrops;
  txJson.Sequence = ledger.sequence;
  txJson.LastLedgerSequence = ledger.validatedSeq + 120;

  // PFTL is a sidechain and requires NetworkID in transactions
  if (ledger.networkId != null && ledger.networkId > 1024) {
    txJson.NetworkID = ledger.networkId;
  }

  return txJson;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prepare a Payment transaction with an optional memo (pointer or envelope).
 * Supports both PFT drop amounts (string) and issued currency amounts (object).
 * Returns the autofilled, unsigned transaction JSON.
 *
 * Uses HTTP JSON-RPC (no WebSocket dependency).
 */
export async function preparePayment(
  config: Config,
  wallet: Wallet,
  destination: string,
  amount: PftlAmount,
  memo?: {
    memoTypeHex: string;
    memoFormatHex: string;
    memoDataHex: string;
  }
): Promise<PreparedTransaction> {
  const ledger = await fetchLedgerInfo(config.pftlRpcUrl, wallet.address);

  const payment: any = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: destination,
    Amount: amount || "1",
  };

  if (memo) {
    payment.Memos = [
      {
        Memo: {
          MemoType: memo.memoTypeHex,
          MemoFormat: memo.memoFormatHex,
          MemoData: memo.memoDataHex,
        },
      },
    ];
  }

  applyAutofill(payment, ledger);

  return {
    txJson: payment,
    fee: payment.Fee || "12",
  };
}

/**
 * Sign and submit a prepared transaction.
 * Uses HTTP JSON-RPC with polling (no WebSocket dependency).
 */
export async function signAndSubmit(
  config: Config,
  wallet: Wallet,
  txJson: any
): Promise<SubmissionOutcome> {
  const signed = wallet.sign(txJson);
  return submitAndPoll(
    config.pftlRpcUrl,
    signed.tx_blob,
    signed.hash,
    typeof txJson.LastLedgerSequence === "number" ? txJson.LastLedgerSequence : undefined
  );
}

/**
 * Publish the bot's X25519 encryption public key as the MessageKey on the PFTL ledger.
 * Uses HTTP JSON-RPC (no WebSocket dependency).
 */
export async function publishMessageKey(
  config: Config,
  wallet: Wallet,
  messageKeyHex: string
): Promise<SubmissionOutcome> {
  const ledger = await fetchLedgerInfo(config.pftlRpcUrl, wallet.address);

  const txJson: any = {
    TransactionType: "AccountSet",
    Account: wallet.address,
    MessageKey: messageKeyHex,
  };

  applyAutofill(txJson, ledger);

  const signed = wallet.sign(txJson);
  return submitAndPoll(
    config.pftlRpcUrl,
    signed.tx_blob,
    signed.hash,
    txJson.LastLedgerSequence
  );
}

/**
 * Create a Wallet from a seed string.
 * Handles both hex seeds (starting with 's') and mnemonic phrases.
 */
export function walletFromSeed(seed: string): Wallet {
  // If it looks like a mnemonic (contains spaces), use fromMnemonic
  if (seed.includes(" ")) {
    return Wallet.fromMnemonic(seed);
  }
  // Otherwise treat as a secret/seed
  return Wallet.fromSeed(seed);
}
