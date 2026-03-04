import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import {
  pftlAssetSchema,
  buildXrplAsset,
  formatXrplAmount,
  type PftlAsset,
} from "../dex/constants.js";

export const dexGetOrderBookSchema = z.object({
  asset1: pftlAssetSchema.describe(
    'First asset in the pair (the "base"). Use "PFT" for the native asset or {currency, issuer} for any issued token.'
  ),
  asset2: pftlAssetSchema.describe(
    'Second asset in the pair (the "quote"). Use "PFT" for the native asset or {currency, issuer} for any issued token.'
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of offers to return per side (1–100)."),
});

export type DexGetOrderBookParams = z.infer<typeof dexGetOrderBookSchema>;

function formatOffer(offer: any) {
  return {
    account:    offer.Account,
    sequence:   offer.Sequence,
    taker_pays: formatXrplAmount(offer.TakerPays),
    taker_gets: formatXrplAmount(offer.TakerGets),
    quality:    offer.quality,
  };
}

/**
 * Fetch both sides of the PFTL DEX order book for any asset pair.
 *
 * XRPL semantics:
 *   side_a: taker_pays=asset1, taker_gets=asset2
 *           (orders from people who want asset1 and are offering asset2)
 *   side_b: taker_pays=asset2, taker_gets=asset1
 *           (orders from people who want asset2 and are offering asset1)
 */
export async function executeDexGetOrderBook(
  config: Config,
  _keypair: BotKeypair,
  params: DexGetOrderBookParams
): Promise<string> {
  const xrplAsset1 = buildXrplAsset(params.asset1 as PftlAsset);
  const xrplAsset2 = buildXrplAsset(params.asset2 as PftlAsset);

  const [sideAResp, sideBResp] = await Promise.all([
    rpcCall(config.pftlRpcUrl, "book_offers", {
      taker_pays:   xrplAsset1,
      taker_gets:   xrplAsset2,
      limit:        params.limit,
      ledger_index: "validated",
    }),
    rpcCall(config.pftlRpcUrl, "book_offers", {
      taker_pays:   xrplAsset2,
      taker_gets:   xrplAsset1,
      limit:        params.limit,
      ledger_index: "validated",
    }),
  ]);

  const sideA = (sideAResp.offers ?? []).map(formatOffer);
  const sideB = (sideBResp.offers ?? []).map(formatOffer);

  return JSON.stringify(
    {
      asset1:        params.asset1,
      asset2:        params.asset2,
      side_a:        sideA,   // want asset1, offering asset2
      side_b:        sideB,   // want asset2, offering asset1
      side_a_count:  sideA.length,
      side_b_count:  sideB.length,
      best_side_a:   sideA[0] ?? null,
      best_side_b:   sideB[0] ?? null,
    },
    null,
    2
  );
}
