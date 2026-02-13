#!/usr/bin/env npx tsx
/**
 * Test: check_balance tool
 * Usage: npx tsx scripts/test-check-balance.ts
 *
 * Loads BOT_SEED from .env and queries the wallet's native PFT balance
 * and trust line balances via JSON-RPC.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env manually (no dotenv dependency)
const envPath = resolve(process.cwd(), ".env");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed.slice(eqIdx + 1).trim();
  if (!process.env[key]) {
    process.env[key] = val;
  }
}

import { loadConfig } from "../src/config.js";
import { deriveBotKeypair } from "../src/crypto/keys.js";
import { executeCheckBalance } from "../src/tools/check_balance.js";

async function main() {
  console.log("=== check_balance test ===\n");

  const config = loadConfig();
  const keypair = await deriveBotKeypair(config.botSeed);
  console.log(`Wallet: ${keypair.address}`);
  console.log(`RPC:    ${config.pftlRpcUrl}\n`);

  const result = await executeCheckBalance(config, keypair);
  console.log(result);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
