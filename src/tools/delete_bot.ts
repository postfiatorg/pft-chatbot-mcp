import { z } from "zod";
import type { Config } from "../config.js";
import type { KeystoneClient } from "../grpc/client.js";

export const deleteBotSchema = z.object({
  agent_id: z.string().describe("The agent ID of the bot to delete"),
});

export type DeleteBotParams = z.infer<typeof deleteBotSchema>;

export async function executeDeleteBot(
  config: Config,
  grpcClient: KeystoneClient,
  params: DeleteBotParams
): Promise<string> {
  // Server returns google.protobuf.Empty on success; throws on failure.
  await grpcClient.deleteAgentCard(params.agent_id);

  return JSON.stringify(
    {
      agent_id: params.agent_id,
      deleted: true,
    },
    null,
    2
  );
}
