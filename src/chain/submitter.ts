import { Client, Wallet } from "xrpl";
import type { Config } from "../config.js";

export interface PreparedTransaction {
  txJson: any;
  fee: string;
}

/**
 * Connect to the PFTL WebSocket endpoint, perform an operation, then disconnect.
 */
async function withClient<T>(
  wssUrl: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(wssUrl);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

/** PFTL Amount: either PFT drops (string) or issued currency (object) */
export type PftlAmount =
  | string
  | { currency: string; issuer: string; value: string };

/**
 * Prepare a Payment transaction with an optional memo (pointer or envelope).
 * Supports both PFT drop amounts (string) and issued currency amounts (object).
 * Returns the autofilled, unsigned transaction JSON.
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
  return withClient(config.pftlWssUrl, async (client) => {
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

    const prepared = await client.autofill(payment);

    // Apply LastLedgerSequence buffer (at least 120 ledgers)
    const serverInfo = await client.request({ command: "server_info" });
    const validatedSeq =
      serverInfo.result?.info?.validated_ledger?.seq;
    if (validatedSeq && prepared.LastLedgerSequence) {
      const minLls = validatedSeq + 120;
      if (prepared.LastLedgerSequence < minLls) {
        prepared.LastLedgerSequence = minLls;
      }
    }

    return {
      txJson: prepared,
      fee: prepared.Fee || "12",
    };
  });
}

/**
 * Sign and submit a prepared transaction.
 * Returns the transaction hash.
 */
export async function signAndSubmit(
  config: Config,
  wallet: Wallet,
  txJson: any
): Promise<{ txHash: string; result: string }> {
  return withClient(config.pftlWssUrl, async (client) => {
    const signed = wallet.sign(txJson);

    const submitResult = await client.submitAndWait(signed.tx_blob, {
      failHard: true,
    });

    const meta = submitResult.result?.meta as any;
    const result = meta?.TransactionResult || "unknown";

    return {
      txHash: signed.hash,
      result,
    };
  });
}

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

/**
 * Publish the bot's X25519 encryption public key as the MessageKey on the PFTL ledger.
 * Uses HTTP JSON-RPC (no WebSocket dependency) for autofill, sign, submit, and poll.
 */
export async function publishMessageKey(
  config: Config,
  wallet: Wallet,
  messageKeyHex: string
): Promise<{ txHash: string; result: string }> {
  const rpcUrl = config.pftlRpcUrl;

  // 1. Fetch account sequence
  const accountInfo = await rpcCall(rpcUrl, "account_info", {
    account: wallet.address,
    ledger_index: "current",
  });
  const sequence = accountInfo.account_data?.Sequence;
  if (sequence == null) {
    throw new Error("Could not read account Sequence from account_info");
  }

  // 2. Fetch validated ledger + base fee + network ID from server_info
  const serverInfo = await rpcCall(rpcUrl, "server_info", {});
  const info = serverInfo.info;
  const validatedSeq = info?.validated_ledger?.seq;
  const baseFee = info?.validated_ledger?.base_fee_xrp;
  const networkId = info?.network_id;
  if (!validatedSeq) {
    throw new Error("Could not read validated_ledger from server_info");
  }

  // 3. Build the AccountSet transaction
  const feeDrops = baseFee
    ? Math.ceil(parseFloat(baseFee) * 1_000_000).toString()
    : "12";
  const lastLedgerSeq = validatedSeq + 120;

  const txJson: any = {
    TransactionType: "AccountSet",
    Account: wallet.address,
    MessageKey: messageKeyHex,
    Fee: feeDrops,
    Sequence: sequence,
    LastLedgerSequence: lastLedgerSeq,
  };

  // PFTL is a sidechain and requires NetworkID in transactions
  if (networkId != null && networkId > 1024) {
    txJson.NetworkID = networkId;
  }

  // 4. Sign locally
  const signed = wallet.sign(txJson);

  // 5. Submit via HTTP RPC
  const submitResult = await rpcCall(rpcUrl, "submit", {
    tx_blob: signed.tx_blob,
  });

  const engineResult = submitResult.engine_result;
  if (engineResult !== "tesSUCCESS" && engineResult !== "terQUEUED") {
    return {
      txHash: signed.hash,
      result: engineResult || "unknown",
    };
  }

  // 6. Poll for validation
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const txResult = await rpcCall(rpcUrl, "tx", {
        transaction: signed.hash,
      });
      if (txResult.validated) {
        const meta = txResult.meta || {};
        return {
          txHash: signed.hash,
          result: meta.TransactionResult || engineResult || "tesSUCCESS",
        };
      }
    } catch {
      // tx not found yet, keep polling
    }
  }

  return {
    txHash: signed.hash,
    result: `submitted (${engineResult}) but not yet validated after ${maxAttempts * 2}s`,
  };
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
