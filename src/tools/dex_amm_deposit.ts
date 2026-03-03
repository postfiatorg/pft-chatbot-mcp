import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";
import {
  pftlAssetSchema,
  buildXrplAmount,
  buildXrplAsset,
  AMM_DEPOSIT_FLAGS,
  type PftlAsset,
} from "../dex/constants.js";

export const dexAmmDepositSchema = z.object({
  asset1: pftlAssetSchema.describe(
    'First asset in the AMM pool. Use "PFT" for the native asset or {currency, issuer} for issued tokens.'
  ),
  asset1_amount: z
    .string()
    .optional()
    .describe(
      "Amount of asset1 to deposit. Omit for a single-asset deposit of asset2 only."
    ),
  asset2: pftlAssetSchema.describe(
    "Second asset in the AMM pool."
  ),
  asset2_amount: z
    .string()
    .optional()
    .describe(
      "Amount of asset2 to deposit. Omit for a single-asset deposit of asset1 only."
    ),
});

export type DexAmmDepositParams = z.infer<typeof dexAmmDepositSchema>;

/**
 * Deposit liquidity into a PFTL AMM pool and receive LP tokens.
 *
 * Two-asset deposit: provide both asset1_amount and asset2_amount.
 *   Deposits proportionally to the current pool ratio and mints LP tokens.
 *
 * Single-asset deposit: provide only asset1_amount or only asset2_amount.
 *   Deposits one asset; the AMM rebalances internally (incurs a fee).
 *
 * Check dex_get_balances afterward for your updated LP token balance.
 */
export async function executeDexAmmDeposit(
  config: Config,
  keypair: BotKeypair,
  params: DexAmmDepositParams
): Promise<string> {
  const asset1 = params.asset1 as PftlAsset;
  const asset2 = params.asset2 as PftlAsset;

  const has1 = !!params.asset1_amount;
  const has2 = !!params.asset2_amount;

  if (!has1 && !has2) {
    throw new Error("At least one of asset1_amount or asset2_amount must be provided.");
  }

  const txJson: any = {
    TransactionType: "AMMDeposit",
    Account:         keypair.address,
    Asset:           buildXrplAsset(asset1),
    Asset2:          buildXrplAsset(asset2),
  };

  if (has1 && has2) {
    txJson.Amount  = buildXrplAmount(asset1, params.asset1_amount!);
    txJson.Amount2 = buildXrplAmount(asset2, params.asset2_amount!);
    txJson.Flags   = AMM_DEPOSIT_FLAGS.TwoAssetDeposit;
  } else if (has1) {
    txJson.Amount  = buildXrplAmount(asset1, params.asset1_amount!);
    txJson.Flags   = AMM_DEPOSIT_FLAGS.SingleAssetDeposit;
  } else {
    txJson.Amount  = buildXrplAmount(asset2, params.asset2_amount!);
    txJson.Flags   = AMM_DEPOSIT_FLAGS.SingleAssetDeposit;
  }

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:       result.txHash,
      result:        result.result,
      asset1:        params.asset1,
      asset1_amount: params.asset1_amount ?? null,
      asset2:        params.asset2,
      asset2_amount: params.asset2_amount ?? null,
      deposit_type:  has1 && has2 ? "TwoAsset" : "SingleAsset",
    },
    null,
    2
  );
}
