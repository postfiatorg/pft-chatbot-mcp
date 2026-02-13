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
  // Validate that at least one amount is provided
  if (!params.amount_pft && !params.amount_drops) {
    throw new Error("Either amount_pft or amount_drops must be provided.");
  }

  // Determine PFT amount in drops
  let amountDrops: string;
  if (params.amount_pft) {
    const pftValue = parseFloat(params.amount_pft);
    if (isNaN(pftValue) || pftValue <= 0) {
      throw new Error(
        `Invalid amount_pft: "${params.amount_pft}". Must be a positive number.`
      );
    }
    amountDrops = Math.round(pftValue * 1_000_000).toString();
  } else {
    const dropsValue = parseInt(params.amount_drops!, 10);
    if (isNaN(dropsValue) || dropsValue <= 0) {
      throw new Error(
        `Invalid amount_drops: "${params.amount_drops}". Must be a positive integer.`
      );
    }
    amountDrops = dropsValue.toString();
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

  const pftSent = (parseInt(amountDrops, 10) / 1_000_000).toFixed(6);

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
