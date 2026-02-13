import { z } from "zod";
import { Wallet } from "xrpl";

export const createWalletSchema = z.object({
  algorithm: z
    .enum(["ed25519", "secp256k1"])
    .optional()
    .describe(
      "Key algorithm to use. Default: ed25519 (recommended for PFTL)"
    ),
});

export type CreateWalletParams = z.infer<typeof createWalletSchema>;

/**
 * Map user-facing algorithm names to the string values that xrpl's
 * Wallet.generate() expects (matching the ECDSA enum at runtime).
 */
const ALGORITHM_MAP: Record<string, string> = {
  ed25519: "ed25519",
  secp256k1: "ecdsa-secp256k1",
};

/**
 * Generate a new PFTL wallet.
 *
 * This creates a fresh keypair locally -- no network call is needed.
 * The wallet is NOT active on-chain until it receives a deposit of at
 * least 10 PFT (the network reserve).
 */
export async function executeCreateWallet(
  params: CreateWalletParams
): Promise<string> {
  const algorithm = params.algorithm || "ed25519";
  // Cast needed: xrpl exports ECDSA as a CJS default which isn't
  // available as a named ESM import; the underlying values are plain strings.
  const wallet = Wallet.generate(ALGORITHM_MAP[algorithm] as any);

  return JSON.stringify(
    {
      address: wallet.address,
      seed: wallet.seed,
      public_key: wallet.publicKey,
      key_algorithm: algorithm,
      activation: {
        status: "NOT_ACTIVATED",
        minimum_deposit: "10 PFT",
        note: "This wallet will not exist on-chain until it receives a deposit of at least 10 PFT. You can send PFT from the pftasks UI (https://tasknode.postfiat.org) or from another PFTL wallet.",
      },
      warnings: [
        "SAVE YOUR SEED SECURELY. It is the only way to access this wallet. If lost, the wallet and all its funds are permanently unrecoverable.",
        "Never share your seed with anyone. Anyone with the seed has full control of the wallet.",
        "The seed is displayed here once. Copy it now and store it safely.",
      ],
      next_steps: [
        "1. Save the seed to a secure location (password manager, encrypted file, or hardware backup)",
        "2. Deposit at least 10 PFT to the address above to activate the wallet on-chain",
        "3. Set BOT_SEED to the seed value (or save it to a file and use BOT_SEED_FILE) in your MCP server configuration",
        "4. Restart the MCP server -- all bot tools will become available",
        "5. Call register_bot to register your bot in the public agent directory",
      ],
    },
    null,
    2
  );
}
