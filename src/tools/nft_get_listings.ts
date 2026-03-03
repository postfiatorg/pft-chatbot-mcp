import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import { dropsToPft, resolveIpfsUri } from "../dex/constants.js";

export const nftGetListingsSchema = z.object({
  issuer: z
    .string()
    .describe(
      "PFTL address of the NFT issuer whose collection to scan for active sell offers."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      "Number of NFTs to scan per call (1–100). Each scan checks sell offers for each NFT."
    ),
  marker: z
    .string()
    .optional()
    .describe("Pagination marker from a previous nft_get_listings response."),
});

export type NftGetListingsParams = z.infer<typeof nftGetListingsSchema>;

const CONCURRENT_OFFER_FETCHES = 10;

async function getSellOffersForNft(rpcUrl: string, nftId: string): Promise<any[]> {
  try {
    const resp = await rpcCall(rpcUrl, "nft_sell_offers", { nft_id: nftId });
    return resp.offers ?? [];
  } catch {
    return [];
  }
}

/**
 * Scan a PFTL NFT issuer's collection for NFTs that have active sell offers.
 *
 * Fetches a page of the issuer's NFTs then batch-checks each one for sell offers.
 * Use `marker` to paginate through large collections.
 * Use nft_get_offers to get full offer details for a specific NFT.
 * Use nft_buy with the offer_id to purchase.
 */
export async function executeNftGetListings(
  config: Config,
  _keypair: BotKeypair,
  params: NftGetListingsParams
): Promise<string> {
  const reqParams: any = {
    account:      params.issuer,
    ledger_index: "validated",
    limit:        params.limit,
  };
  if (params.marker) reqParams.marker = params.marker;

  const resp = await rpcCall(config.pftlRpcUrl, "account_nfts", reqParams);
  const nfts: any[] = resp.account_nfts ?? [];

  const listings: any[] = [];

  for (let i = 0; i < nfts.length; i += CONCURRENT_OFFER_FETCHES) {
    const batch = nfts.slice(i, i + CONCURRENT_OFFER_FETCHES);
    const results = await Promise.all(
      batch.map(async (nft: any) => {
        const offers = await getSellOffersForNft(config.pftlRpcUrl, nft.NFTokenID);
        if (offers.length === 0) return null;

        const uri = nft.URI
          ? Buffer.from(nft.URI, "hex").toString("utf8")
          : null;

        const bestOffer = offers.reduce((best: any, o: any) => {
          if (!best) return o;
          const bestAmt = typeof best.amount === "string" ? parseInt(best.amount, 10) : Infinity;
          const thisAmt = typeof o.amount    === "string" ? parseInt(o.amount,    10) : Infinity;
          return thisAmt < bestAmt ? o : best;
        }, null);

        const bestAmountDrops =
          bestOffer && typeof bestOffer.amount === "string" ? bestOffer.amount : null;

        return {
          nft_id:           nft.NFTokenID,
          issuer:           nft.Issuer,
          uri,
          metadata_url:     uri ? resolveIpfsUri(uri) : null,
          offer_count:      offers.length,
          best_offer_id:    bestOffer?.nft_offer_index ?? null,
          best_price_drops: bestAmountDrops,
          best_price_pft:   bestAmountDrops ? dropsToPft(bestAmountDrops) : null,
          best_offer_owner: bestOffer?.owner ?? null,
        };
      })
    );
    listings.push(...results.filter(Boolean));
  }

  return JSON.stringify(
    {
      issuer:   params.issuer,
      listings,
      count:    listings.length,
      scanned:  nfts.length,
      marker:   resp.marker ?? null,
    },
    null,
    2
  );
}
