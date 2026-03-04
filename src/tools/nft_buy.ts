import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";

export const nftBuySchema = z.object({
  offer_id: z
    .string()
    .describe(
      "The nft_offer_index (offer ID) of the sell offer to accept. Obtain via nft_get_offers or nft_get_listings."
    ),
});

export type NftBuyParams = z.infer<typeof nftBuySchema>;

/**
 * Accept an existing NFT sell offer — i.e., buy the NFT.
 *
 * Workflow:
 *   1. Call nft_get_listings or nft_get_offers to find the offer_id.
 *   2. Call this tool with that offer_id.
 *   3. The PFT is deducted from the bot's wallet and the NFT is transferred.
 *
 * The bot must have sufficient PFT to cover the listing price.
 */
export async function executeNftBuy(
  config: Config,
  keypair: BotKeypair,
  params: NftBuyParams
): Promise<string> {
  const txJson: any = {
    TransactionType:   "NFTokenAcceptOffer",
    Account:           keypair.address,
    NFTokenSellOffer:  params.offer_id,
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:  result.txHash,
      result:   result.result,
      offer_id: params.offer_id,
      note:
        result.result === "tesSUCCESS"
          ? "NFT purchased. Use nft_get_owned to verify ownership."
          : "Transaction submitted but check result for errors.",
    },
    null,
    2
  );
}
