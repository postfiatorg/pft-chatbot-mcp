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
