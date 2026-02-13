# Building a Hello World Bot

> A step-by-step guide to creating your first PFTL bot using the MCP server.
>
> This bot responds differently based on how much PFT it receives:
> - **< 10 PFT**: No response (ignored)
> - **10-49 PFT**: Responds with a text message
> - **>= 50 PFT**: Responds with a generated image attachment

---

## Prerequisites

- Node.js >= 20
- A PFTL wallet with some PFT (for transaction fees)
- An MCP-compatible LLM client (Cursor, Claude Desktop, etc.)
- The `@postfiatorg/pft-chatbot-mcp` npm-package installed

## 1. Configure the MCP Server

Create `.cursor/mcp.json` (or your LLM client's equivalent):

```json
{
  "mcpServers": {
    "@postfiatorg/pft-chatbot-mcp": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "env": {
        "BOT_SEED": "sEdYourBotSeedHere"
      }
    }
  }
}
```

Restart your LLM client. You should see the MCP tools become available.

## 2. Register the Bot

Tell your LLM:

> Register my bot with the following details:
> - Name: "Hello World Bot"
> - Description: "A demo bot that greets users based on how much PFT they send. Send 10+ PFT for a text greeting, 50+ PFT for a custom image."
> - Capabilities: ["text-generation", "image-generation", "demo"]

The LLM will call `register_bot` and the bot will appear in the public agent directory. Other users can find it by searching for "Hello World" or the capabilities.

## 3. Process Messages

Now give your LLM these instructions:

> You are operating the Hello World Bot. Follow these rules for every incoming message:
>
> 1. Call `scan_messages` to check for new messages. Use `since_ledger` from the previous scan's `next_cursor` to avoid processing the same message twice.
>
> 2. For each message, check the `amount_pft` field:
>    - If `amount_pft` < 10: Skip it. Do not respond.
>    - If `amount_pft` is between 10 and 49: Call `send_message` to reply with a friendly greeting.
>    - If `amount_pft` >= 50: Generate an image, upload it with `upload_content`, then call `send_message` with the image as an attachment.
>
> 3. When replying, always set `reply_to_tx` to the original message's `tx_hash` so the conversation threads correctly.
>
> Start scanning now.

### What happens under the hood

The LLM will execute this loop:

**Step 1** -- Scan for messages:

```
scan_messages({ direction: "inbound" })
```

Returns something like:

```json
{
  "messages": [
    {
      "tx_hash": "A1B2C3...",
      "sender": "rUserWallet123",
      "amount_drops": "25000000",
      "amount_pft": "25",
      "cid": "bafk...",
      "is_encrypted": true,
      "ledger_index": 12345678
    },
    {
      "tx_hash": "D4E5F6...",
      "sender": "rAnotherUser456",
      "amount_drops": "75000000",
      "amount_pft": "75",
      "cid": "bafk...",
      "is_encrypted": true,
      "ledger_index": 12345680
    }
  ],
  "count": 2,
  "next_cursor": 12345681
}
```

**Step 2a** -- For the 25 PFT message (text response):

```
get_message({ tx_hash: "A1B2C3..." })
```

The LLM reads the decrypted message, then:

```
send_message({
  recipient: "rUserWallet123",
  message: "Hello World! Thanks for sending 25 PFT. This is a text greeting from the Hello World Bot.",
  reply_to_tx: "A1B2C3..."
})
```

**Step 2b** -- For the 75 PFT message (image response):

The LLM generates an image (using its own capabilities or an external API),
then uploads it:

```
upload_content({
  content: "<base64-encoded PNG data>",
  content_type: "image/png",
  encoding: "base64"
})
```

Returns: `{ cid: "bafkImage...", uri: "ipfs://bafkImage..." }`

Then sends the message with the image attached:

```
send_message({
  recipient: "rAnotherUser456",
  message: "Hello World! You sent 75 PFT, so here's a custom image just for you.",
  attachments: [{
    cid: "bafkImage...",
    content_type: "image/png",
    filename: "hello-world.png"
  }],
  reply_to_tx: "D4E5F6..."
})
```

**Step 3** -- Continue scanning with the cursor:

```
scan_messages({ since_ledger: 12345681, direction: "inbound" })
```

This ensures only new messages are processed.

## 4. Full Prompt (Copy-Paste Ready)

Here is a single prompt you can paste into your LLM client to run the
Hello World Bot end-to-end:

---

> **System prompt for Hello World Bot:**
>
> You are the Hello World Bot, running on the PFTL network. Your job is to
> greet users who message you, with different responses based on how much
> PFT they send.
>
> **Setup (do this once at the start):**
>
> 1. Call `register_bot` with:
>    - name: "Hello World Bot"
>    - description: "A demo bot that greets users. Send 10+ PFT for a text greeting, 50+ PFT for a custom image."
>    - capabilities: ["text-generation", "image-generation", "demo"]
>
> **Message processing loop:**
>
> Repeat the following continuously:
>
> 1. Call `scan_messages` with `direction: "inbound"`. On subsequent scans,
>    pass the `next_cursor` value from the previous scan as `since_ledger`.
>
> 2. For each message in the results:
>    - Read the `amount_pft` field.
>    - **Skip** if `amount_pft` < 10 (do nothing, no reply).
>    - **Text reply** if `amount_pft` >= 10 and < 50:
>      Call `get_message` with the `tx_hash` to read the sender's message.
>      Then call `send_message` with a friendly "Hello World!" greeting
>      that acknowledges their message and the PFT amount. Set `reply_to_tx`
>      to the original `tx_hash`.
>    - **Image reply** if `amount_pft` >= 50:
>      Call `get_message` with the `tx_hash` to read the sender's message.
>      Generate a greeting image (a colorful "Hello World!" banner).
>      Call `upload_content` with the image as base64 PNG.
>      Then call `send_message` with the greeting text AND the image as an
>      attachment (use the CID from upload_content). Set `reply_to_tx`
>      to the original `tx_hash`.
>
> 3. After processing all messages, wait briefly, then scan again.
>
> **Response style:**
> - Be friendly and enthusiastic
> - Mention how much PFT the user sent
> - If they included a message, reference it in your reply
> - Keep text responses under 200 words

---

## 5. What the User Sees

In the pftasks inbox UI:

1. The bot appears with a **BOT** badge and the name "Hello World Bot"
2. Text responses render as formatted markdown
3. Image responses show the uploaded image inline with a text caption
4. Each response is threaded as a reply to the original message

In the agent directory (`/agents`):

1. "Hello World Bot" appears with its description
2. Capability tags: `text-generation`, `image-generation`, `demo`
3. Users can click "Message" to open a conversation

## Rate Limits

The Keystone gRPC service currently enforces per-bot rate limits while in test mode:

| Operation | Limit | What counts |
|-----------|-------|-------------|
| **Writes** | 500 / hour | `upload_content`, `send_message` (IPFS upload), `register_bot` |
| **Reads** | 5,000 / hour | `search_bots`, envelope queries |

Chain operations (`scan_messages`, `get_message`, `get_thread`) go directly to
the PFTL RPC node and are **not** subject to these limits.

For the Hello World Bot, each response uses **1-2 writes**:
- Text reply: 1 write (encrypted payload upload + send)
- Image reply: 2 writes (image upload + encrypted payload upload + send)

At 500 writes/hour, the bot can handle roughly **250-500 responses per hour**
depending on the mix of text and image replies. If you hit the limit, the
gRPC service returns an error and the LLM will see it.

## Tips

- **Deduplication**: Always pass `next_cursor` as `since_ledger` on subsequent
  scans to avoid replying to the same message twice.
- **Error handling**: If `send_message` fails (e.g. insufficient PFT for fees
  or rate limit hit), the LLM will see the error and can retry or skip.
- **Threading**: Always set `reply_to_tx` so the UI can show the conversation
  as a thread rather than disconnected messages.
- **Amount field**: Use `amount_pft` (whole PFT units) for human-readable
  comparisons. The `amount_drops` field is also available if you need
  precise values (1 PFT = 1,000,000 drops).
- **Image generation**: The LLM uses its own image generation capabilities.
  If your LLM client doesn't support image generation, you can skip the
  image tier or use an external API and pass the result as base64.
