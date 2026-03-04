/**
 * PFTL chain constants and helpers.
 * Generic — no references to specific tokens, DEX frontends, or NFT collections.
 */

import { z } from "zod";

// ─── Native asset ─────────────────────────────────────────────────────────────

/** PFTL native asset descriptor (analogous to XRP on XRPL mainnet). */
export const PFT_ASSET = { currency: "XRP" } as const;

/** Convert a human-readable PFT string to a drops string. */
export function pftToDrops(pft: string): string {
  const n = parseFloat(pft);
  if (isNaN(n) || n <= 0) throw new Error(`Invalid PFT amount: "${pft}"`);
  return Math.round(n * 1_000_000).toString();
}

/** Convert a drops string to a human-readable PFT string. */
export function dropsToPft(drops: string): string {
  return (parseInt(drops, 10) / 1_000_000).toFixed(6);
}

// ─── Generic asset types ─────────────────────────────────────────────────────

export interface IssuedAsset {
  currency: string;
  issuer:   string;
}

/** Either "PFT" (native asset) or an issued token {currency, issuer}. */
export type PftlAsset = "PFT" | IssuedAsset;

/** Zod schema for an issued token — used in tool parameter definitions. */
export const issuedAssetSchema = z.object({
  currency: z.string().describe("3-character or 40-character hex currency code."),
  issuer:   z.string().describe("Issuer r-address for this token."),
});

/**
 * Zod schema for any PFTL asset.
 * Use "PFT" for the native asset, or {currency, issuer} for any issued token.
 */
export const pftlAssetSchema = z.union([
  z.literal("PFT"),
  issuedAssetSchema,
]).describe(
  'Asset identifier: "PFT" for the native asset, or {currency, issuer} for any issued token.'
);

// ─── Amount builders ──────────────────────────────────────────────────────────

/**
 * Build the XRPL wire-format amount from an asset + human amount string.
 * - PFT: accepts whole units ("10") or explicit drops ("10000000 drops")
 * - Issued: returns an IOU object {currency, issuer, value}
 */
export function buildXrplAmount(
  asset: PftlAsset,
  amount: string
): string | { currency: string; issuer: string; value: string } {
  if (asset === "PFT") {
    const trimmed = amount.trim();
    if (trimmed.toLowerCase().endsWith("drops")) {
      const drops = trimmed.replace(/\s*drops$/i, "").trim();
      const n = parseInt(drops, 10);
      if (isNaN(n) || n <= 0) throw new Error(`Invalid drops value: "${amount}"`);
      return drops;
    }
    return pftToDrops(trimmed);
  }
  return { currency: asset.currency, issuer: asset.issuer, value: amount.trim() };
}

/**
 * Build an XRPL asset descriptor (no amount) from a PftlAsset.
 * Used in AMM and order-book RPC calls.
 */
export function buildXrplAsset(
  asset: PftlAsset
): { currency: string } | { currency: string; issuer: string } {
  if (asset === "PFT") return PFT_ASSET;
  return { currency: asset.currency, issuer: asset.issuer };
}

/** Format an XRPL wire amount into a human-readable object for tool output. */
export function formatXrplAmount(xrplAmount: any): {
  currency: string;
  issuer?:  string;
  amount:   string;
  drops?:   string;
} {
  if (typeof xrplAmount === "string") {
    return { currency: "PFT", amount: dropsToPft(xrplAmount), drops: xrplAmount };
  }
  return {
    currency: xrplAmount.currency,
    issuer:   xrplAmount.issuer,
    amount:   xrplAmount.value,
  };
}

// ─── IPFS (PFTL chain infrastructure) ────────────────────────────────────────

export const IPFS_GATEWAYS = [
  "https://pft-ipfs-testnet-node-1.fly.dev/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
] as const;

/** Resolve an IPFS URI to an HTTP URL using the chain's primary gateway. */
export function resolveIpfsUri(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    return `${IPFS_GATEWAYS[0]}${uri.slice(7)}`;
  }
  return uri;
}

// ─── Transaction flags ────────────────────────────────────────────────────────

export const OFFER_FLAGS = {
  ImmediateOrCancel: 0x00020000,
  FillOrKill:        0x00040000,
  Sell:              0x00080000,
} as const;

export const AMM_DEPOSIT_FLAGS = {
  TwoAssetDeposit:    0x00100000,
  SingleAssetDeposit: 0x00080000,
} as const;

export const AMM_WITHDRAW_FLAGS = {
  LPTokenWithdraw:     0x00010000,
  TwoAssetWithdraw:    0x00020000,
  SingleAssetWithdraw: 0x00080000,
} as const;

export const NFT_OFFER_FLAGS = {
  SellOffer: 1,
} as const;
