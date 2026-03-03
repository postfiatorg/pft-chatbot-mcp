import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";

export const nftCancelOfferSchema = z.object({
  offer_ids: z
    .array(z.string())
    .min(1)
    .max(500)
    .describe(
      "Array of nft_offer_index values to cancel. The bot must be the owner of each offer. Obtain IDs via nft_get_offers."
    ),
});

export type NftCancelOfferParams = z.infer<typeof nftCancelOfferSchema>;

/**
 * Cancel one or more of the bot's NFT sell offers.
 *
 * Use nft_get_offers to find the offer_id(s) for listings you want to remove,
 * then pass them here. XRPL allows up to 500 offer cancellations in one tx.
 */
export async function executeNftCancelOffer(
  config: Config,
  keypair: BotKeypair,
  params: NftCancelOfferParams
): Promise<string> {
  const txJson: any = {
    TransactionType:  "NFTokenCancelOffer",
    Account:          keypair.address,
    NFTokenOffers:    params.offer_ids,
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:          result.txHash,
      result:           result.result,
      offers_cancelled: params.offer_ids,
      count:            params.offer_ids.length,
    },
    null,
    2
  );
}
