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
import { executeDeleteBot } from "./tools/delete_bot.js";
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

// ── PFTL DEX tools ────────────────────────────────────────────────────────────
import {
  dexGetBalancesSchema,
  executeDexGetBalances,
} from "./tools/dex_get_balances.js";
import {
  dexGetOrderBookSchema,
  executeDexGetOrderBook,
} from "./tools/dex_get_order_book.js";
import {
  dexGetAmmInfoSchema,
  executeDexGetAmmInfo,
} from "./tools/dex_get_amm_info.js";
import {
  dexGetOpenOrdersSchema,
  executeDexGetOpenOrders,
} from "./tools/dex_get_open_orders.js";
import {
  dexSetTrustLineSchema,
  executeDexSetTrustLine,
} from "./tools/dex_set_trust_line.js";
import { dexSwapSchema, executeDexSwap } from "./tools/dex_swap.js";
import {
  dexPlaceLimitOrderSchema,
  executeDexPlaceLimitOrder,
} from "./tools/dex_place_limit_order.js";
import {
  dexCancelOrderSchema,
  executeDexCancelOrder,
} from "./tools/dex_cancel_order.js";
import {
  dexAmmDepositSchema,
  executeDexAmmDeposit,
} from "./tools/dex_amm_deposit.js";
import {
  dexAmmWithdrawSchema,
  executeDexAmmWithdraw,
} from "./tools/dex_amm_withdraw.js";

// ── PFTL NFT tools ────────────────────────────────────────────────────────────
import {
  nftGetOwnedSchema,
  executeNftGetOwned,
} from "./tools/nft_get_owned.js";
import {
  nftGetListingsSchema,
  executeNftGetListings,
} from "./tools/nft_get_listings.js";
import {
  nftGetOffersSchema,
  executeNftGetOffers,
} from "./tools/nft_get_offers.js";
import {
  nftListForSaleSchema,
  executeNftListForSale,
} from "./tools/nft_list_for_sale.js";
import { nftBuySchema, executeNftBuy } from "./tools/nft_buy.js";
import {
  nftCancelOfferSchema,
  executeNftCancelOffer,
} from "./tools/nft_cancel_offer.js";

