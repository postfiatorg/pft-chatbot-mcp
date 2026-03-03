import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import { formatXrplAmount } from "../dex/constants.js";

export const dexGetOpenOrdersSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("PFTL wallet address to query. Defaults to the bot's own wallet."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(400)
    .default(200)
    .describe("Maximum number of open orders to return (1–400)."),
});

export type DexGetOpenOrdersParams = z.infer<typeof dexGetOpenOrdersSchema>;

// account_offers returns lowercase/abbreviated field names (seq, taker_pays, taker_gets, flags)
// unlike book_offers which uses PascalCase ledger-object names.
function formatOffer(offer: any) {
  return {
    sequence:   offer.seq,
    taker_pays: formatXrplAmount(offer.taker_pays),
    taker_gets: formatXrplAmount(offer.taker_gets),
    quality:    offer.quality,
    flags:      offer.flags,
  };
}

/**
 * Get all currently open limit orders for the bot's wallet or any PFTL address.
 * Returns every open order across all trading pairs — no pair filter applied.
 * Use the Sequence number with dex_cancel_order to cancel a specific order.
 */
export async function executeDexGetOpenOrders(
  config: Config,
  keypair: BotKeypair,
  params: DexGetOpenOrdersParams
): Promise<string> {
  const address = params.address ?? keypair.address;

  const resp = await rpcCall(config.pftlRpcUrl, "account_offers", {
    account:      address,
    limit:        params.limit,
    ledger_index: "validated",
  });

  const offers: any[] = resp.offers ?? [];

  return JSON.stringify(
    {
      address,
      open_orders: offers.map(formatOffer),
      count:       offers.length,
    },
    null,
    2
  );
}
