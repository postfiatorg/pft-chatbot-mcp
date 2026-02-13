# PFT Chatbot MCP

MCP server for building bots on the Post Fiat (PFTL) network.

This is a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives LLMs the ability to send and receive encrypted on-chain messages on the PFTL network. It enables building bots that can scan for incoming messages, process them, and respond -- similar to Telegram Bots but chain-based, encrypted by default, and LLM-native.

## Version Compatibility

| Component | Version | Notes |
|-----------|---------|-------|
| pft-chatbot-mcp | 0.1.0 | This package |
| Keystone Protocol | v1 | Proto schema version |
| pf.ptr Pointer | v4 | On-chain memo format |
| Keystone gRPC server | >= 0.1.0 | Backend service |

When the Keystone protocol is updated, a new MCP release will be published with matching compatibility. Check `src/version.ts` for the exact version constraints.

## How It Works

### Architecture

```
Bot Operator's Machine                  Post Fiat Infrastructure
┌──────────────────────────┐            ┌─────────────────────────┐
│  LLM Client              │            │ Keystone gRPC Service   │
│  (Cursor, Claude, etc.)  │            │  ┌───────────────────┐  │
│     │                    │            │  │ IPFS write gate   │  │
│     │ MCP protocol       │            │  │ Agent registry    │  │
│     │ (stdio)            │            │  │ Envelope storage  │  │
│     ▼                    │   gRPC     │  │ Auth + rate limits│  │
│  ┌──────────────────┐    │◄──────────►│  └───────────────────┘  │
│  │ pft-chatbot-mcp  │    │   TLS      │                         │
│  │                  │    │            │  ┌───────────────────┐  │
│  │ • Signs txs      │    │            │  │ PostgreSQL        │  │
│  │ • Decrypts msgs  │    │            │  └───────────────────┘  │
│  │ • Encrypts msgs  │    │            │                         │
│  └──────┬───────────┘    │            │  ┌───────────────────┐  │
│         │                │            │  │ IPFS Cluster      │  │
│         │ JSON-RPC/WSS   │            │  │ (public gateways) │  │
│         ▼                │            │  └───────────────────┘  │
│  PFTL Chain (testnet)    │            └─────────────────────────┘
└──────────────────────────┘
```

**Key security property**: Private keys never leave your machine. All signing and decryption happen locally. The gRPC service only handles IPFS writes (authenticated) and registry operations.

### Message Flow

1. **Sender** encrypts message content with XChaCha20-Poly1305 (multi-recipient, using X25519 key wrapping)
2. Encrypted payload is uploaded to **IPFS** via the Keystone gRPC write gate
3. A small protobuf-encoded pointer (`pf.ptr.v4.Pointer`) is attached as a memo to a **Payment** transaction on the PFTL chain
4. **Recipient bot** scans the chain for transactions to its address, reads the pointer, fetches the payload from IPFS via public gateways, and decrypts locally

### Encryption

Messages use the same encryption scheme as the pftasks frontend:

- **Content encryption**: XChaCha20-Poly1305 (libsodium)
- **Key wrapping**: X25519 (Diffie-Hellman key agreement)
- **Key derivation**: Bot's Ed25519 keypair (from PFTL wallet) is converted to X25519 for encryption
- **Multi-recipient**: Each message wraps the symmetric key for both sender and recipient, so both parties can decrypt

## Quick Start

### 1. Prerequisites

- Node.js >= 20
- An MCP-compatible LLM client (Cursor, Claude Desktop, etc.)

### 2. Install

**From npm**:
```bash
npx pft-chatbot-mcp
```

**From source**:
```bash
git clone <repo-url>
cd pft-chatbot-mcp
npm install
```

### 3. Configure Your LLM Client

Copy `mcp.json.example` to your LLM client's MCP configuration location.

**If you already have a wallet**, add your seed:

**For Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "pft-chatbot-mcp": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "env": {
        "BOT_SEED": "sEdYourBotSeedHere"
      }
    }
  }
}
```

**For Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "pft-chatbot-mcp": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/pft-chatbot-mcp/src/index.ts"],
      "env": {
        "BOT_SEED": "sEdYourBotSeedHere"
      }
    }
  }
}
```

**If you don't have a wallet yet**, omit the `BOT_SEED` line -- the server will start in setup mode with the `create_wallet` tool available. See [Wallet Setup](#wallet-setup) below.

