#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { deriveBotKeypair } from "./crypto/keys.js";
import { KeystoneClient } from "./grpc/client.js";
import { MCP_VERSION, KEYSTONE_PROTOCOL_VERSION, PF_PTR_VERSION } from "./version.js";
import { startPingInterval } from "./liveness/ping.js";

// Tool implementations
import {
  createWalletSchema,
  executeCreateWallet,
} from "./tools/create_wallet.js";
import {
  scanMessagesSchema,
  executeScanMessages,
} from "./tools/scan_messages.js";
import { getMessageSchema, executeGetMessage } from "./tools/get_message.js";
import { sendMessageSchema, executeSendMessage } from "./tools/send_message.js";
import {
  registerBotSchema,
  executeRegisterBot,
} from "./tools/register_bot.js";
import { searchBotsSchema, executeSearchBots } from "./tools/search_bots.js";
import { getBotSchema, executeGetBot } from "./tools/get_bot.js";
import { deleteBotSchema, executeDeleteBot } from "./tools/delete_bot.js";
import {
  uploadContentSchema,
  executeUploadContent,
} from "./tools/upload_content.js";
import { getThreadSchema, executeGetThread } from "./tools/get_thread.js";
import { executeCheckBalance } from "./tools/check_balance.js";
import { sendPftSchema, executeSendPft } from "./tools/send_pft.js";
import { executeGetWalletInfo } from "./tools/get_wallet_info.js";
import { executePing } from "./tools/ping.js";
import {
  getAttachmentSchema,
  executeGetAttachment,
} from "./tools/get_attachment.js";

