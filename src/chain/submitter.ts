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
 * Call a JSON-RPC method on the PFTL HTTP endpoint.
 */
async function rpcCall(rpcUrl: string, method: string, params: any = {}): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  if (!resp.ok) {
    throw new Error(`RPC ${method} HTTP ${resp.status}: ${resp.statusText}`);
  }
  const json = (await resp.json()) as any;
  if (json.result?.error) {
    throw new Error(`RPC ${method}: ${json.result.error_message || json.result.error}`);
  }
  return json.result;
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
 * Submit a signed transaction blob and poll until validated.
 */
async function submitAndPoll(
  rpcUrl: string,
  signedTxBlob: string,
  txHash: string
): Promise<{ txHash: string; result: string }> {
  const submitResult = await rpcCall(rpcUrl, "submit", {
    tx_blob: signedTxBlob,
  });

  const engineResult = submitResult.engine_result;
  if (engineResult !== "tesSUCCESS" && engineResult !== "terQUEUED") {
    return { txHash, result: engineResult || "unknown" };
  }

  // Poll for validation
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const txResult = await rpcCall(rpcUrl, "tx", { transaction: txHash });
      if (txResult.validated) {
        const meta = txResult.meta || {};
        return {
          txHash,
          result: meta.TransactionResult || engineResult || "tesSUCCESS",
        };
      }
    } catch {
      // tx not found yet, keep polling
    }
  }

  return {
    txHash,
    result: `submitted (${engineResult}) but not yet validated after ${maxAttempts * 2}s`,
  };
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
): Promise<{ txHash: string; result: string }> {
  const signed = wallet.sign(txJson);
  return submitAndPoll(config.pftlRpcUrl, signed.tx_blob, signed.hash);
}

/**
 * Publish the bot's X25519 encryption public key as the MessageKey on the PFTL ledger.
 * Uses HTTP JSON-RPC (no WebSocket dependency).
 */
export async function publishMessageKey(
  config: Config,
  wallet: Wallet,
  messageKeyHex: string
): Promise<{ txHash: string; result: string }> {
  const ledger = await fetchLedgerInfo(config.pftlRpcUrl, wallet.address);

  const txJson: any = {
    TransactionType: "AccountSet",
    Account: wallet.address,
    MessageKey: messageKeyHex,
  };

  applyAutofill(txJson, ledger);

  const signed = wallet.sign(txJson);
  return submitAndPoll(config.pftlRpcUrl, signed.tx_blob, signed.hash);
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
