import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";
import {
  pftlAssetSchema,
  buildXrplAsset,
  AMM_WITHDRAW_FLAGS,
  type PftlAsset,
} from "../dex/constants.js";

export const dexAmmWithdrawSchema = z.object({
  asset1: pftlAssetSchema.describe(
    'First asset in the AMM pool. Use "PFT" for the native asset or {currency, issuer} for issued tokens.'
  ),
  asset2: pftlAssetSchema.describe(
    "Second asset in the AMM pool."
  ),
  lp_token_amount: z
    .string()
    .describe(
      "Amount of LP tokens to redeem. Use dex_get_balances to find your LP balance and dex_get_amm_info for the LP token currency and issuer."
    ),
  lp_token_currency: z
    .string()
    .describe("LP token currency code (40-char hex). From dex_get_amm_info.lp_token.currency."),
  lp_token_issuer: z
    .string()
    .describe("LP token issuer address (AMM pool account). From dex_get_amm_info.lp_token.issuer."),
});

export type DexAmmWithdrawParams = z.infer<typeof dexAmmWithdrawSchema>;

/**
 * Withdraw liquidity from a PFTL AMM pool by redeeming LP tokens.
 *
 * Performs a proportional two-asset withdrawal: you receive both assets
 * in proportion to the pool's current reserves.
 *
 * Use dex_get_amm_info to retrieve the LP token currency and issuer,
 * and dex_get_balances to find your current LP token balance.
 */
export async function executeDexAmmWithdraw(
  config: Config,
  keypair: BotKeypair,
  params: DexAmmWithdrawParams
): Promise<string> {
  const asset1 = params.asset1 as PftlAsset;
  const asset2 = params.asset2 as PftlAsset;

  const txJson: any = {
    TransactionType: "AMMWithdraw",
    Account:         keypair.address,
    Asset:           buildXrplAsset(asset1),
    Asset2:          buildXrplAsset(asset2),
    LPTokenIn: {
      currency: params.lp_token_currency,
      issuer:   params.lp_token_issuer,
      value:    params.lp_token_amount,
    },
    Flags: AMM_WITHDRAW_FLAGS.LPTokenWithdraw,
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:            result.txHash,
      result:             result.result,
      asset1:             params.asset1,
      asset2:             params.asset2,
      lp_tokens_redeemed: params.lp_token_amount,
      withdraw_type:      "LPToken (proportional)",
    },
    null,
    2
  );
}
