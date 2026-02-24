import sodium from "./sodium.js";
import { createHash } from "node:crypto";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export interface EncryptedBlob {
  version: number;
  enc: string;
  nonce: string;
  ciphertext: string;
  content_hash: string;
  recipients: Array<{
    recipient_id: string;
    ephemeral_pubkey: string;
    wrap_nonce: string;
    encrypted_file_key: string;
  }>;
}

/**
 * Shared core: encrypt raw bytes for multiple recipients.
 */
async function encryptForRecipients(
  contentBytes: Uint8Array,
  recipientPublicKeys: Uint8Array[]
): Promise<EncryptedBlob> {
  await sodium.ready;

  const fileKey = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
  );
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    contentBytes,
    null,
    null,
    nonce,
    fileKey
  );

  const contentHash = createHash("sha256").update(contentBytes).digest("hex");

  const recipients: EncryptedBlob["recipients"] = [];
  for (const recipientPubkey of recipientPublicKeys) {
    const ephemeral = sodium.crypto_box_keypair();
    const wrapNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const encryptedFileKey = sodium.crypto_box_easy(
      fileKey,
      wrapNonce,
      recipientPubkey,
      ephemeral.privateKey
    );
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

/**
 * Encrypt a UTF-8 plaintext string for multiple recipients using
 * XChaCha20-Poly1305 with per-recipient X25519 key wrapping.
 */
export async function encryptPayloadForRecipients(
  plaintext: string,
  recipientPublicKeys: Uint8Array[]
): Promise<EncryptedBlob> {
  const textBytes = Buffer.from(plaintext, "utf8");
  return encryptForRecipients(textBytes, recipientPublicKeys);
}

/**
 * Encrypt raw binary content (e.g. file attachment) for multiple recipients.
 * Same scheme as encryptPayloadForRecipients but operates on a Buffer.
 */
export async function encryptBinaryForRecipients(
  content: Buffer,
  recipientPublicKeys: Uint8Array[]
): Promise<EncryptedBlob> {
  return encryptForRecipients(new Uint8Array(content), recipientPublicKeys);
}
