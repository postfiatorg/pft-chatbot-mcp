import { z } from "zod";
import { sign } from "node:crypto";
import type { Config } from "../config.js";
import { cacheApiKey } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";

export const registerBotSchema = z.object({
  name: z.string().describe("Display name for the bot"),
  description: z.string().describe("Short description of what the bot does"),
  capabilities: z
    .array(z.string())
    .describe(
      'Semantic capability URIs (e.g., ["text-summarization", "image-generation"])'
    ),
  url: z.string().optional().describe("Bot homepage or documentation URL"),
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

  const result = await grpcClient.storeAgentCard(
    {
      name: params.name,
      description: params.description,
      url: params.url,
    },
    {
      publicEncryptionKey: Buffer.from(keypair.x25519PublicKey),
      supportedSemanticCapabilities: capabilities,
    }
  );

  return JSON.stringify(
    {
      agent_id: result.agentId,
      wallet_address: keypair.address,
      name: params.name,
      capabilities,
      registered: true,
    },
    null,
    2
  );
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
    "pft-chatbot-mcp"
  );

  // 4. Cache the key locally
  cacheApiKey(result.apiKey);

  return result.apiKey;
}
