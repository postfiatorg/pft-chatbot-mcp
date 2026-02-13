import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { getAccountInfo, getAccountLines } from "../chain/scanner.js";

export const checkBalanceSchema = z.object({});

export type CheckBalanceParams = z.infer<typeof checkBalanceSchema>;

/**
 * Check the bot's wallet balance (native PFT and trust line balances).
 */
export async function executeCheckBalance(
  config: Config,
  keypair: BotKeypair
): Promise<string> {
  const [accountInfo, trustLines] = await Promise.all([
    getAccountInfo(config.pftlRpcUrl, keypair.address),
    getAccountLines(config.pftlRpcUrl, keypair.address),
  ]);

  const balanceDrops = accountInfo.balance;
  const balancePft = (parseInt(balanceDrops, 10) / 1_000_000).toFixed(6);

  const lines = trustLines.map((tl) => ({
    currency: tl.currency,
    issuer: tl.issuer,
    balance: tl.balance,
    limit: tl.limit,
  }));

  return JSON.stringify(
    {
      wallet_address: keypair.address,
      native_balance: {
        pft: balancePft,
        drops: balanceDrops,
      },
      trust_lines: lines,
    },
    null,
    2
  );
}
