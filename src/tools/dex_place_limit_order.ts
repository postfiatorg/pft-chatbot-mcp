import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";
import {
  pftlAssetSchema,
  buildXrplAmount,
  formatXrplAmount,
  type PftlAsset,
} from "../dex/constants.js";

export const dexPlaceLimitOrderSchema = z.object({
  sell: pftlAssetSchema.describe(
    'Asset to sell. "PFT" for the native asset, or {currency, issuer} for any issued token.'
  ),
  sell_amount: z
    .string()
    .describe(
      'Amount to sell. For PFT: whole units ("100") or drops suffix. For issued: decimal string.'
    ),
  buy: pftlAssetSchema.describe(
    "Asset to receive."
  ),
  buy_amount: z
    .string()
    .describe(
      'Amount to receive. The ratio sell_amount / buy_amount defines your limit price.'
    ),
});

export type DexPlaceLimitOrderParams = z.infer<typeof dexPlaceLimitOrderSchema>;

/**
 * Place a resting limit order on the PFTL DEX order book.
 *
 * Unlike dex_swap (ImmediateOrCancel), this order persists in the order book
 * until it is fully matched, cancelled with dex_cancel_order, or the account
 * is closed. Partially filled orders remain until the remainder is matched.
 *
 * XRPL semantics:
 *   TakerPays = what creator wants to receive  (buy_amount)
 *   TakerGets = what creator is putting up      (sell_amount)
 *
 * Use dex_get_open_orders to retrieve the Sequence number and
 * dex_cancel_order to remove the order.
 */
export async function executeDexPlaceLimitOrder(
  config: Config,
  keypair: BotKeypair,
  params: DexPlaceLimitOrderParams
): Promise<string> {
  const sellAsset = params.sell as PftlAsset;
  const buyAsset  = params.buy  as PftlAsset;

  const takerGets = buildXrplAmount(sellAsset, params.sell_amount);
  const takerPays = buildXrplAmount(buyAsset,  params.buy_amount);

  const txJson: any = {
    TransactionType: "OfferCreate",
    Account:         keypair.address,
    TakerPays:       takerPays,
    TakerGets:       takerGets,
    // No flags — resting order
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:    result.txHash,
      result:     result.result,
      sell:       { asset: params.sell, ...formatXrplAmount(takerGets) },
      buy:        { asset: params.buy,  ...formatXrplAmount(takerPays) },
      sequence:   prepared.txJson.Sequence,
      order_type: "LimitOrder",
    },
    null,
    2
  );
}
