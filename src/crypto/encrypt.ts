import sodium from "./sodium.js";
import { createHash } from "node:crypto";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Encrypt a payload for multiple recipients using XChaCha20-Poly1305
 * with per-recipient X25519 key wrapping.
 *
 * This matches the encryption scheme in pftasks/api/src/lib/encryption_utils.js:
 * 1. Generate a random file key (symmetric)
 * 2. Encrypt plaintext with XChaCha20-Poly1305 using the file key
 * 3. For each recipient, wrap the file key with X25519 DH (crypto_box_easy)
 */
export async function encryptPayloadForRecipients(
  plaintext: string,
  recipientPublicKeys: Uint8Array[]
): Promise<any> {
  await sodium.ready;

  const textBytes = Buffer.from(plaintext, "utf8");

  // Generate random file key
  const fileKey = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
  );

  // Encrypt the plaintext
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    textBytes,
    null,
    null,
    nonce,
    fileKey
  );

  // Compute content hash
  const contentHash = createHash("sha256").update(textBytes).digest("hex");

  // Wrap file key for each recipient
  const recipients: any[] = [];
  for (const recipientPubkey of recipientPublicKeys) {
    // Generate ephemeral X25519 keypair for this recipient
    const ephemeral = sodium.crypto_box_keypair();
    const wrapNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);

    // Wrap the file key
    const encryptedFileKey = sodium.crypto_box_easy(
      fileKey,
      wrapNonce,
      recipientPubkey,
      ephemeral.privateKey
    );

    // Compute recipient_id as SHA-256 of their public key
    const recipientIdHash = createHash("sha256")
      .update(recipientPubkey)
      .digest("hex");

    recipients.push({
      recipient_id: recipientIdHash,
      ephemeral_pubkey: toBase64(ephemeral.publicKey),
      wrap_nonce: toBase64(wrapNonce),
      encrypted_file_key: toBase64(encryptedFileKey),
    });
  }

  return {
    version: 1,
    enc: "ENC_X25519_XCHACHA20P1305",
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
    content_hash: contentHash,
    recipients,
  };
}
