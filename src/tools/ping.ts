import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";
import { timestampToIso } from "../liveness/ping.js";

export async function executePing(
  keypair: BotKeypair,
  grpcClient: KeystoneClient
): Promise<string> {
  const result = await grpcClient.pingAgent();

  return JSON.stringify(
    {
      agent_id: keypair.address,
      last_ping_at: timestampToIso(result.lastPingAt),
      status: "active",
    },
    null,
    2
  );
}
