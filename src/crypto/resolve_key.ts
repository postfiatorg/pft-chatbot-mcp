import sodium from "./sodium.js";
import { getAccountInfo } from "../chain/scanner.js";

const X25519_KEY_LENGTH = 32;

function stripEdPrefix(hex: string): string {
  if (hex.length === 66 && hex.toUpperCase().startsWith("ED")) {
    return hex.slice(2);
  }
  return hex;
}

function assertKeyLength(key: Uint8Array, source: string, address: string): void {
  if (key.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `Invalid ${source} for ${address}: expected ${X25519_KEY_LENGTH} bytes, got ${key.length}. ` +
        "The on-chain key may be malformed."
    );
  }
}

/**
 * Resolve the recipient's X25519 public key for encryption.
 * Tries: 1) MessageKey from chain, 2) derive from SigningPubKey.
 * Validates that the resulting key is exactly 32 bytes.
 */
export async function resolveRecipientKey(
  rpcUrl: string,
  recipientAddress: string
): Promise<Uint8Array> {
  await sodium.ready;

  const info = await getAccountInfo(rpcUrl, recipientAddress);

  if (info.messageKey) {
    const keyHex = stripEdPrefix(info.messageKey);
    const key = Buffer.from(keyHex, "hex");
    assertKeyLength(key, "MessageKey", recipientAddress);
    return key;
  }

  if (info.publicKey && info.publicKey.length >= 64) {
    const pubkeyHex = stripEdPrefix(info.publicKey);
    const ed25519Pubkey = Buffer.from(pubkeyHex, "hex");
    if (ed25519Pubkey.length === 32) {
      const curve25519Key = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pubkey);
      assertKeyLength(curve25519Key, "derived X25519 key", recipientAddress);
      return curve25519Key;
    }
  }

  throw new Error(
    `Cannot resolve encryption key for ${recipientAddress}. ` +
      `The recipient has no MessageKey set and the SigningPubKey could not be converted.`
  );
}
