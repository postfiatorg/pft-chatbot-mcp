# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-02-24

### Changed

- **`delete_bot` No Longer Requires Parameters**: The tool now derives the agent ID from the bot's own wallet address. The deprecated `agent_id` parameter has been removed.
- **Attachment `filename` and `size_bytes` Now Required**: `send_message` attachment objects require `filename` and `size_bytes` fields (previously optional) to prevent metadata spoofing and ensure proper FE display.
- **`content_type` Description Clarified**: The `send_message` `content_type` parameter description now clarifies it describes the message body format (e.g. `"text"`, `"text/markdown"`), not attachment MIME types.

## [0.4.0] - 2025-02-24

### Added

- **Agent Liveness Ping**: Background heartbeat pings to the Keystone agent registry every 15 minutes (configurable via `PING_INTERVAL_MS`, set 0 to disable). Agents that don't ping within 20 minutes are hidden from search results.
- **Encrypted Attachments**: New `encrypt_for` parameter on `upload_content` encrypts attachment content using `ENC_X25519_XCHACHA20P1305` for a specified recipient before uploading to IPFS. The `get_attachment` tool auto-detects and decrypts encrypted attachments on fetch.
- **Attachment Metadata**: `send_message` attachments now support `size_bytes` and `encrypted` fields, aligning with the pftasks FE `AttachmentRenderer` expectations.
- **New MCP Tool: `ping`**: Manual liveness heartbeat for debugging connectivity.
- **New MCP Tool: `get_attachment`**: Fetch attachments from IPFS by CID with automatic encrypted blob detection and decryption.
- **Search Liveness Fields**: `search_bots` now returns `is_active` and `last_ping_at` per bot, with an `include_inactive` filter parameter.
- **Test Suite**: Added `vitest` with 42 tests across 7 test files covering crypto round-trips, content hash integrity, key derivation, pointer encoding, liveness interval logic, and tool schema validation.
- **Upload Size Guard**: Client-side 10 MB limit on `upload_content` matching the Keystone IPFS gateway cap.
- **FE Integration Guide**: New `docs/FE_ENCRYPTED_ATTACHMENTS.md` for the pftasks frontend team to implement encrypted attachment download and decryption.
- **Graceful Shutdown**: `SIGINT`/`SIGTERM` handlers that stop the ping interval and close gRPC connections.

### Changed

- **Crypto Refactor**: `encrypt.ts` and `decrypt.ts` now share internal core functions (`encryptForRecipients`, `unwrapAndDecrypt`) eliminating code duplication.
- **`resolveRecipientKey` Extracted**: Moved from `send_message.ts` to shared `src/crypto/resolve_key.ts` with 32-byte key length validation.
- **Ping Uses `setTimeout` Chain**: Prevents concurrent ping requests under degraded network conditions (instead of `setInterval`).
- **Content Hash Verification**: Decryption now verifies `content_hash` from the encrypted blob against the decrypted content as a defense-in-depth integrity check.
- **`isEncryptedBlob` Type Predicate**: Returns `obj is EncryptedBlob` for proper TypeScript type narrowing.
- **`search_bots` Output**: `wallet_address` field now populated from `agent_id` (was previously always empty).

### Fixed

- **`get_attachment` Error Masking**: Decryption errors now propagate correctly instead of silently falling back to returning encrypted bytes.
- **`get_attachment` JSON Re-serialization**: Non-encrypted JSON files are returned as original raw bytes instead of being re-serialized (which changed formatting and size).
- **`PING_INTERVAL_MS` Validation**: Invalid values (NaN, negative) now log a warning and fall back to the default instead of silently disabling pings.
- **Ping Start Order**: Background pings now start after MCP transport connection (not before).

## [0.3.0] - 2025-01-28

### Added

- Bot customization fields: `icon_emoji`, `icon_color_hex`, `min_cost_first_message_drops`
- Command registry: bots can declare supported commands with descriptions and costs
- `send_pft` tool for lightweight PFT transfers without messages
- `check_balance` tool for wallet balance inspection
- `get_wallet_info` tool for onboarding and debugging
- Messaging key auto-publish on `register_bot`
- Wallet setup documentation (`docs/WALLET_SETUP.md`)

### Changed

- Updated gRPC protos to match Keystone server v0.2 field layout
- RPC endpoint switched to HTTP (from WebSocket) for reliability

### Fixed

- Proto casing compatibility with server
- Scan message proto field alignment
- Messaging key format (ED-prefix handling)

## [0.2.0] - 2025-01-15

### Added

- Initial Keystone gRPC integration (content storage, envelope storage, agent registry)
- 10 MCP tools: `create_wallet`, `scan_messages`, `get_message`, `send_message`, `register_bot`, `search_bots`, `get_bot`, `delete_bot`, `upload_content`, `get_thread`
- End-to-end encrypted messaging using `ENC_X25519_XCHACHA20P1305`
- IPFS content upload and multi-gateway fetch with fallback
- `pf.ptr.v4` pointer memo encoding for on-chain message references
- Auto-provisioned Keystone API keys on first `register_bot` call
- Setup mode (works without `BOT_SEED` for wallet creation)
- Hello World bot tutorial (`docs/HELLO_WORLD_BOT.md`)

## [0.1.0] - 2025-01-10

### Added

- Initial project scaffold
- Wallet creation tool
- NPM package setup (`@postfiatorg/pft-chatbot-mcp`)
