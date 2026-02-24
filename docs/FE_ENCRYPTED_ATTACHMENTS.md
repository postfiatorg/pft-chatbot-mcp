# FE Integration: Encrypted Attachments

Reference for updating the frontends to support downloading and decrypting encrypted attachments sent by MCP bots (v0.4.0+).

## Attachment Metadata Format

After decrypting the message blob, each attachment in the `attachments` array has this shape:

```json
{
  "cid": "bafk...",
  "uri": "ipfs://bafk...",
  "content_type": "application/pdf",
  "filename": "report.pdf",
  "size_bytes": 12345,
  "encrypted": true
}
```

- When `encrypted` is absent or `false`: the CID points to plaintext content (current behavior -- direct gateway download link).
- When `encrypted` is `true`: the CID points to an encrypted blob that must be fetched and decrypted before serving to the user.

## Encrypted Blob Format

The content stored at the encrypted CID uses the same `ENC_X25519_XCHACHA20P1305` scheme as message encryption:

```json
{
  "version": 1,
  "enc": "ENC_X25519_XCHACHA20P1305",
  "nonce": "<base64>",
  "ciphertext": "<base64>",
  "content_hash": "<sha256 hex of original file bytes>",
  "recipients": [
    {
      "recipient_id": "<sha256 hex of X25519 pubkey>",
      "ephemeral_pubkey": "<base64>",
      "wrap_nonce": "<base64>",
      "encrypted_file_key": "<base64>"
    }
  ]
}
```

The `ciphertext`, when decrypted, yields the **raw file bytes** (not a JSON string).

## Detection

Check for encrypted blob format:

```javascript
function isEncryptedBlob(obj) {
  return obj && obj.version === 1 && obj.enc === 'ENC_X25519_XCHACHA20P1305';
}
```

## Decryption Helper

Add a `decryptBinaryPayload` function alongside the existing `decryptContextPayload` in `lib/context/crypto.js`. The logic is identical except it returns raw `Uint8Array` instead of calling `sodium.to_string()`:

```javascript
export const decryptBinaryPayload = async ({ blob, mnemonic }) => {
  if (!blob || !mnemonic) {
    throw new Error('Missing encrypted blob or mnemonic');
  }
  const libsodium = await getSodium();
  const keypair = await deriveX25519KeypairFromMnemonic(mnemonic);
  const recipientId = await deriveRecipientId(keypair.publicKey);
  const recipients = Array.isArray(blob.recipients) ? blob.recipients : [];
  const shard = recipients.find((entry) => entry.recipient_id === recipientId);
  if (!shard) {
    throw new Error('No matching key shard for this wallet');
  }

  const wrapNonce = fromBase64(shard.wrap_nonce);
  const encryptedFileKey = fromBase64(shard.encrypted_file_key);
  const ephemeralPubkey = fromBase64(shard.ephemeral_pubkey);
  const fileKey = libsodium.crypto_box_open_easy(
    encryptedFileKey, wrapNonce, ephemeralPubkey, keypair.privateKey
  );

  const nonce = fromBase64(blob.nonce);
  const ciphertext = fromBase64(blob.ciphertext);
  const plaintextBytes = libsodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, ciphertext, null, nonce, fileKey
  );

  // Return raw bytes (NOT to_string) for binary file content
  return plaintextBytes;
};
```

Also add a `decryptBinaryPayloadWithKeypair` variant for the fallback path.

## AttachmentRenderer Changes

In `app/src/components/chat/AttachmentRenderer.jsx`:

### 1. For non-encrypted attachments (no change needed)

Continue rendering a direct `<a href={url} download>` link as today.

### 2. For encrypted attachments

Replace the direct download with an async click handler:

```jsx
import { fetchIpfsJsonWithFallback } from '../../lib/ipfs';
import { decryptBinaryPayload } from '../../lib/context/crypto';

// Inside AttachmentRenderer:
const handleEncryptedDownload = async (e) => {
  e.preventDefault();
  setLoading(true);
  try {
    const cidStr = (uri || cid).replace('ipfs://', '');
    const blob = await fetchIpfsJsonWithFallback(cidStr);
    const decryptedBytes = await decryptBinaryPayload({ blob, mnemonic: wallet.mnemonic });
    const fileBlob = new Blob([decryptedBytes], { type: ct });
    const blobUrl = URL.createObjectURL(fileBlob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'attachment';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    setError('Failed to decrypt attachment');
    console.error('Attachment decrypt error:', err);
  } finally {
    setLoading(false);
  }
};
```

### 3. Conditional rendering

```jsx
if (attachment.encrypted) {
  return (
    <div onClick={handleEncryptedDownload} style={{ cursor: 'pointer' }}>
      {/* Same card layout as non-encrypted, but with lock icon and click handler */}
      <LockIcon /> {/* or faLock from FontAwesome */}
      {displayName}
      {sizeLabel}
      {loading ? <Spinner /> : <DownloadIcon />}
    </div>
  );
}
// ... existing direct download <a> for non-encrypted
```

## UX Recommendations

- Show a lock icon on encrypted attachment cards to distinguish them visually
- Show a loading spinner during fetch + decrypt (can take a few seconds for large files)
- Show an error state if decryption fails (wrong key, corrupted blob)
- `size_bytes` in metadata is the **original** file size (pre-encryption) -- display it as-is
- Consider caching decrypted blobs in memory (same LRU pattern as `cidBlobCache` in `ipfs.js`)

## Backward Compatibility

- Attachments without the `encrypted` field are treated as non-encrypted (current behavior, no changes needed)
- The `size_bytes` field was already expected by `AttachmentRenderer` but was missing from bot-sent messages pre-v0.4.0. Now it's always populated.
- The wallet mnemonic is needed for decryption, which is already available in the inbox context via `wallet.mnemonic`
