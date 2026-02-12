#!/usr/bin/env npx tsx
/**
 * Integration test: verifies gRPC connectivity and basic tool execution.
 * Usage: npx tsx test-integration.ts
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
import { KeystoneClient } from "../src/grpc/client.js";
import { MCP_VERSION, KEYSTONE_PROTOCOL_VERSION } from "../src/version.js";

function log(label: string, data: any) {
  console.log(`\n=== ${label} ===`);
  if (typeof data === "string") console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function pass(test: string) {
  console.log(`  ✓ ${test}`);
}

function fail(test: string, err: any) {
  console.error(`  ✗ ${test}: ${err.message || err}`);
}

async function main() {
  log("pft-chatbot-mcp Integration Test", `v${MCP_VERSION} (keystone ${KEYSTONE_PROTOCOL_VERSION})`);

  // 1. Load config
  let config;
  try {
    config = loadConfig();
    pass("Config loaded");
    log("Config", {
      pftlRpcUrl: config.pftlRpcUrl,
      pftlWssUrl: config.pftlWssUrl,
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      keystoneGrpcUrl: config.keystoneGrpcUrl,
      hasApiKey: !!config.keystoneApiKey,
    });
  } catch (err: any) {
    fail("Config load", err);
    process.exit(1);
  }

  // 2. Derive keypair
  let keypair;
  try {
    keypair = await deriveBotKeypair(config.botSeed);
    pass(`Keypair derived: ${keypair.address}`);
  } catch (err: any) {
    fail("Keypair derivation", err);
    process.exit(1);
  }

  // 3. Test PFTL RPC connectivity
  try {
    const resp = await fetch(config.pftlRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "server_info", params: [{}] }),
    });
    const json = (await resp.json()) as any;
    const ledger = json.result?.info?.validated_ledger?.seq;
    pass(`PFTL RPC connected (validated ledger: ${ledger})`);
  } catch (err: any) {
    fail("PFTL RPC", err);
  }

  // 4. Test IPFS gateway connectivity
  try {
    const resp = await fetch(`${config.ipfsGatewayUrl}/api/v0/version`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const json = (await resp.json()) as any;
      pass(`IPFS gateway connected (version: ${json.Version || "ok"})`);
    } else {
      // Try a simple GET as fallback
      const resp2 = await fetch(`${config.ipfsGatewayUrl}/version`, {
        signal: AbortSignal.timeout(5000),
      });
      pass(`IPFS gateway reachable (status: ${resp2.status})`);
    }
  } catch (err: any) {
    fail("IPFS gateway", err);
  }

  // 5. Test gRPC connectivity
  const grpcClient = new KeystoneClient(config);
  try {
    // Try requesting an API key challenge (unauthenticated call)
    const challenge = await grpcClient.requestApiKey(keypair.address);
    pass(`gRPC connected — got auth challenge (nonce: ${challenge.challengeNonce.slice(0, 16)}...)`);
    log("Auth Challenge", {
      noncePrefix: challenge.challengeNonce.slice(0, 32) + "...",
      expiresAtUnix: challenge.expiresAtUnix,
    });
  } catch (err: any) {
    fail("gRPC connection", err);
    console.error("  Details:", err.details || err.message);
    console.error("  Code:", err.code);
  }

  // 6. Test scan_messages (chain read, no gRPC needed)
  try {
    const { executeScanMessages } = await import("../src/tools/scan_messages.js");
    const result = await executeScanMessages(config, keypair, { limit: 5, direction: "both" });
    const parsed = JSON.parse(result);
    pass(`scan_messages: found ${parsed.count} message(s)`);
    if (parsed.count > 0) {
      log("Latest message", parsed.messages[0]);
    }
  } catch (err: any) {
    fail("scan_messages", err);
  }

  // Done
  log("Test Complete", "All connectivity checks finished.");
  grpcClient.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
