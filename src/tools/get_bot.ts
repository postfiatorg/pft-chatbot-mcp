import { z } from "zod";
import type { Config } from "../config.js";
import type { KeystoneClient } from "../grpc/client.js";

export const getBotSchema = z.object({
  agent_id: z.string().describe("The agent ID of the bot to retrieve"),
});

export type GetBotParams = z.infer<typeof getBotSchema>;

export async function executeGetBot(
  config: Config,
  grpcClient: KeystoneClient,
  params: GetBotParams
): Promise<string> {
  const result = await grpcClient.getAgentCard(params.agent_id);

  // supported_commands is a top-level response field, NOT inside agentCard
  const commands = (result.supportedCommands || []).map((cmd) => ({
    command: cmd.command,
    example: cmd.example,
    description: cmd.description,
  }));

  return JSON.stringify(
    {
      agent_id: params.agent_id,
      name: result.agentCard?.name || "",
      description: result.agentCard?.description || "",
      url: result.agentCard?.url || "",
      version: result.agentCard?.version || "",
      organization: result.agentCard?.provider?.organization || "",
      supported_commands: commands,
    },
    null,
    2
  );
}