// ── Financial signal tools ─────────────────────────────────────────────────
import {
  sendFinancialSignalSchema,
  executeSendFinancialSignal,
} from "./tools/send_financial_signal.js";
import {
  decodeFinancialSignalSchema,
  executeDecodeFinancialSignal,
} from "./tools/decode_financial_signal.js";

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
      "Delete this bot's registration from the Keystone agent registry. Uses the bot's own wallet address as the agent ID.",
      {},
      async () => {
        try {
          const result = await executeDeleteBot(config, keypair, grpcClient);
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

    // ── PFTL DEX tools ──────────────────────────────────────────────────────

    server.tool(
      "dex_get_balances",
      "Get the native PFT balance and all issued token trust-line balances for the bot's wallet or any PFTL address.",
      { address: dexGetBalancesSchema.shape.address },
      async (params) => {
        try {
          const result = await executeDexGetBalances(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_get_order_book",
      'Fetch both sides of the PFTL DEX order book for any asset pair. Pass asset1 and asset2 as "PFT" or {currency, issuer}. Returns all resting orders with amounts and quality.',
      {
        asset1: dexGetOrderBookSchema.shape.asset1,
        asset2: dexGetOrderBookSchema.shape.asset2,
        limit:  dexGetOrderBookSchema.shape.limit,
      },
      async (params) => {
        try {
          const result = await executeDexGetOrderBook(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_get_amm_info",
      'Get live AMM pool info for any asset pair on the PFTL chain. Pass asset1 and asset2 as "PFT" or {currency, issuer}. Returns reserves, spot price, LP token supply, and trading fee.',
      {
        asset1: dexGetAmmInfoSchema.shape.asset1,
        asset2: dexGetAmmInfoSchema.shape.asset2,
      },
      async (params) => {
        try {
          const result = await executeDexGetAmmInfo(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_get_open_orders",
      "Get all currently open limit orders for the bot's wallet or any PFTL address, across all trading pairs. Returns Sequence numbers needed for dex_cancel_order.",
      {
        address: dexGetOpenOrdersSchema.shape.address,
        limit:   dexGetOpenOrdersSchema.shape.limit,
      },
      async (params) => {
        try {
          const result = await executeDexGetOpenOrders(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_set_trust_line",
      "Establish or update a trust line for any issued token on the PFTL chain. Required before the bot can receive or hold that token. Safe to call again to update the limit.",
      {
        currency: dexSetTrustLineSchema.shape.currency,
        issuer:   dexSetTrustLineSchema.shape.issuer,
        limit:    dexSetTrustLineSchema.shape.limit,
      },
      async (params) => {
        try {
          const result = await executeDexSetTrustLine(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_swap",
      'Execute a market swap on the PFTL DEX. Uses ImmediateOrCancel — fills at current market price, any unfilled remainder is discarded. Pass assets as "PFT" or {currency, issuer}. Use dex_get_order_book first to estimate fill. Receiving an issued token requires a trust line (dex_set_trust_line).',
      {
        sell:           dexSwapSchema.shape.sell,
        sell_amount:    dexSwapSchema.shape.sell_amount,
        buy:            dexSwapSchema.shape.buy,
        min_buy_amount: dexSwapSchema.shape.min_buy_amount,
      },
      async (params) => {
        try {
          const result = await executeDexSwap(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_place_limit_order",
      'Place a resting limit order on the PFTL DEX order book. Persists until fully matched or cancelled. Pass assets as "PFT" or {currency, issuer}. Use dex_get_open_orders for its Sequence and dex_cancel_order to remove it.',
      {
        sell:        dexPlaceLimitOrderSchema.shape.sell,
        sell_amount: dexPlaceLimitOrderSchema.shape.sell_amount,
        buy:         dexPlaceLimitOrderSchema.shape.buy,
        buy_amount:  dexPlaceLimitOrderSchema.shape.buy_amount,
      },
      async (params) => {
        try {
          const result = await executeDexPlaceLimitOrder(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_cancel_order",
      "Cancel an open limit order on the PFTL DEX by its Sequence number. Obtain the Sequence from dex_get_open_orders.",
      { offer_sequence: dexCancelOrderSchema.shape.offer_sequence },
      async (params) => {
        try {
          const result = await executeDexCancelOrder(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_amm_deposit",
      'Deposit liquidity into a PFTL AMM pool and receive LP tokens. Pass assets as "PFT" or {currency, issuer}. Provide both amounts for a proportional two-asset deposit, or one amount for a single-asset deposit.',
      {
        asset1:        dexAmmDepositSchema.shape.asset1,
        asset1_amount: dexAmmDepositSchema.shape.asset1_amount,
        asset2:        dexAmmDepositSchema.shape.asset2,
        asset2_amount: dexAmmDepositSchema.shape.asset2_amount,
      },
      async (params) => {
        try {
          const result = await executeDexAmmDeposit(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "dex_amm_withdraw",
      "Withdraw liquidity from a PFTL AMM pool by redeeming LP tokens. Use dex_get_amm_info for the LP token currency and issuer, and dex_get_balances for your LP token balance.",
      {
        asset1:             dexAmmWithdrawSchema.shape.asset1,
        asset2:             dexAmmWithdrawSchema.shape.asset2,
        lp_token_amount:    dexAmmWithdrawSchema.shape.lp_token_amount,
        lp_token_currency:  dexAmmWithdrawSchema.shape.lp_token_currency,
        lp_token_issuer:    dexAmmWithdrawSchema.shape.lp_token_issuer,
      },
      async (params) => {
        try {
          const result = await executeDexAmmWithdraw(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    // ── PFTL NFT tools ───────────────────────────────────────────────────────

    server.tool(
      "nft_get_owned",
      "Get NFTs owned by the bot's wallet or any PFTL address. Supports pagination via marker. Set resolve_metadata=true to fetch IPFS name/description/image for each NFT (slower for large collections).",
      {
        address:          nftGetOwnedSchema.shape.address,
        limit:            nftGetOwnedSchema.shape.limit,
        marker:           nftGetOwnedSchema.shape.marker,
        resolve_metadata: nftGetOwnedSchema.shape.resolve_metadata,
      },
      async (params) => {
        try {
          const result = await executeNftGetOwned(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "nft_get_listings",
      "Scan a PFTL NFT issuer's collection for NFTs with active sell offers. Returns price, offer_id, and IPFS URI for each listed NFT. Use marker to paginate through large collections.",
      {
        issuer: nftGetListingsSchema.shape.issuer,
        limit:  nftGetListingsSchema.shape.limit,
        marker: nftGetListingsSchema.shape.marker,
      },
      async (params) => {
        try {
          const result = await executeNftGetListings(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "nft_get_offers",
      "Get all active sell offers for a specific NFT by its NFTokenID. Returns offer IDs, prices, and owners. Use the offer_id with nft_buy to purchase.",
      { nft_id: nftGetOffersSchema.shape.nft_id },
      async (params) => {
        try {
          const result = await executeNftGetOffers(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "nft_list_for_sale",
      "Create an on-chain sell offer for an NFT owned by the bot. The offer is publicly visible on the PFTL ledger. Use nft_get_offers afterward to retrieve the offer_id.",
      {
        nft_id:      nftListForSaleSchema.shape.nft_id,
        price_pft:   nftListForSaleSchema.shape.price_pft,
        destination: nftListForSaleSchema.shape.destination,
        expiration:  nftListForSaleSchema.shape.expiration,
      },
      async (params) => {
        try {
          const result = await executeNftListForSale(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "nft_buy",
      "Accept an NFT sell offer (purchase the NFT). Provide the offer_id from nft_get_listings or nft_get_offers. The listed PFT price is deducted from the bot's wallet.",
      { offer_id: nftBuySchema.shape.offer_id },
      async (params) => {
        try {
          const result = await executeNftBuy(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "nft_cancel_offer",
      "Cancel one or more of the bot's NFT sell offers, removing them from the ledger. Use nft_get_offers to find the offer IDs to cancel.",
      { offer_ids: nftCancelOfferSchema.shape.offer_ids },
      async (params) => {
        try {
          const result = await executeNftCancelOffer(config, keypair, params);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    // ── Financial signal tools ───────────────────────────────────────────────

    server.tool(
      "send_financial_signal",
      "Send a structured protobuf-encoded financial signal to another Post Fiat agent. " +
        "Signals replace free-text messages for machine-readable financial data: price quotes, " +
        "trade intents, trade confirmations, portfolio snapshots, and risk metrics. " +
        "The signal is encrypted, uploaded to IPFS, and delivered on-chain just like a regular message. " +
        "Use decode_financial_signal on the receiving side to deserialize the payload.",
      {
        recipient:            sendFinancialSignalSchema.shape.recipient,
        signal_kind:          sendFinancialSignalSchema.shape.signal_kind,
        signal_data:          sendFinancialSignalSchema.shape.signal_data,
        correlation_id:       sendFinancialSignalSchema.shape.correlation_id,
        expires_at:           sendFinancialSignalSchema.shape.expires_at,
        amount_pft:           sendFinancialSignalSchema.shape.amount_pft,
        amount_drops:         sendFinancialSignalSchema.shape.amount_drops,
        thread_id:            sendFinancialSignalSchema.shape.thread_id,
        reply_to_tx:          sendFinancialSignalSchema.shape.reply_to_tx,
        share_with_tasknode:  sendFinancialSignalSchema.shape.share_with_tasknode,
      },
      async (params) => {
        try {
          const result = await executeSendFinancialSignal(
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
      "decode_financial_signal",
      "Fetch, decrypt, and deserialize a financial signal message sent by another agent. " +
        "Provide either a tx_hash (from scan_messages) or a CID. " +
        "Returns the fully decoded signal including the kind-specific payload fields " +
        "(e.g. bid_price/ask_price for price_quote, filled_price/tx_hash for trade_confirmation). " +
        "Only works on messages sent with send_financial_signal.",
      {
        tx_hash: decodeFinancialSignalSchema.shape.tx_hash,
        cid:     decodeFinancialSignalSchema.shape.cid,
      },
      async (params) => {
        try {
          const result = await executeDecodeFinancialSignal(
            config,
            keypair,
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
    if (config!.tasknodeEncryptionKey) {
      process.stderr.write(`Tasknode sharing: enabled (${config!.tasknodeKeySource})\n`);
    } else {
      process.stderr.write(`Tasknode sharing: disabled\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
