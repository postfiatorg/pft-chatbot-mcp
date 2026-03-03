import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import { dropsToPft } from "../dex/constants.js";

export const dexGetBalancesSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("PFTL wallet address to query. Defaults to the bot's own wallet."),
});

export type DexGetBalancesParams = z.infer<typeof dexGetBalancesSchema>;

/**
 * Return the native PFT balance and all issued token trust-line balances
 * for the bot's wallet or any PFTL address.
 */
export async function executeDexGetBalances(
  config: Config,
  keypair: BotKeypair,
  params: DexGetBalancesParams
): Promise<string> {
  const address = params.address ?? keypair.address;

  const [accountInfo, trustLines] = await Promise.all([
    rpcCall(config.pftlRpcUrl, "account_info", {
      account:      address,
      ledger_index: "validated",
    }),
    rpcCall(config.pftlRpcUrl, "account_lines", {
      account:      address,
      ledger_index: "validated",
    }),
  ]);

  const balanceDrops: string = accountInfo.account_data?.Balance ?? "0";

  const lines: any[] = trustLines.lines ?? [];

  return JSON.stringify(
    {
      address,
      native: {
        currency:       "PFT",
        balance:        dropsToPft(balanceDrops),
        balance_drops:  balanceDrops,
      },
      trust_lines: lines.map((l: any) => ({
        currency: l.currency,
        issuer:   l.account,
        balance:  l.balance,
        limit:    l.limit,
      })),
    },
    null,
    2
  );
}
