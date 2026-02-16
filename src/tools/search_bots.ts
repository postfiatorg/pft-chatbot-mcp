import { z } from "zod";
import type { Config } from "../config.js";
import type { KeystoneClient } from "../grpc/client.js";

export const searchBotsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Free text search query (matches bot name/description)"),
  capabilities: z
    .array(z.string())
    .optional()
    .describe("Filter by capability URIs"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of results (default: 20)"),
});

export type SearchBotsParams = z.infer<typeof searchBotsSchema>;

export async function executeSearchBots(
  config: Config,
  grpcClient: KeystoneClient,
  params: SearchBotsParams
): Promise<string> {
  // Normalize capability URIs
  const capabilities = params.capabilities?.map((cap) =>
    cap.startsWith("http")
      ? cap
      : `https://schemas.postfiat.org/capabilities/${cap}/v1`
  );

  const result = await grpcClient.searchAgents(
    params.query,
    capabilities,
    params.limit || 20
  );

  if (!result.results || result.results.length === 0) {
    return "No bots found matching the search criteria.";
  }

  const bots = result.results.map((r) => ({
    agent_id: r.agentId,
    name: r.agentCard?.name || "",
    description: r.agentCard?.description || "",
    wallet_address: "",
    capabilities:
      r.keystoneCapabilities?.supportedSemanticCapabilities || [],
    supported_commands: (r.supportedCommands || []).map((cmd) => ({
      command: cmd.command,
      example: cmd.example,
      description: cmd.description,
      min_cost_drops: cmd.minCostDrops || "0",
    })),
    relevance_score: r.relevanceScore,
    icon_emoji: r.iconEmoji || "",
    icon_color_hex: r.iconColorHex || "",
    min_cost_first_message_drops: r.minCostFirstMessageDrops || "0",
  }));

  return JSON.stringify(
    {
      total_count: result.totalCount,
      results: bots,
    },
    null,
    2
  );
}
