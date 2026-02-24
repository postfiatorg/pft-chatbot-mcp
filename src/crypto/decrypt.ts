import sodium from "./sodium.js";
import { createHash } from "node:crypto";
import type { EncryptedBlob } from "./encrypt.js";

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64"));
}

/**
 * Shared core: unwrap per-recipient key shard and AEAD-decrypt ciphertext.
 * Returns raw decrypted bytes. Verifies content_hash if present.
 */
async function unwrapAndDecrypt(
  blob: any,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;

  if (!blob || !blob.recipients || !blob.ciphertext || !blob.nonce) {
    throw new Error("Invalid encrypted payload: missing required fields");
  }

  const ourId = createHash("sha256").update(publicKey).digest("hex");
  const shard = blob.recipients.find(
    (r: any) => r.recipient_id === ourId
  );

  if (!shard) {
    throw new Error(
      "No recipient shard found for this key. " +
        "The content was not encrypted for this bot."
    );
  }

  const encryptedFileKey = fromBase64(shard.encrypted_file_key);
  const wrapNonce = fromBase64(shard.wrap_nonce);
  const ephemeralPubkey = fromBase64(shard.ephemeral_pubkey);

  const fileKey = sodium.crypto_box_open_easy(
    encryptedFileKey,
    wrapNonce,
    ephemeralPubkey,
    privateKey
  );

  const nonce = fromBase64(blob.nonce);
  const ciphertext = fromBase64(blob.ciphertext);

  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    fileKey
  );

  // Defense-in-depth: verify content_hash if present
  if (blob.content_hash && typeof blob.content_hash === "string") {
    const actual = createHash("sha256").update(plaintextBytes).digest("hex");
    if (actual !== blob.content_hash) {
      throw new Error(
        `Content hash mismatch: expected ${blob.content_hash}, got ${actual}. ` +
          "The decrypted content does not match the original."
      );
    }
  }

  return plaintextBytes;
}

/**
 * Decrypt an encrypted payload blob using the bot's X25519 keypair.
 * Returns the decrypted plaintext as a UTF-8 string.
 */
export async function decryptPayload(
  blob: any,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<string> {
  const bytes = await unwrapAndDecrypt(blob, privateKey, publicKey);
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Decrypt an encrypted payload blob and return raw bytes (for binary content
 * like file attachments). Same flow as decryptPayload but skips UTF-8 conversion.
 */
export async function decryptBinaryPayload(
  blob: any,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<Buffer> {
  const bytes = await unwrapAndDecrypt(blob, privateKey, publicKey);
  return Buffer.from(bytes);
}

/**
 * Type guard: returns true if the given object looks like an encrypted blob
 * produced by encryptPayloadForRecipients / encryptBinaryForRecipients.
 */
export function isEncryptedBlob(obj: unknown): obj is EncryptedBlob {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o.version === 1 &&
    o.enc === "ENC_X25519_XCHACHA20P1305" &&
    typeof o.ciphertext === "string" &&
    typeof o.nonce === "string" &&
    Array.isArray(o.recipients)
  );
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
