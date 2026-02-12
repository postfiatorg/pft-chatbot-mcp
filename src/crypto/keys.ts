import sodium from "./sodium.js";
import { createHash } from "node:crypto";
import { walletFromSeed } from "../chain/submitter.js";
import type { Wallet } from "xrpl";

export interface BotKeypair {
  /** PFTL wallet (for signing transactions) */
  wallet: Wallet;
  /** X25519 public key (32 bytes, for encryption) */
  x25519PublicKey: Uint8Array;
  /** X25519 private key (32 bytes, for decryption) */
  x25519PrivateKey: Uint8Array;
  /** The bot's PFTL r-address */
  address: string;
}

/**
 * Derive the bot's keypairs from BOT_SEED.
 *
 * - PFTL wallet: derived via xrpl.Wallet.fromSeed/fromMnemonic (PFTL uses the same wallet format)
 * - X25519 keypair: SHA-256(seed) -> crypto_box_seed_keypair()
 *   This matches the tasknode pattern in pftasks/api/src/services/message_service.js
 */
export async function deriveBotKeypair(botSeed: string): Promise<BotKeypair> {
  await sodium.ready;

  // Derive PFTL wallet
  const wallet = walletFromSeed(botSeed);

  // Derive X25519 keypair for encryption (same pattern as tasknode)
  const seedBytes = createHash("sha256").update(botSeed).digest();
  const keypair = sodium.crypto_box_seed_keypair(seedBytes);

  return {
    wallet,
    x25519PublicKey: keypair.publicKey,
    x25519PrivateKey: keypair.privateKey,
    address: wallet.address,
  };
}

/**
 * Compute the recipient_id (SHA-256 hash of the public key, hex-encoded).
 * This is used to find the matching recipient shard in an encrypted blob.
 */
export function recipientId(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}
