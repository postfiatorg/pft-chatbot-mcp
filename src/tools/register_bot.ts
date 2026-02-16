import { z } from "zod";
import { sign } from "node:crypto";
import type { Config } from "../config.js";
import { cacheApiKey } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";
import { publishMessageKey } from "../chain/submitter.js";
import { getAccountInfo } from "../chain/scanner.js";

export const registerBotSchema = z.object({
  name: z.string().describe("Display name for the bot"),
  description: z.string().describe("Short description of what the bot does"),
  capabilities: z
    .array(z.string())
    .describe(
      'Semantic capability URIs (e.g., ["text-summarization", "image-generation"])'
    ),
  url: z.string().optional().describe("Bot homepage or documentation URL"),
  commands: z
    .array(
      z.object({
        command: z.string().describe('Command string, e.g. "/clarify"'),
        example: z
          .string()
          .describe('Usage example, e.g. "/clarify what is PFT"'),
        description: z.string().describe("What the command does"),
        min_cost_drops: z
          .string()
          .optional()
          .describe(
            'Minimum PFT cost in drops to run this command (e.g. "1000000" for 1 PFT). 0 or omitted = no minimum beyond chain floor of 1 drop.'
          ),
      })
    )
    .optional()
    .describe("Supported commands with descriptions and optional costs"),
  icon_emoji: z
    .string()
    .optional()
    .describe('Bot icon emoji (e.g. "🤖")'),
  icon_color_hex: z
    .string()
    .optional()
    .describe(
      'Hex color for the bot icon, without # prefix (e.g. "FF5733")'
    ),
  min_cost_first_message_drops: z
    .string()
    .optional()
    .describe(
      'Minimum PFT cost in drops for first message to this bot (e.g. "1000000" for 1 PFT). 0 or omitted = no minimum beyond chain floor of 1 drop.'
    ),
});

export type RegisterBotParams = z.infer<typeof registerBotSchema>;

/**
 * Register a bot in the Keystone agent registry.
 *
 * If no API key is configured, this tool will first perform the
 * challenge-response auth flow to obtain one.
 */
