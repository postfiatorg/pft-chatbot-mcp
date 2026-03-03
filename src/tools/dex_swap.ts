import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";
import {
  pftlAssetSchema,
  buildXrplAmount,
  formatXrplAmount,
  OFFER_FLAGS,
  type PftlAsset,
} from "../dex/constants.js";

export const dexSwapSchema = z.object({
  sell: pftlAssetSchema.describe(
    'Asset to sell. "PFT" for the native asset, or {currency, issuer} for any issued token.'
  ),
  sell_amount: z
    .string()
    .describe(
      'Amount to sell. For PFT: whole units ("100") or drops ("100000000 drops"). For issued tokens: decimal string ("500.5").'
    ),
  buy: pftlAssetSchema.describe(
    'Asset to buy. "PFT" for the native asset, or {currency, issuer} for any issued token.'
  ),
  min_buy_amount: z
    .string()
    .describe(
      'Minimum amount to receive — acts as the slippage floor. The swap uses ImmediateOrCancel: any portion not filled at this price or better is discarded.'
    ),
});

export type DexSwapParams = z.infer<typeof dexSwapSchema>;

/**
 * Execute a market swap on the PFTL DEX.
 *
 * Uses OfferCreate with tfImmediateOrCancel: the order matches against existing
 * offers at the current market price; any unfilled portion is discarded (not
 * left as a resting order).
 *
 * XRPL semantics:
 *   TakerPays = what the creator wants to receive  (buy asset / min_buy_amount)
 *   TakerGets = what the creator is putting up      (sell asset / sell_amount)
 *
 * Prerequisites:
 *   - To receive an issued token the bot wallet must have a trust line for it
 *     (use dex_set_trust_line before the first swap into any issued token).
 */
export async function executeDexSwap(
  config: Config,
  keypair: BotKeypair,
  params: DexSwapParams
): Promise<string> {
  const sellAsset = params.sell as PftlAsset;
  const buyAsset  = params.buy  as PftlAsset;

  const takerGets = buildXrplAmount(sellAsset, params.sell_amount);
  const takerPays = buildXrplAmount(buyAsset,  params.min_buy_amount);

  const txJson: any = {
    TransactionType: "OfferCreate",
    Account:         keypair.address,
    TakerPays:       takerPays,
    TakerGets:       takerGets,
    Flags:           OFFER_FLAGS.ImmediateOrCancel,
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:    result.txHash,
      result:     result.result,
      sell:       { asset: params.sell, ...formatXrplAmount(takerGets) },
      min_buy:    { asset: params.buy,  ...formatXrplAmount(takerPays) },
      order_type: "ImmediateOrCancel",
    },
    null,
    2
  );
}
