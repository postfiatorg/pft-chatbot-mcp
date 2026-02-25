# CLAUDE.md

Project-level context for AI assistants working on this codebase.

## Keystone Protocol Reference

The Keystone server codebase (and its canonical `.proto` definitions) is typically
checked out one directory above this repo:

```
../keystone-protocol/
├── keystone/v1/registry/registry.proto   # Agent registry service (StoreAgentCard, etc.)
├── keystone/v1/core/                     # Envelope, content, validation protos
├── keystone/v1/auth/                     # Auth service proto
├── keystone/v1/storage/                  # Content & envelope storage protos
└── third_party/a2a/specification/grpc/a2a.proto  # Google A2A protocol (AgentCard, AgentProvider)
```

When making changes to the local proto subset in `src/grpc/protos/`, always cross-reference
the server protos at `../keystone-protocol/` to verify field numbers and message shapes
match what the server actually expects on the wire.

## IPFS Upload Limit

The Keystone IPFS gateway enforces a **10 MB per-file limit**. This applies to both
plaintext and encrypted uploads via `upload_content`. Encrypted blobs are slightly
larger than the original content (AEAD overhead + base64 + JSON wrapper), so the
raw content is validated against this limit before encryption. The `MAX_UPLOAD_BYTES`
constant in `src/tools/upload_content.ts` enforces this client-side.

## Agent Liveness (v0.4.0+)

The registry proto includes `PingAgent` (empty request, returns `google.protobuf.Timestamp last_ping_at`).
The server hides agents whose `last_ping_at` is older than 20 minutes from `SearchAgents` results
unless the caller sets `include_inactive = true`. `StoreAgentCard` also updates `last_ping_at`.

The MCP server sends automatic pings every 15 minutes (configurable via `PING_INTERVAL_MS`).

## Encrypted Attachments (v0.4.0+)

Attachments can be encrypted using the same `ENC_X25519_XCHACHA20P1305` scheme as messages.
The `upload_content` tool accepts an `encrypt_for` parameter (recipient wallet address) that
encrypts the file content for that recipient + the bot before uploading to IPFS.

The encrypted blob at the CID has the same JSON structure as encrypted messages
(`version`, `enc`, `nonce`, `ciphertext`, `content_hash`, `recipients[]`), but the
decrypted ciphertext yields raw file bytes rather than a UTF-8 JSON string.

Attachment metadata in the message payload includes `size_bytes` (original size)
and `encrypted: true` when applicable, matching the pftasks FE `AttachmentRenderer` expectations.

## Keystone Envelope Format (v0.5.0+)

As of v0.5.0, `send_message` emits `keystone v1` envelope memos instead of `pf.ptr v4` pointers.
The envelope structure is a protobuf-encoded `KeystoneEnvelope` containing:

- `version: 1`
- `message_type: 1` (MESSAGE_TYPE_CORE) — **must be numeric**, not string
- `encryption: 3` (ENCRYPTION_MODE_PUBLIC_KEY) — **must be numeric**, not string
- `content_hash`: SHA-256 of the encrypted blob (bytes)
- `message`: serialized `KeystoneCoreMessage` containing a `KeystoneContentDescriptor`
  with `uri: "ipfs://<cid>"`, `content_type`, `content_length`, `content_hash`
- `metadata: { cid: "<bare CID>" }`

The memo fields are: `MemoType = "keystone"` (hex), `MemoFormat = "v1"` (hex),
`MemoData = <protobuf bytes>` (hex).

The scanner reads both `pf.ptr v4` and `keystone v1` formats. When a keystone
envelope's `metadata.cid` is missing, the scanner falls back to extracting the
CID from the embedded `KeystoneCoreMessage.content_descriptor.uri`.

## TaskNode Sharing (v0.5.0+)

By default, `send_message` encrypts the message blob for 3 recipients: the bot,
the recipient, and the TaskNode. This allows the TaskNode to decrypt messages for
server-side previews and task processing.

Controlled by:
- `TASKNODE_ENCRYPTION_PUBKEY` env var: base64-encoded X25519 public key (defaults
  to the testnet TaskNode key). Set to `"none"` or `""` to disable.
- `share_with_tasknode` parameter on `send_message` (default `true`): per-message control.

When `share_with_tasknode` is false, the plaintext payload's `content_type` is forced to
`"encrypted"` to signal the TaskNode should not attempt decryption (matching pftasks
frontend behavior).

Privacy tiers when combining `share_with_tasknode` with `encrypt_for` on attachments:
- **Fully shared** (`share_with_tasknode: true`, no `encrypt_for`): TaskNode reads message + file bytes
- **Message shared, files private** (`share_with_tasknode: true`, `encrypt_for` set): TaskNode
  reads message text and file metadata but cannot decrypt the attachment content at the CID
  (encrypted only for bot + recipient, not the TaskNode)
- **Fully private** (`share_with_tasknode: false`): TaskNode cannot decrypt anything