export async function executeRegisterBot(
  config: Config,
  keypair: BotKeypair,
  grpcClient: KeystoneClient,
  params: RegisterBotParams
): Promise<string> {
  // Step 1: Ensure we have an API key (auto-provision if needed)
  if (!config.keystoneApiKey) {
    try {
      const apiKey = await provisionApiKey(config, keypair, grpcClient);
      config.keystoneApiKey = apiKey;
      grpcClient.setApiKey(apiKey);
    } catch (err: any) {
      return JSON.stringify(
        {
          error: `Failed to provision API key: ${err.message}`,
          hint: "Ensure your wallet has a PFT trust line and the Keystone gRPC service is reachable.",
        },
        null,
        2
      );
    }
  }

  // Step 2: Register the agent card
  // Normalize capability URIs
  const capabilities = params.capabilities.map((cap) =>
    cap.startsWith("http")
      ? cap
      : `https://schemas.postfiat.org/capabilities/${cap}/v1`
  );

  const commandsWithCosts = params.commands?.map((cmd) => ({
    command: cmd.command,
    example: cmd.example,
    description: cmd.description,
    minCostDrops: cmd.min_cost_drops,
  }));

  // One wallet address = one agent ID = one bot in the registry.
  // The server derives agent_id from the authenticated wallet address.
  const result = await grpcClient.storeAgentCard(
    {
      name: params.name,
      description: params.description,
      url: params.url,
    },
    {
      publicEncryptionKey: Buffer.from(keypair.x25519PublicKey),
      supportedSemanticCapabilities: capabilities,
    },
    commandsWithCosts,
    {
      iconEmoji: params.icon_emoji,
      iconColorHex: params.icon_color_hex,
      minCostFirstMessageDrops: params.min_cost_first_message_drops,
    }
  );

  // Step 3: Publish the X25519 encryption key as MessageKey on the PFTL ledger.
  // This is required so other wallets can resolve the bot's encryption key
  // from on-chain data and send encrypted messages.
  // Format: ED prefix (Edwards-curve identifier) + 32-byte X25519 key = 66 hex chars.
  const rawKeyHex = Buffer.from(keypair.x25519PublicKey)
    .toString("hex")
    .toUpperCase();
  const messageKeyHex = `ED${rawKeyHex}`;
  let messageKeyPublished = false;
  let messageKeyWarning: string | undefined;

  try {
    const accountInfo = await getAccountInfo(
      config.pftlRpcUrl,
      keypair.address
    );

    if (
      accountInfo.messageKey?.toUpperCase() === messageKeyHex.toUpperCase()
    ) {
      // Key already matches on-chain, no transaction needed
      messageKeyPublished = true;
    } else {
      const keyResult = await publishMessageKey(
        config,
        keypair.wallet,
        messageKeyHex
      );
      if (keyResult.result === "tesSUCCESS") {
        messageKeyPublished = true;
      } else {
        messageKeyWarning = `MessageKey transaction failed: ${keyResult.result}. Others may not be able to send encrypted messages until the key is published.`;
      }
    }
  } catch (err: any) {
    messageKeyWarning =
      `Could not publish messaging key on-chain: ${err.message}. ` +
      `Others may not be able to send encrypted messages until the key is published.`;
  }

  const response: Record<string, unknown> = {
    agent_id: result.agentId || keypair.address,
    wallet_address: keypair.address,
    name: params.name,
    capabilities,
    supported_commands: result.supportedCommands || params.commands || [],
    icon_emoji: result.iconEmoji || params.icon_emoji || "",
    icon_color_hex: result.iconColorHex || params.icon_color_hex || "",
    min_cost_first_message_drops:
      result.minCostFirstMessageDrops ||
      params.min_cost_first_message_drops ||
      "0",
    registered: true,
    message_key_published: messageKeyPublished,
  };

  if (messageKeyWarning) {
    response.message_key_warning = messageKeyWarning;
  }

  return JSON.stringify(response, null, 2);
}

/**
 * Perform the challenge-response auth flow to obtain an API key.
 */
async function provisionApiKey(
  config: Config,
  keypair: BotKeypair,
  grpcClient: KeystoneClient
): Promise<string> {
  // 1. Request challenge nonce
  const challenge = await grpcClient.requestApiKey(keypair.address);

  // 2. Sign the nonce with the bot's Ed25519 key
  // The PFTL wallet's publicKey is hex-encoded with "ED" prefix for Ed25519
  // We need to sign the raw nonce bytes for the gRPC auth challenge
  const nonceBytes = Buffer.from(challenge.challengeNonce, "hex");
  const privateKeyHex = keypair.wallet.privateKey;
  // PFTL private keys are prefixed with "ED" or "00" -- strip the prefix
  const rawPrivateKey = Buffer.from(
    privateKeyHex.startsWith("ED") || privateKeyHex.startsWith("00")
      ? privateKeyHex.slice(2)
      : privateKeyHex,
    "hex"
  );
  // Build Ed25519 private key in the format Node crypto expects (seed + public key)
  const publicKeyHex = keypair.wallet.publicKey;
  const rawPublicKey = Buffer.from(
    publicKeyHex.startsWith("ED") ? publicKeyHex.slice(2) : publicKeyHex,
    "hex"
  );
  // Ed25519 signing using the raw keypair
  const ed25519PrivateKey = Buffer.concat([rawPrivateKey, rawPublicKey]);
  const signatureBuffer = sign(null, nonceBytes, {
    key: Buffer.concat([
      // DER prefix for Ed25519 private key
      Buffer.from("302e020100300506032b657004220420", "hex"),
      rawPrivateKey,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const signatureHex = signatureBuffer.toString("hex");

  // 3. Verify and get key
  const result = await grpcClient.verifyAndIssueKey(
    keypair.address,
    challenge.challengeNonce,
    signatureHex,
    "@postfiatorg/pft-chatbot-mcp"
  );

  // 4. Cache the key locally
  cacheApiKey(result.apiKey);

  return result.apiKey;
}
