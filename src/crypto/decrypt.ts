import sodium from "./sodium.js";
import { createHash } from "node:crypto";

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64"));
}

/**
 * Decrypt an encrypted payload blob using the bot's X25519 keypair.
 *
 * This matches the decryption logic in pftasks/api/src/services/message_service.js
 * (decryptPayloadForTasknode) and the frontend (decryptContextPayload).
 *
 * @param blob - The encrypted payload JSON from IPFS
 * @param privateKey - The bot's X25519 private key (32 bytes)
 * @param publicKey - The bot's X25519 public key (32 bytes)
 * @returns The decrypted plaintext string
 */
export async function decryptPayload(
  blob: any,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<string> {
  await sodium.ready;

  if (!blob || !blob.recipients || !blob.ciphertext || !blob.nonce) {
    throw new Error("Invalid encrypted payload: missing required fields");
  }

  // Find our recipient shard by matching recipient_id
  const ourId = createHash("sha256").update(publicKey).digest("hex");
  const shard = blob.recipients.find(
    (r: any) => r.recipient_id === ourId
  );

  if (!shard) {
    throw new Error(
      "No recipient shard found for this key. " +
        "The message was not encrypted for this bot."
    );
  }

  // Unwrap the file key
  const encryptedFileKey = fromBase64(shard.encrypted_file_key);
  const wrapNonce = fromBase64(shard.wrap_nonce);
  const ephemeralPubkey = fromBase64(shard.ephemeral_pubkey);

  const fileKey = sodium.crypto_box_open_easy(
    encryptedFileKey,
    wrapNonce,
    ephemeralPubkey,
    privateKey
  );

  // Decrypt the ciphertext
  const nonce = fromBase64(blob.nonce);
  const ciphertext = fromBase64(blob.ciphertext);

  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    fileKey
  );

  return Buffer.from(plaintextBytes).toString("utf8");
}

/**
 * Check if an encrypted blob has a recipient shard for the given public key.
 */
export function hasRecipientShard(
  blob: any,
  publicKey: Uint8Array
): boolean {
  if (!blob?.recipients) return false;
  const ourId = createHash("sha256").update(publicKey).digest("hex");
  return blob.recipients.some((r: any) => r.recipient_id === ourId);
}
