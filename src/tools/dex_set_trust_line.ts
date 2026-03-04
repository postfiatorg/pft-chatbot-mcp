import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";

export const dexSetTrustLineSchema = z.object({
  currency: z
    .string()
    .describe("Currency code of the token to trust (3-character or 40-character hex)."),
  issuer: z
    .string()
    .describe("Issuer r-address for this token."),
  limit: z
    .string()
    .default("1000000000")
    .describe(
      "Maximum amount of this token the bot is willing to hold. Default 1,000,000,000."
    ),
});

export type DexSetTrustLineParams = z.infer<typeof dexSetTrustLineSchema>;

/**
 * Establish or update a trust line for any issued token on the PFTL chain.
 * This is required before the bot can receive or hold an issued token.
 * Safe to call again — re-running with the same args simply updates the limit.
 */
export async function executeDexSetTrustLine(
  config: Config,
  keypair: BotKeypair,
  params: DexSetTrustLineParams
): Promise<string> {
  const txJson: any = {
    TransactionType: "TrustSet",
    Account:         keypair.address,
    LimitAmount: {
      currency: params.currency,
      issuer:   params.issuer,
      value:    params.limit,
    },
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:     result.txHash,
      result:      result.result,
      currency:    params.currency,
      issuer:      params.issuer,
      trust_limit: params.limit,
    },
    null,
    2
  );
}
