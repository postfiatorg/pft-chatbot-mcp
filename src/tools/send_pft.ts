import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { preparePayment, signAndSubmit } from "../chain/submitter.js";

export const sendPftSchema = z.object({
  recipient: z
    .string()
    .describe("Destination PFTL wallet address (r-address)"),
  amount_pft: z
    .string()
    .optional()
    .describe('PFT amount to send (e.g. "10"). Mutually exclusive with amount_drops.'),
  amount_drops: z
    .string()
    .optional()
    .describe("PFT amount in drops (1 PFT = 1,000,000 drops). Mutually exclusive with amount_pft."),
});

export type SendPftParams = z.infer<typeof sendPftSchema>;

/**
 * Send PFT to an address without attaching a message.
 * Lightweight transfer for payments, tipping, and funding other wallets.
 */
export async function executeSendPft(
  config: Config,
  keypair: BotKeypair,
  params: SendPftParams
): Promise<string> {
  // Distinguish supplied fields from truthy strings: even an empty selector
  // must not silently override or bypass the mutually exclusive contract.
  const hasPft = params.amount_pft !== undefined;
  const hasDrops = params.amount_drops !== undefined;
  if (!hasPft && !hasDrops) {
    throw new Error("Either amount_pft or amount_drops must be provided.");
  }
  if (hasPft && hasDrops) {
    throw new Error("amount_pft and amount_drops are mutually exclusive.");
  }

  // Determine PFT amount in drops
  let amountDrops: string;
  if (hasPft) {
    const value = params.amount_pft!;
    if (!/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value)) {
      throw new Error(
        `Invalid amount_pft: "${value}". Must be a positive decimal with at most six fractional digits.`
      );
    }
    const [whole, fraction = ""] = value.split(".");
    amountDrops = (BigInt(whole || "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
  } else {
    const value = params.amount_drops!;
    if (!/^\d+$/.test(value)) {
      throw new Error(
        `Invalid amount_drops: "${value}". Must be a positive integer.`
      );
    }
    amountDrops = BigInt(value).toString();
  }
  if (BigInt(amountDrops) <= 0n) {
    throw new Error("Amount must be at least one drop.");
  }

  // Prepare payment (no memo)
  const prepared = await preparePayment(
    config,
    keypair.wallet,
    params.recipient,
    amountDrops
  );

  // Sign and submit
  const submitResult = await signAndSubmit(
    config,
    keypair.wallet,
    prepared.txJson
  );

  const exactDrops = BigInt(amountDrops);
  const pftSent = `${exactDrops / 1_000_000n}.${(exactDrops % 1_000_000n).toString().padStart(6, "0")}`;

  return JSON.stringify(
    {
      tx_hash: submitResult.txHash,
      result: submitResult.result,
      recipient: params.recipient,
      amount_pft: pftSent,
      amount_drops: amountDrops,
      fee_drops: prepared.fee,
    },
    null,
    2
  );
}
