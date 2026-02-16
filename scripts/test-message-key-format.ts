#!/usr/bin/env npx tsx
/**
 * Test: messaging key format (ED prefix, stripping, case handling).
 * Pure local test -- no network needed, no .env needed.
 *
 * Usage: npx tsx scripts/test-message-key-format.ts
 */

import { createHash } from "node:crypto";
import sodium from "../src/crypto/sodium.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function main() {
  await sodium.ready;
  console.log("=== Messaging Key Format Tests ===\n");

  // Simulate key derivation (same as deriveBotKeypair but without a real seed)
  const fakeSeed = "sEdTestSeedForUnitTestingOnly1234";
  const seedBytes = createHash("sha256").update(fakeSeed).digest();
  const keypair = sodium.crypto_box_seed_keypair(seedBytes);
  const x25519PubKey = keypair.publicKey; // 32 bytes

  // --- Test 1: Key length ---
  console.log("1. X25519 key derivation");
  assert(x25519PubKey.length === 32, "X25519 public key is 32 bytes");

  // --- Test 2: ED-prefixed format (what register_bot now publishes) ---
  console.log("\n2. ED-prefixed format for on-chain MessageKey");
  const rawKeyHex = Buffer.from(x25519PubKey).toString("hex").toUpperCase();
  const messageKeyHex = `ED${rawKeyHex}`;

  assert(rawKeyHex.length === 64, "Raw key hex is 64 chars");
  assert(messageKeyHex.length === 66, "ED-prefixed key is 66 chars");
  assert(messageKeyHex.startsWith("ED"), "Key starts with ED prefix");

  // --- Test 3: Stripping ED prefix (what resolveRecipientKey does) ---
  console.log("\n3. Stripping ED prefix when reading from chain");

  // Simulate what XRPL returns (uppercase)
  const onChainKey = messageKeyHex.toUpperCase();
  let keyHex = onChainKey;
  if (keyHex.length === 66 && keyHex.toUpperCase().startsWith("ED")) {
    keyHex = keyHex.slice(2);
  }
  const recoveredKey = Buffer.from(keyHex, "hex");

  assert(recoveredKey.length === 32, "Stripped key is 32 bytes");
  assert(
    Buffer.from(x25519PubKey).equals(recoveredKey),
    "Stripped key matches original X25519 public key"
  );

  // --- Test 4: Case-insensitive comparison (idempotency check) ---
  console.log("\n4. Case-insensitive idempotency comparison");

  const lowerPrefixed = `ed${rawKeyHex.toLowerCase()}`;
  const upperPrefixed = `ED${rawKeyHex.toUpperCase()}`;
  assert(
    lowerPrefixed.toUpperCase() === upperPrefixed.toUpperCase(),
    "Case-insensitive match works for mixed-case keys"
  );

  // --- Test 5: No-op when key has no ED prefix (raw 64-char fallback) ---
  console.log("\n5. Fallback: raw 64-char key without ED prefix");

  let rawOnChain = rawKeyHex; // 64 chars, no ED prefix
  if (rawOnChain.length === 66 && rawOnChain.toUpperCase().startsWith("ED")) {
    rawOnChain = rawOnChain.slice(2);
  }
  const rawRecovered = Buffer.from(rawOnChain, "hex");
  assert(rawRecovered.length === 32, "Raw 64-char key still yields 32 bytes");
  assert(
    Buffer.from(x25519PubKey).equals(rawRecovered),
    "Raw key matches original (no false stripping)"
  );

  // --- Test 6: Ensure ED in the key body doesn't get falsely stripped ---
  console.log("\n6. ED in key body is not falsely stripped");

  // A 64-char key that happens to start with ED should NOT be stripped
  // (it's only 64 chars, not 66)
  const trickyKey = "ED" + "A".repeat(62); // 64 chars total
  let trickyHex = trickyKey;
  if (trickyHex.length === 66 && trickyHex.toUpperCase().startsWith("ED")) {
    trickyHex = trickyHex.slice(2);
  }
  assert(
    trickyHex === trickyKey,
    "64-char key starting with ED is NOT stripped (length guard works)"
  );

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
