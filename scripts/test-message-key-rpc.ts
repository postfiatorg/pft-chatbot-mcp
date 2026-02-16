#!/usr/bin/env npx tsx
/**
 * Test: check what account_info returns for MessageKey from the live RPC.
 * Usage: npx tsx scripts/test-message-key-rpc.ts
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

async function main() {
  console.log("=== MessageKey RPC Check ===\n");

  const config = loadConfig();
  const keypair = await deriveBotKeypair(config.botSeed);

  console.log(`Bot address: ${keypair.address}`);
  console.log(`RPC URL:     ${config.pftlRpcUrl}\n`);

  // What we would publish
  const rawKeyHex = Buffer.from(keypair.x25519PublicKey)
    .toString("hex")
    .toUpperCase();
  const expectedOnChain = `ED${rawKeyHex}`;
  console.log(`Expected MessageKey: ${expectedOnChain}`);
  console.log(`  (ED prefix + ${rawKeyHex.length}-char X25519 hex = ${expectedOnChain.length} chars)\n`);

  // Call account_info
  const resp = await fetch(config.pftlRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: keypair.address }],
    }),
  });

  const json = (await resp.json()) as any;

  if (json.result?.error) {
    console.log(`RPC error: ${json.result.error_message || json.result.error}`);
    if (json.result.error === "actNotFound") {
      console.log("  → Account not found on ledger (not funded yet).");
    }
    return;
  }

  const data = json.result?.account_data;
  console.log("--- account_data fields ---");
  console.log(`  Account:       ${data?.Account}`);
  console.log(`  Balance:       ${data?.Balance}`);
  console.log(`  SigningPubKey:  ${data?.SigningPubKey || "(empty)"}`);
  console.log(`  RegularKey:    ${data?.RegularKey || "(not set)"}`);
  console.log(`  MessageKey:    ${data?.MessageKey || "(not set)"}`);
  console.log();

  if (!data?.MessageKey) {
    console.log("⚠ MessageKey is NOT set on-chain.");
    console.log("  → After running register_bot, it should be set to:");
    console.log(`    ${expectedOnChain}`);
  } else {
    console.log(`MessageKey on-chain: ${data.MessageKey}`);
    console.log(`  Length: ${data.MessageKey.length} chars`);
    console.log(`  Starts with ED: ${data.MessageKey.toUpperCase().startsWith("ED")}`);

    const match =
      data.MessageKey.toUpperCase() === expectedOnChain.toUpperCase();
    console.log(`  Matches expected: ${match ? "✓ YES" : "✗ NO"}`);

    if (!match) {
      console.log(`\n  Expected: ${expectedOnChain}`);
      console.log(`  Got:      ${data.MessageKey}`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
