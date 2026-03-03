import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import {
  pftlAssetSchema,
  buildXrplAsset,
  dropsToPft,
  type PftlAsset,
} from "../dex/constants.js";

export const dexGetAmmInfoSchema = z.object({
  asset1: pftlAssetSchema.describe(
    'First asset in the AMM pool. Use "PFT" for the native asset or {currency, issuer} for issued tokens.'
  ),
  asset2: pftlAssetSchema.describe(
    "Second asset in the AMM pool. Must differ from asset1."
  ),
});

export type DexGetAmmInfoParams = z.infer<typeof dexGetAmmInfoSchema>;

/**
 * Get live AMM pool info for any asset pair on the PFTL chain.
 * Returns reserves, spot price, LP token supply, and trading fee.
 */
export async function executeDexGetAmmInfo(
  config: Config,
  _keypair: BotKeypair,
  params: DexGetAmmInfoParams
): Promise<string> {
  const xrplAsset1 = buildXrplAsset(params.asset1 as PftlAsset);
  const xrplAsset2 = buildXrplAsset(params.asset2 as PftlAsset);

  let resp: any;
  try {
    resp = await rpcCall(config.pftlRpcUrl, "amm_info", {
      asset:        xrplAsset1,
      asset2:       xrplAsset2,
      ledger_index: "validated",
    });
  } catch (err: any) {
    // actNotFound means no AMM pool exists for this pair — not a fatal error
    if (err.message?.includes("actNotFound") || err.message?.includes("Account not found")) {
      return JSON.stringify(
        { error: "No AMM pool found for this asset pair on the PFTL ledger." },
        null,
        2
      );
    }
    throw err;
  }

  const amm = resp.amm;
  if (!amm) {
    return JSON.stringify(
      { error: "No AMM pool found for this asset pair." },
      null,
      2
    );
  }

  // Normalise reserves — either side may be native (drops) or issued (object)
  const reserve1 =
    typeof amm.amount === "string"
      ? { currency: "PFT", amount: dropsToPft(amm.amount), drops: amm.amount }
      : { currency: amm.amount.currency, issuer: amm.amount.issuer, amount: amm.amount.value };

  const reserve2 =
    typeof amm.amount2 === "string"
      ? { currency: "PFT", amount: dropsToPft(amm.amount2), drops: amm.amount2 }
      : { currency: amm.amount2.currency, issuer: amm.amount2.issuer, amount: amm.amount2.value };

  // Spot price: reserve2 per reserve1 unit (both as floats)
  const r1 = parseFloat(reserve1.amount);
  const r2 = parseFloat(reserve2.amount);
  const spotPrice = r1 > 0 && r2 > 0 ? (r2 / r1).toFixed(8) : null;

  return JSON.stringify(
    {
      account:      amm.account,
      asset1:       params.asset1,
      asset2:       params.asset2,
      reserve1,
      reserve2,
      lp_token: {
        currency: amm.lp_token?.currency,
        issuer:   amm.lp_token?.issuer,
        supply:   amm.lp_token?.value,
      },
      trading_fee:            amm.trading_fee,
      spot_price_asset2_per_asset1: spotPrice,
      vote_slots:             amm.vote_slots?.length ?? 0,
    },
    null,
    2
  );
}
