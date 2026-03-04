import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import { dropsToPft } from "../dex/constants.js";

export const nftGetOffersSchema = z.object({
  nft_id: z
    .string()
    .describe("NFTokenID (64-character hex) to look up sell offers for."),
});

export type NftGetOffersParams = z.infer<typeof nftGetOffersSchema>;

function formatOffer(offer: any) {
  const amountDrops =
    typeof offer.amount === "string" ? offer.amount : null;
  return {
    offer_id:       offer.nft_offer_index,
    owner:          offer.owner,
    destination:    offer.destination ?? null,
    amount_drops:   amountDrops,
    amount_pft:     amountDrops ? dropsToPft(amountDrops) : null,
    expiration:     offer.expiration ?? null,
    flags:          offer.flags,
  };
}

/**
 * Get active sell offers for a specific NFT on the marketplace.
 * Returns the offer_id needed to accept an offer via nft_buy.
 */
export async function executeNftGetOffers(
  config: Config,
  _keypair: BotKeypair,
  params: NftGetOffersParams
): Promise<string> {
  let sellOffers: any[] = [];
  let error: string | null = null;

  try {
    const resp = await rpcCall(config.pftlRpcUrl, "nft_sell_offers", {
      nft_id: params.nft_id,
    });
    sellOffers = resp.offers ?? [];
  } catch (err: any) {
    // "objectNotFound" is normal for NFTs with no sell offers
    if (err.message?.includes("objectNotFound") || err.message?.includes("not found")) {
      sellOffers = [];
    } else {
      error = err.message;
    }
  }

  if (error) {
    return JSON.stringify({ nft_id: params.nft_id, error }, null, 2);
  }

  return JSON.stringify(
    {
      nft_id:     params.nft_id,
      sell_offers: sellOffers.map(formatOffer),
      count:       sellOffers.length,
    },
    null,
    2
  );
}
