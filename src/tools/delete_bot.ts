import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";

export async function executeDeleteBot(
  config: Config,
  keypair: BotKeypair,
  grpcClient: KeystoneClient
): Promise<string> {
  const agentId = keypair.address;
  await grpcClient.deleteAgentCard(agentId);

  return JSON.stringify(
    {
      agent_id: agentId,
      deleted: true,
    },
    null,
    2
  );
}
