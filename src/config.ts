import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  /** Bot wallet seed (mnemonic or hex). REQUIRED. */
  botSeed: string;
  /** PFTL chain JSON-RPC endpoint */
  pftlRpcUrl: string;
  /** PFTL chain WebSocket endpoint */
  pftlWssUrl: string;
  /** Primary IPFS gateway for reads (falls back to public gateways) */
  ipfsGatewayUrl: string;
  /** Keystone gRPC service URL */
  keystoneGrpcUrl: string;
  /** Keystone API key (auto-provisioned on first register_bot call) */
  keystoneApiKey: string | null;
}

const API_KEY_CACHE_FILE = ".keystone-api-key";

function loadCachedApiKey(): string | null {
  const keyPath = resolve(process.cwd(), API_KEY_CACHE_FILE);
  if (existsSync(keyPath)) {
    try {
      return readFileSync(keyPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function cacheApiKey(apiKey: string): void {
  const keyPath = resolve(process.cwd(), API_KEY_CACHE_FILE);
  writeFileSync(keyPath, apiKey, { mode: 0o600 });
}

/**
 * Load the bot seed from environment or file.
 *
 * Priority: BOT_SEED env var > BOT_SEED_FILE env var (path to file containing seed)
 *
 * Using BOT_SEED_FILE is recommended for production as it avoids having
 * the seed in environment variable listings or shell history.
 */
function loadBotSeed(): string {
  if (process.env.BOT_SEED) {
    return process.env.BOT_SEED;
  }

  if (process.env.BOT_SEED_FILE) {
    const seedPath = resolve(process.cwd(), process.env.BOT_SEED_FILE);
    if (!existsSync(seedPath)) {
      throw new Error(`BOT_SEED_FILE points to ${seedPath} but the file does not exist.`);
    }
    const seed = readFileSync(seedPath, "utf-8").trim();
    if (!seed) {
      throw new Error(`BOT_SEED_FILE at ${seedPath} is empty.`);
    }
    return seed;
  }

  throw new Error(
    "BOT_SEED or BOT_SEED_FILE environment variable is required.\n" +
      "  BOT_SEED: set directly to your PFTL wallet mnemonic or hex seed\n" +
      "  BOT_SEED_FILE: path to a file containing the seed (more secure)\n" +
      "See .env.example for details."
  );
}

export function loadConfig(): Config {
  const botSeed = loadBotSeed();

  const keystoneApiKey =
    process.env.KEYSTONE_API_KEY || loadCachedApiKey() || null;

  return {
    botSeed,
    pftlRpcUrl:
      process.env.PFTL_RPC_URL || "https://rpc.testnet.postfiat.org",
    pftlWssUrl:
      process.env.PFTL_WSS_URL || "wss://rpc.testnet.postfiat.org:6008",
    ipfsGatewayUrl:
      process.env.IPFS_GATEWAY_URL ||
      "https://pft-ipfs-testnet-node-1.fly.dev",
    keystoneGrpcUrl:
      process.env.KEYSTONE_GRPC_URL || "keystone-grpc.postfiat.org:443",
    keystoneApiKey,
  };
}
