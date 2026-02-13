import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { getAccountInfo, getAccountLines } from "../chain/scanner.js";

export const getWalletInfoSchema = z.object({});

export type GetWalletInfoParams = z.infer<typeof getWalletInfoSchema>;

/**
 * Return the bot's wallet address, public key, encryption key, and trust line status.
 * Useful for onboarding flows and debugging connectivity issues.
 */
export async function executeGetWalletInfo(
  config: Config,
  keypair: BotKeypair
): Promise<string> {
  const [accountInfo, trustLines] = await Promise.all([
    getAccountInfo(config.pftlRpcUrl, keypair.address),
    getAccountLines(config.pftlRpcUrl, keypair.address),
  ]);

  const balanceDrops = accountInfo.balance;
  const balancePft = (parseInt(balanceDrops, 10) / 1_000_000).toFixed(6);

  // Determine PFT trust line status
  const pftTrustLine = trustLines.find(
    (tl) => tl.currency === "PFT" || tl.currency === "504654000000000000000000000000000000000000"
  );

  const trustLineStatus = pftTrustLine
    ? {
        active: true,
        currency: pftTrustLine.currency,
        issuer: pftTrustLine.issuer,
        balance: pftTrustLine.balance,
        limit: pftTrustLine.limit,
      }
    : { active: false };

  return JSON.stringify(
    {
      wallet_address: keypair.address,
      public_signing_key: keypair.wallet.publicKey,
      x25519_encryption_key: Buffer.from(keypair.x25519PublicKey).toString(
        "hex"
      ),
      native_balance: {
        pft: balancePft,
        drops: balanceDrops,
      },
      pft_trust_line: trustLineStatus,
      all_trust_lines: trustLines.map((tl) => ({
        currency: tl.currency,
        issuer: tl.issuer,
        balance: tl.balance,
        limit: tl.limit,
      })),
      chain_rpc: config.pftlRpcUrl,
      keystone_grpc: config.keystoneGrpcUrl,
    },
    null,
    2
  );
}
