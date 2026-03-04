import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";
import { pftToDrops, dropsToPft, NFT_OFFER_FLAGS } from "../dex/constants.js";

export const nftListForSaleSchema = z.object({
  nft_id: z
    .string()
    .describe(
      "NFTokenID (64-character hex) of the NFT to list. The bot must own this NFT."
    ),
  price_pft: z
    .string()
    .describe('Listing price in PFT (e.g. "10" for 10 PFT).'),
  destination: z
    .string()
    .optional()
    .describe(
      "Optional: restrict the sale to a specific buyer address. Omit to allow any buyer."
    ),
  expiration: z
    .number()
    .int()
    .optional()
    .describe(
      "Optional: offer expiration as a Ripple epoch timestamp (seconds since Jan 1 2000). Omit for no expiration."
    ),
});

export type NftListForSaleParams = z.infer<typeof nftListForSaleSchema>;

/**
 * Create an on-chain sell offer for an NFT owned by the bot.
 *
 * The bot must own the NFT being listed. The offer is recorded on-chain
 * and will appear in nft_get_listings / nft_get_offers.
 *
 * Use nft_cancel_offer to remove the listing, or nft_get_owned to verify ownership first.
 */
export async function executeNftListForSale(
  config: Config,
  keypair: BotKeypair,
  params: NftListForSaleParams
): Promise<string> {
  const priceDrops = pftToDrops(params.price_pft);

  const txJson: any = {
    TransactionType: "NFTokenCreateOffer",
    Account:         keypair.address,
    NFTokenID:       params.nft_id,
    Amount:          priceDrops,
    Flags:           NFT_OFFER_FLAGS.SellOffer,
  };

  if (params.destination) txJson.Destination = params.destination;
  if (params.expiration  != null) txJson.Expiration = params.expiration;

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:      result.txHash,
      result:       result.result,
      nft_id:       params.nft_id,
      price_pft:    dropsToPft(priceDrops),
      price_drops:  priceDrops,
      destination:  params.destination ?? "any buyer",
      expiration:   params.expiration  ?? "none",
      note:         "Use nft_get_offers to retrieve the offer_id for this listing.",
    },
    null,
    2
  );
}
