import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { rpcCall } from "../chain/submitter.js";
import { resolveIpfsUri } from "../dex/constants.js";

export const nftGetOwnedSchema = z.object({
  address: z
    .string()
    .optional()
    .describe(
      "PFTL wallet address to query. Defaults to the bot's own wallet."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(400)
    .default(100)
    .describe("Maximum number of NFTs to return (1–400)."),
  marker: z
    .string()
    .optional()
    .describe("Pagination marker from a previous response to fetch the next page."),
  resolve_metadata: z
    .boolean()
    .default(false)
    .describe(
      "If true, fetch IPFS metadata for each NFT (name, description, image). Slow for large collections — use sparingly."
    ),
});

export type NftGetOwnedParams = z.infer<typeof nftGetOwnedSchema>;

async function fetchMetadata(uri: string): Promise<any> {
  try {
    const url = resolveIpfsUri(uri);
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Get NFTs owned by a wallet on the Post Fiat testnet.
 * Supports pagination via the marker field.
 * Set resolve_metadata=true to fetch IPFS name/description/image for each NFT.
 */
export async function executeNftGetOwned(
  config: Config,
  keypair: BotKeypair,
  params: NftGetOwnedParams
): Promise<string> {
  const address = params.address ?? keypair.address;

  const reqParams: any = {
    account:      address,
    ledger_index: "validated",
    limit:        params.limit,
  };
  if (params.marker) reqParams.marker = params.marker;

  const resp = await rpcCall(config.pftlRpcUrl, "account_nfts", reqParams);
  const nfts: any[] = resp.account_nfts ?? [];

  const items = await Promise.all(
    nfts.map(async (nft: any) => {
      const uri = nft.URI
        ? Buffer.from(nft.URI, "hex").toString("utf8")
        : null;

      const entry: any = {
        nft_id:   nft.NFTokenID,
        issuer:   nft.Issuer,
        taxon:    nft.NFTokenTaxon,
        sequence: nft.nft_serial,
        flags:    nft.Flags,
        uri,
      };

      if (params.resolve_metadata && uri) {
        const meta = await fetchMetadata(uri);
        if (meta) {
          entry.name        = meta.name        ?? null;
          entry.description = meta.description ?? null;
          entry.image       = meta.image        ? resolveIpfsUri(meta.image) : null;
          entry.collection  = meta.collection   ?? null;
        }
      }

      return entry;
    })
  );

  return JSON.stringify(
    {
      address,
      nfts:   items,
      count:  items.length,
      marker: resp.marker ?? null,
    },
    null,
    2
  );
}