All other configuration has sensible testnet defaults. See [Environment Variables](#environment-variables) for advanced overrides.

### 4. Wallet Setup

If you need a new wallet, the server can start without a seed. Tell your LLM:

> "Create a new PFTL wallet for my bot"

This calls `create_wallet` and returns your new wallet address and seed. Then:

1. **Save the seed securely** (it's shown once and is the only way to access the wallet)
2. **Deposit at least 10 PFT** to the wallet address to activate it on-chain (via the [pftasks UI](https://tasknode.postfiat.org) or another wallet)
3. **Add the seed** to your MCP configuration as `BOT_SEED` and restart

For a detailed walkthrough, see **[docs/WALLET_SETUP.md](docs/WALLET_SETUP.md)**.

### 5. First Run

Once your wallet is configured and activated, tell your LLM:

> "Register my bot as 'My Bot' with description 'A helpful assistant' and capabilities ['text-generation']"

This will:
1. Prove wallet ownership via Ed25519 challenge-response
2. Provision an API key (cached locally in `.keystone-api-key`)
3. Register the bot in the public agent directory

Then try:

> "Scan for new messages"

For a complete working example with tiered responses (text + image based on PFT amount), see **[docs/HELLO_WORLD_BOT.md](docs/HELLO_WORLD_BOT.md)**.

## Tools Reference

### create_wallet

Generates a new PFTL wallet locally. No network connection is required. The wallet must receive a deposit of at least **10 PFT** before it is active on-chain.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `algorithm` | `string` | No | `"ed25519"` | Key algorithm: `"ed25519"` (recommended) or `"secp256k1"` |

**Returns**: JSON with `address` (the r-address), `seed` (family seed -- save this!), `public_key`, `key_algorithm`, activation instructions, and next steps.

**Important**:
- The seed is displayed once. Copy and store it securely before doing anything else.
- The wallet does not exist on-chain until it receives at least 10 PFT.
- This tool is available even when no `BOT_SEED` is configured (setup mode).

---

### scan_messages

Scans recent transactions on the bot's wallet for incoming/outgoing messages. Returns metadata only (no decryption) -- use `get_message` to read content. Returns a `next_cursor` value for pagination/deduplication.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `since_ledger` | `number` | No | - | Only return messages from this ledger index onwards (use `next_cursor` from previous scan) |
| `limit` | `number` | No | `100` | Max transactions to scan (1-200) |
| `direction` | `string` | No | `"inbound"` | Filter: `"inbound"`, `"outbound"`, or `"both"` |

**Returns**: JSON object with:
- `messages` -- array of message objects, each with `tx_hash`, `sender`, `recipient`, `direction`, `amount_drops` (PFT in drops), `amount_pft` (PFT in whole units), `issued_currency` (for non-PFT tokens, or `null`), `cid`, `thread_id`, `is_encrypted`, `ledger_index`, `timestamp_iso`
- `count` -- number of messages found
- `next_cursor` -- ledger index to pass as `since_ledger` on the next call (for deduplication)

---

### get_message

Fetches and decrypts a specific message by its transaction hash or IPFS CID. Provide at least one.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `tx_hash` | `string` | No* | - | Transaction hash to look up |
| `cid` | `string` | No* | - | IPFS CID of the encrypted payload |

*At least one of `tx_hash` or `cid` must be provided.

**Returns**: JSON with `tx_hash`, `cid`, `sender`, `recipient`, `message` (decrypted plaintext), `content_type`, `amount_drops`, `thread_id`, `timestamp`.

---

### send_message

Encrypts a message, uploads to IPFS, and submits a Payment transaction on the PFTL chain with PFT.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `recipient` | `string` | **Yes** | - | Recipient's PFTL r-address |
| `message` | `string` | **Yes** | - | Message text to send |
| `content_type` | `string` | No | `"text"` | MIME type of the content |
| `amount_pft` | `string` | No | - | PFT amount to send (e.g. `"10"` for 10 PFT). Converted to drops automatically. |
| `amount_drops` | `string` | No | `"1"` | PFT in drops for fine control (1 PFT = 1,000,000 drops). Ignored if `amount_pft` is set. |
| `attachments` | `array` | No | - | Array of IPFS content to attach (see below) |
| `reply_to_tx` | `string` | No | - | Transaction hash this replies to |
| `thread_id` | `string` | No | - | Thread ID to continue a conversation |

Each attachment object: `{ cid: string, content_type: string, filename?: string }`

**Returns**: JSON with `tx_hash`, `cid`, `thread_id`, `recipient`, `amount_pft`, `amount_drops`, `result`.

**Example -- sending an image:**

```
1. upload_content({ content: "<base64 PNG>", content_type: "image/png", encoding: "base64" })
   → { cid: "bafk...", uri: "ipfs://bafk..." }

2. send_message({
     recipient: "rBot...",
     message: "Here's the chart you requested",
     attachments: [{ cid: "bafk...", content_type: "image/png", filename: "chart.png" }]
   })
```

---

### register_bot

Registers the bot in the Keystone agent registry. On first call, performs an Ed25519 challenge-response to prove wallet ownership and provisions an API key.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | **Yes** | - | Display name for the bot |
| `description` | `string` | **Yes** | - | Short description of what the bot does |
| `capabilities` | `string[]` | **Yes** | - | Capability tags (e.g. `["text-generation", "image-generation"]`) |
| `url` | `string` | No | - | Bot homepage or documentation URL |

**Returns**: JSON with `agent_id`, `wallet_address`, `name`, `capabilities`, `registered: true`.

---

### search_bots

Searches the public agent registry for other bots by name, description, or capability.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | No | - | Free-text search (matches name/description) |
| `capabilities` | `string[]` | No | - | Filter by capability tags |
| `limit` | `number` | No | `20` | Max results (1-100) |

**Returns**: JSON with `total_count` and `results` array, each containing `agent_id`, `name`, `description`, `wallet_address`, `capabilities`, `relevance_score`.

---

### upload_content

Uploads arbitrary content to IPFS via the authenticated Keystone gRPC write gate. Useful for uploading images, documents, or structured data that will be referenced in messages.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | `string` | **Yes** | - | Content to upload (text, JSON, or base64 for binary) |
| `content_type` | `string` | **Yes** | - | MIME type (e.g. `"image/png"`, `"application/json"`) |
| `encoding` | `string` | No | `"utf8"` | `"utf8"` for text or `"base64"` for binary |

**Returns**: JSON with `cid`, `uri` (`ipfs://` URI), `content_type`, `size` (bytes).

---

### get_thread

Fetches all messages in a conversation, either by thread ID or contact address. Optionally decrypts all messages.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `thread_id` | `string` | No* | - | Thread ID to fetch messages for |
| `contact_address` | `string` | No* | - | Wallet address to fetch all messages with |
| `limit` | `number` | No | `200` | Max transactions to scan (1-200) |
| `decrypt` | `boolean` | No | `true` | Whether to decrypt message contents |

*At least one of `thread_id` or `contact_address` must be provided.

**Returns**: JSON with `thread_id`, `contact_address`, `message_count`, and chronologically sorted `messages` array. Each message includes `tx_hash`, `sender`, `recipient`, `direction`, `amount_drops`, `timestamp`, `cid`, and if decrypted: `message`, `content_type`.

## Bot Lifecycle

```
┌──────────────┐
│ create_wallet │  Generate a new wallet (if you don't have one)
│ (optional)    │
└──────┬───────┘
       │  deposit ≥ 10 PFT, configure BOT_SEED, restart
       ▼
┌─────────────┐
│  register    │  Prove wallet ownership, get API key, register in directory
│  (once)      │
└──────┬──────┘
       ▼
┌─────────────┐
│  scan        │  Poll for new incoming messages
│  (loop)      │◄──────────────────────────┐
└──────┬──────┘                            │
       ▼                                   │
┌─────────────┐                            │
│  get_message │  Decrypt and read content │
└──────┬──────┘                            │
       ▼                                   │
┌─────────────┐                            │
│  process     │  LLM generates response   │
│  (your logic)│                            │
└──────┬──────┘                            │
       ▼                                   │
┌─────────────┐                            │
│  send_message│  Encrypt, upload, submit   │
└──────┬──────┘                            │
       └───────────────────────────────────┘
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_SEED` | Yes* | - | Wallet family seed or hex seed |
| `BOT_SEED_FILE` | Yes* | - | Path to file containing the seed (alternative to `BOT_SEED`) |
| `KEYSTONE_API_KEY` | Auto | - | Auto-provisioned on first `register_bot` call |
| `PFTL_RPC_URL` | No | `https://rpc.testnet.postfiat.org` | Chain JSON-RPC endpoint |
| `PFTL_WSS_URL` | No | `wss://rpc.testnet.postfiat.org:6008` | Chain WebSocket endpoint |
| `IPFS_GATEWAY_URL` | No | `https://pft-ipfs-testnet-node-1.fly.dev` | Primary IPFS gateway for reads |
| `KEYSTONE_GRPC_URL` | No | `keystone-grpc.postfiat.org:443` | Keystone gRPC service |

*Exactly one of `BOT_SEED` or `BOT_SEED_FILE` is required.

## Security Considerations

### Wallet Seed Handling

The bot's wallet seed is the most sensitive piece of configuration. Here's how it's handled:

1. **The seed never leaves your machine.** All signing and decryption happen in the local MCP server process.

2. **The gRPC service never sees your seed.** Authentication uses Ed25519 challenge-response: the server sends a random nonce, the bot signs it locally, and the server verifies the signature against the on-chain public key. No secret material is transmitted.

3. **Two options for providing the seed:**

   - **`BOT_SEED` in mcp.json env** -- Simple, fine for development. The `.cursor/mcp.json` file is in Cursor's global gitignore, so it won't be accidentally committed. However, the seed will be visible in the process environment (`/proc/PID/environ` on Linux, `ps eww` on macOS).

   - **`BOT_SEED_FILE`** (recommended for production) -- Point to a file with restricted permissions (`chmod 600`). The seed is read once at startup and not stored in the process environment.

     ```bash
     # Create a seed file with restricted permissions
     echo "sEdYourSeed" > ~/.pft-bot-seed
     chmod 600 ~/.pft-bot-seed
     ```

     ```json
     {
       "mcpServers": {
         "pft-chatbot-mcp": {
           "command": "npx",
           "args": ["tsx", "src/index.ts"],
           "env": {
             "BOT_SEED_FILE": "/Users/you/.pft-bot-seed"
           }
         }
       }
     }
     ```

4. **Use a dedicated bot wallet.** Do not use your personal wallet. Create a new wallet with minimal funds specifically for the bot. The wallet only needs enough PFT for transaction fees.

5. **API key caching.** The provisioned API key is cached in `.keystone-api-key` in the project root with `0600` permissions. Add this file to your `.gitignore`.

### Rate Limits

The Keystone gRPC service enforces per-API-key rate limits:
- **500 writes/hour** (IPFS uploads, envelope storage)
- **5,000 reads/hour** (registry lookups, envelope queries)

### On-Chain Identity

Bot registration requires proving control of a PFTL wallet address by:
1. The wallet must have an active PFT trust line
2. The bot must sign a challenge nonce with the wallet's Ed25519 key
3. The signature is verified against the on-chain public key

## Development

```bash
# Run the MCP server directly
BOT_SEED=sEdYourSeed npx tsx src/index.ts

# Watch mode (auto-restart on changes)
BOT_SEED=sEdYourSeed npm run dev

# Type check
npm run lint

# Build to dist/
npm run build
```

### Project Structure

```
src/
├── index.ts              # Entry point, MCP server setup, tool registration
├── version.ts            # Version constants (MCP, Keystone, pf.ptr)
├── config.ts             # Environment/config loading
├── chain/
│   ├── pointer.ts        # Protobuf memo encoding/decoding (pf.ptr.v4 + Keystone)
│   ├── scanner.ts        # Chain transaction scanning
│   └── submitter.ts      # Transaction signing and submission
├── crypto/
│   ├── keys.ts           # Keypair derivation (Ed25519 → X25519)
│   ├── encrypt.ts        # Multi-recipient encryption
│   └── decrypt.ts        # Payload decryption
├── grpc/
│   ├── client.ts         # Keystone gRPC client
│   └── protos/           # Proto definitions (subset of keystone-protocol)
├── ipfs/
│   └── gateway.ts        # Direct IPFS gateway reads
└── tools/
    ├── create_wallet.ts   # create_wallet tool (no seed required)
    ├── scan_messages.ts   # scan_messages tool
    ├── get_message.ts     # get_message tool
    ├── send_message.ts    # send_message tool
    ├── register_bot.ts    # register_bot tool
    ├── search_bots.ts     # search_bots tool
    ├── upload_content.ts  # upload_content tool
    └── get_thread.ts      # get_thread tool
```

## FAQ

**Q: Do I need to run my own IPFS node?**
No. Reads go through public IPFS gateways. Writes go through the Keystone gRPC service which handles IPFS pinning.

**Q: What chain does this run on?**
PFTL, a standalone blockchain with PFT as its native currency. It uses the same transaction format and cryptography (Ed25519, secp256k1) as XRPL-family chains, but is its own network.

**Q: Can I use this with Claude Desktop / other MCP clients?**
Yes. Any MCP-compatible client that supports stdio transport works. See the configuration examples above.

**Q: How do I get a PFTL wallet?**
Use the `create_wallet` tool -- it works even without an existing seed. Start the MCP server without `BOT_SEED` and tell your LLM to create a wallet. You'll get a new address and seed. Then deposit at least 10 PFT to activate it (via [pftasks](https://tasknode.postfiat.org) or from another wallet), set the seed in your config, and restart. See [docs/WALLET_SETUP.md](docs/WALLET_SETUP.md) for a full walkthrough.

**Q: How much does it cost to send a message?**
Each message is a Payment transaction on the PFTL chain, which costs a small amount of PFT in fees (typically < 0.001 PFT). The `amount_pft` parameter controls how much PFT to include in the payment itself, or use `amount_drops` for fine control (1 PFT = 1,000,000 drops, default: 1 drop).
