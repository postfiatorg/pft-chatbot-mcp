#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { deriveBotKeypair } from "./crypto/keys.js";
import { KeystoneClient } from "./grpc/client.js";
import { MCP_VERSION, KEYSTONE_PROTOCOL_VERSION, PF_PTR_VERSION } from "./version.js";

// Tool implementations
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
import {
  uploadContentSchema,
  executeUploadContent,
} from "./tools/upload_content.js";
import { getThreadSchema, executeGetThread } from "./tools/get_thread.js";

async function main() {
  // Load configuration (validates BOT_SEED is present)
  const config = loadConfig();

  // Derive bot keypairs from seed
  const keypair = await deriveBotKeypair(config.botSeed);

  // Create gRPC client for Keystone services
  const grpcClient = new KeystoneClient(config);

  // Create MCP server
  const server = new McpServer({
    name: "pft-chatbot-mcp",
    version: MCP_VERSION,
  });

  // --- Register tools ---

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
    "Fetch and decrypt a specific message by transaction hash or IPFS CID. Returns the full decrypted message content.",
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
    "Send an encrypted message to a PFTL address. Encrypts the content, uploads to IPFS, and submits a Payment transaction on-chain with PFT.",
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
    "Register this bot in the Keystone agent registry with a name, description, and capabilities. Auto-provisions an API key on first use.",
    {
      name: registerBotSchema.shape.name,
      description: registerBotSchema.shape.description,
      capabilities: registerBotSchema.shape.capabilities,
      url: registerBotSchema.shape.url,
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
    "Search the Keystone agent registry for registered bots by name, description, or capabilities.",
    {
      query: searchBotsSchema.shape.query,
      capabilities: searchBotsSchema.shape.capabilities,
      limit: searchBotsSchema.shape.limit,
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
    "upload_content",
    "Upload arbitrary content to IPFS via the Keystone gRPC write gate. Returns the CID and content descriptor.",
    {
      content: uploadContentSchema.shape.content,
      content_type: uploadContentSchema.shape.content_type,
      encoding: uploadContentSchema.shape.encoding,
    },
    async (params) => {
      try {
        const result = await executeUploadContent(config, grpcClient, params);
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

  // Connect via stdio transport (standard MCP protocol)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  process.stderr.write(
    `pft-chatbot-mcp v${MCP_VERSION} (keystone ${KEYSTONE_PROTOCOL_VERSION}, pf.ptr ${PF_PTR_VERSION})\n`
  );
  process.stderr.write(`Wallet: ${keypair.address}\n`);
  process.stderr.write(`Chain RPC: ${config.pftlRpcUrl}\n`);
  process.stderr.write(`Keystone gRPC: ${config.keystoneGrpcUrl}\n`);
  process.stderr.write(`IPFS Gateway: ${config.ipfsGatewayUrl}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
