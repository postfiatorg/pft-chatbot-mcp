import type { Config } from "../config.js";

// Public IPFS gateways for fallback reads
const FALLBACK_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
];

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Strip the ipfs:// prefix from a URI and return the bare CID.
 */
function extractCid(uriOrCid: string): string {
  if (uriOrCid.startsWith("ipfs://")) {
    return uriOrCid.slice(7);
  }
  return uriOrCid;
}

/**
 * Build the list of gateway URLs to try, in priority order.
 */
function buildGatewayUrls(config: Config, cid: string): string[] {
  const urls: string[] = [];

  // Primary gateway from config
  if (config.ipfsGatewayUrl) {
    const base = config.ipfsGatewayUrl.replace(/\/$/, "");
    urls.push(`${base}/ipfs/${cid}`);
  }

  // Public fallbacks
  for (const gw of FALLBACK_GATEWAYS) {
    urls.push(`${gw}${cid}`);
  }

  return urls;
}

/**
 * Fetch with a timeout.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON content from IPFS by CID, trying multiple gateways.
 * This is the same pattern used by the pftasks frontend.
 */
export async function fetchIpfsJson(
  config: Config,
  cidOrUri: string
): Promise<any> {
  const cid = extractCid(cidOrUri);
  const urls = buildGatewayUrls(config, cid);
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        errors.push(`${url}: ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (err: any) {
      errors.push(`${url}: ${err.message}`);
      continue;
    }
  }

  throw new Error(
    `Failed to fetch CID ${cid} from all gateways:\n${errors.join("\n")}`
  );
}

/**
 * Fetch raw bytes from IPFS by CID, trying multiple gateways.
 */
export async function fetchIpfsBytes(
  config: Config,
  cidOrUri: string
): Promise<Buffer> {
  const cid = extractCid(cidOrUri);
  const urls = buildGatewayUrls(config, cid);
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        errors.push(`${url}: ${response.status}`);
        continue;
      }
      const arrayBuf = await response.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err: any) {
      errors.push(`${url}: ${err.message}`);
      continue;
    }
  }

  throw new Error(
    `Failed to fetch CID ${cid} from all gateways:\n${errors.join("\n")}`
  );
}