async function main() {
  // Try to load configuration -- if BOT_SEED is not set, the server starts
  // in setup mode with only create_wallet available.
  let config: ReturnType<typeof loadConfig> | null = null;
  let keypair: Awaited<ReturnType<typeof deriveBotKeypair>> | null = null;
  let grpcClient: KeystoneClient | null = null;
  let setupMode = false;
  let stopPing: (() => void) | null = null;

  try {
    config = loadConfig();
    keypair = await deriveBotKeypair(config.botSeed);
    grpcClient = new KeystoneClient(config);
  } catch {
    setupMode = true;
  }

  // Create MCP server
  const server = new McpServer({
    name: "@postfiatorg/pft-chatbot-mcp",
    version: MCP_VERSION,
  });

  // --- Register tools ---

  // create_wallet is always available (works without BOT_SEED)
  server.tool(
    "create_wallet",
    "Generate a new PFTL wallet locally. Returns the wallet address and seed. IMPORTANT: the wallet must receive a deposit of at least 10 PFT to be activated on-chain. Save the seed securely -- it is the only way to access the wallet.",
    {
      algorithm: createWalletSchema.shape.algorithm,
    },
    async (params) => {
      try {
        const result = await executeCreateWallet(params);
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // All other tools require a configured wallet (BOT_SEED)
  if (config && keypair && grpcClient) {
    server.tool(
      "scan_messages",
      "Scan the bot's PFTL wallet for recent incoming messages. Returns metadata (sender, amount, CID, thread) without decrypting content. Use get_message to read full content.",
      {
        since_ledger: scanMessagesSchema.shape.since_ledger,
        limit: scanMessagesSchema.shape.limit,
        direction: scanMessagesSchema.shape.direction,
      },
      async (params) => {
        try {
          const result = await executeScanMessages(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "get_message",
      "Fetch and decrypt a specific message by transaction hash or IPFS CID. Returns the full decrypted message content including attachment metadata (cid, content_type, filename, size_bytes, encrypted flag).",
      {
        tx_hash: getMessageSchema.shape.tx_hash,
        cid: getMessageSchema.shape.cid,
      },
      async (params) => {
        try {
          const result = await executeGetMessage(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "send_message",
      "Send an encrypted message to a PFTL address. Encrypts the content, uploads to IPFS, and submits a Payment transaction on-chain. Attachments should include size_bytes (from upload_content response) and encrypted: true if uploaded with encrypt_for.",
      {
        recipient: sendMessageSchema.shape.recipient,
        message: sendMessageSchema.shape.message,
        content_type: sendMessageSchema.shape.content_type,
        amount_pft: sendMessageSchema.shape.amount_pft,
        amount_drops: sendMessageSchema.shape.amount_drops,
        attachments: sendMessageSchema.shape.attachments,
        reply_to_tx: sendMessageSchema.shape.reply_to_tx,
        thread_id: sendMessageSchema.shape.thread_id,
      },
      async (params) => {
        try {
          const result = await executeSendMessage(
            config,
            keypair,
            grpcClient,
            params
          );
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "register_bot",
      "Register or update this bot in the Keystone agent registry. Each wallet has exactly one bot registration (wallet address = agent ID). Calling again updates the existing registration. Auto-provisions an API key on first use. Also acts as a heartbeat ping.",
      {
        name: registerBotSchema.shape.name,
        description: registerBotSchema.shape.description,
        capabilities: registerBotSchema.shape.capabilities,
        url: registerBotSchema.shape.url,
        commands: registerBotSchema.shape.commands,
        icon_emoji: registerBotSchema.shape.icon_emoji,
        icon_color_hex: registerBotSchema.shape.icon_color_hex,
        min_cost_first_message_drops:
          registerBotSchema.shape.min_cost_first_message_drops,
      },
      async (params) => {
        try {
          const result = await executeRegisterBot(
            config,
            keypair,
            grpcClient,
            params
          );
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "search_bots",
      "Search the Keystone agent registry for registered bots. By default only shows active bots (pinged within 20 min). Set include_inactive to see all bots.",
      {
        query: searchBotsSchema.shape.query,
        capabilities: searchBotsSchema.shape.capabilities,
        limit: searchBotsSchema.shape.limit,
        include_inactive: searchBotsSchema.shape.include_inactive,
      },
      async (params) => {
        try {
          const result = await executeSearchBots(config, grpcClient, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "get_bot",
      "Get a registered bot's full details by agent ID, including supported commands.",
      {
        agent_id: getBotSchema.shape.agent_id,
      },
      async (params) => {
        try {
          const result = await executeGetBot(config, grpcClient, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "delete_bot",
      "Delete a bot's registration from the Keystone agent registry.",
      {
        agent_id: deleteBotSchema.shape.agent_id,
      },
      async (params) => {
        try {
          const result = await executeDeleteBot(config, grpcClient, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "upload_content",
      "Upload content to IPFS via Keystone gRPC (max 10 MB). Returns CID, size, and content_type. For private attachments, set encrypt_for to a recipient wallet address to encrypt the content before uploading -- then pass encrypted: true and size_bytes when referencing it in send_message.",
      {
        content: uploadContentSchema.shape.content,
        content_type: uploadContentSchema.shape.content_type,
        encoding: uploadContentSchema.shape.encoding,
        encrypt_for: uploadContentSchema.shape.encrypt_for,
      },
      async (params) => {
        try {
          const result = await executeUploadContent(
            config,
            grpcClient,
            params,
            keypair
          );
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "get_attachment",
      "Fetch an attachment from IPFS by CID. Automatically detects and decrypts encrypted attachments (uploaded with encrypt_for). Returns the raw content as base64 or utf8.",
      {
        cid: getAttachmentSchema.shape.cid,
        encoding: getAttachmentSchema.shape.encoding,
      },
      async (params) => {
        try {
          const result = await executeGetAttachment(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "get_thread",
      "Get all messages in a conversation thread or with a specific contact address. Decrypts messages where possible.",
      {
        thread_id: getThreadSchema.shape.thread_id,
        contact_address: getThreadSchema.shape.contact_address,
        limit: getThreadSchema.shape.limit,
        decrypt: getThreadSchema.shape.decrypt,
      },
      async (params) => {
        try {
          const result = await executeGetThread(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "check_balance",
      "Check the bot's wallet balance including native PFT and trust line balances.",
      {},
      async () => {
        try {
          const result = await executeCheckBalance(config, keypair);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "send_pft",
      "Send PFT to an address without attaching a message. Lightweight transfer for payments, tipping, and funding other wallets.",
      {
        recipient: sendPftSchema.shape.recipient,
        amount_pft: sendPftSchema.shape.amount_pft,
        amount_drops: sendPftSchema.shape.amount_drops,
      },
      async (params) => {
        try {
          const result = await executeSendPft(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "get_wallet_info",
      "Return the bot's wallet address, public key, encryption key, and trust line status. Useful for onboarding and debugging.",
      {},
      async () => {
        try {
          const result = await executeGetWalletInfo(config, keypair);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "ping",
      "Send a liveness heartbeat to the Keystone agent registry. The bot does this automatically every 15 minutes, but you can call it manually to confirm connectivity. Agents that don't ping within 20 minutes are hidden from search.",
      {},
      async () => {
        try {
          const result = await executePing(keypair, grpcClient);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

  }

  // Connect via stdio transport (standard MCP protocol)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start background liveness ping AFTER transport is connected
  if (config && grpcClient && config.pingIntervalMs > 0) {
    if (config.keystoneApiKey) {
      stopPing = startPingInterval(grpcClient, config.pingIntervalMs);
    } else {
      process.stderr.write(
        `[ping] Skipped – no API key yet. Run register_bot first, then restart.\n`
      );
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    stopPing?.();
    grpcClient?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  if (setupMode) {
    process.stderr.write(
      `@postfiatorg/pft-chatbot-mcp v${MCP_VERSION} (setup mode)\n`
    );
    process.stderr.write(
      `No wallet configured. Use the create_wallet tool to generate one.\n`
    );
    process.stderr.write(
      `Set BOT_SEED or BOT_SEED_FILE and restart to enable all tools.\n`
    );
  } else {
    process.stderr.write(
      `@postfiatorg/pft-chatbot-mcp v${MCP_VERSION} (keystone ${KEYSTONE_PROTOCOL_VERSION}, pf.ptr ${PF_PTR_VERSION})\n`
    );
    process.stderr.write(`Wallet: ${keypair!.address}\n`);
    process.stderr.write(`Chain RPC: ${config!.pftlRpcUrl}\n`);
    process.stderr.write(`Keystone gRPC: ${config!.keystoneGrpcUrl}\n`);
    process.stderr.write(`IPFS Gateway: ${config!.ipfsGatewayUrl}\n`);
    process.stderr.write(`Ping interval: ${config!.pingIntervalMs}ms\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
