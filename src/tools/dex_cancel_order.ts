import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { prepareTx, signAndSubmit } from "../chain/submitter.js";

export const dexCancelOrderSchema = z.object({
  offer_sequence: z
    .number()
    .int()
    .positive()
    .describe(
      "Sequence number of the OfferCreate transaction that placed the order. Obtain via dex_get_open_orders."
    ),
});

export type DexCancelOrderParams = z.infer<typeof dexCancelOrderSchema>;

/**
 * Cancel an open limit order on the PFTL DEX.
 * Use dex_get_open_orders to find the Sequence number of the order to cancel.
 */
export async function executeDexCancelOrder(
  config: Config,
  keypair: BotKeypair,
  params: DexCancelOrderParams
): Promise<string> {
  const txJson: any = {
    TransactionType: "OfferCancel",
    Account:         keypair.address,
    OfferSequence:   params.offer_sequence,
  };

  const prepared = await prepareTx(config, keypair.wallet, txJson);
  const result   = await signAndSubmit(config, keypair.wallet, prepared.txJson);

  return JSON.stringify(
    {
      tx_hash:        result.txHash,
      result:         result.result,
      offer_sequence: params.offer_sequence,
    },
    null,
    2
  );
}
