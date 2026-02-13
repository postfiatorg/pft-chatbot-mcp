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

  const commands = (result.agentCard?.supportedCommands || []).map((cmd) => ({
    command: cmd.command,
    example: cmd.example,
    description: cmd.description,
  }));

  return JSON.stringify(
    {
      agent_id: result.agentId,
      name: result.agentCard?.name || "",
      description: result.agentCard?.description || "",
      url: result.agentCard?.url || "",
      version: result.agentCard?.version || "",
      organization: result.agentCard?.organization || "",
      capabilities:
        result.keystoneCapabilities?.supportedSemanticCapabilities || [],
      supported_commands: commands,
    },
    null,
    2
  );
}
