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
