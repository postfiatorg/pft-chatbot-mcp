#!/usr/bin/env npx tsx
/**
 * Publish the bot's X25519 messaging key on-chain via AccountSet.
 * Skips if the key is already set correctly.
 *
 * Usage: npx tsx scripts/set-message-key.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env manually
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
import { getAccountInfo } from "../src/chain/scanner.js";
import { publishMessageKey } from "../src/chain/submitter.js";

async function main() {
  console.log("=== Set MessageKey On-Chain ===\n");

  const config = loadConfig();
  const keypair = await deriveBotKeypair(config.botSeed);

  const rawKeyHex = Buffer.from(keypair.x25519PublicKey)
    .toString("hex")
    .toUpperCase();
  const messageKeyHex = `ED${rawKeyHex}`;

  console.log(`Bot address:  ${keypair.address}`);
  console.log(`MessageKey:   ${messageKeyHex}\n`);

  // Check current state
  console.log("Checking current account_info...");
  const info = await getAccountInfo(config.pftlRpcUrl, keypair.address);

  if (info.messageKey?.toUpperCase() === messageKeyHex.toUpperCase()) {
    console.log(`\n✓ MessageKey already set correctly on-chain. Nothing to do.`);
    return;
  }

  if (info.messageKey) {
    console.log(`  Current MessageKey: ${info.messageKey}`);
    console.log(`  Expected:           ${messageKeyHex}`);
    console.log("  → Updating to correct value...\n");
  } else {
    console.log("  MessageKey is not set. Publishing...\n");
  }

  // Submit AccountSet
  const result = await publishMessageKey(config, keypair.wallet, messageKeyHex);

  if (result.result === "tesSUCCESS") {
    console.log(`✓ MessageKey published successfully!`);
    console.log(`  tx_hash: ${result.txHash}`);
  } else {
    console.error(`✗ Transaction failed: ${result.result}`);
    console.error(`  tx_hash: ${result.txHash}`);
    process.exit(1);
  }

  // Verify
  console.log("\nVerifying...");
  const updated = await getAccountInfo(config.pftlRpcUrl, keypair.address);
  if (updated.messageKey?.toUpperCase() === messageKeyHex.toUpperCase()) {
    console.log(`✓ Confirmed: MessageKey is set on-chain.`);
  } else {
    console.log(`⚠ MessageKey not yet visible (may need a ledger close). Got: ${updated.messageKey || "(not set)"}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
