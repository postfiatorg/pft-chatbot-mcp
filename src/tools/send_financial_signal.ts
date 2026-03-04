import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import type { KeystoneClient } from "../grpc/client.js";
import { SIGNAL_KINDS, encodeFinancialSignal } from "../signals/codec.js";
import { executeSendMessage } from "./send_message.js";

export const sendFinancialSignalSchema = z.object({
  recipient: z
    .string()
    .describe("PFTL wallet address of the recipient agent (r-address)"),

  signal_kind: z
    .enum(SIGNAL_KINDS)
    .describe(
      "Type of financial signal to send. One of:\n" +
        "  price_quote        — live bid/ask/mid quote for an asset pair\n" +
        "  trade_intent       — declared intent to buy or sell before submission\n" +
        "  trade_confirmation — settlement result after an on-chain trade\n" +
        "  position_update    — snapshot of the agent's full portfolio\n" +
        "  risk_metric        — computed risk indicators (VaR, drawdown, Sharpe)\n" +
        "  reward_offer       — PFT reward proposal (free-form JSON payload)\n" +
        "  policy_update      — policy change notice (free-form JSON payload)"
    ),

  signal_data: z
    .string()
    .describe(
      "JSON string containing the signal-specific fields. Required fields by kind:\n\n" +
        "price_quote: { pair: { base_asset, quote_asset, base_issuer?, quote_issuer? }, " +
        "bid_price, ask_price, mid_price, volume_24h?, change_pct_24h?, " +
        "quoted_at (ISO), valid_until (ISO), source_agent_id?, confidence_bps? }\n\n" +
        "trade_intent: { side (BUY|SELL), order_type (MARKET|LIMIT|STOP), " +
        "base_asset, quote_asset, quantity, limit_price?, stop_price?, " +
        "max_slippage_bps?, expires_at (ISO) }\n\n" +
        "trade_confirmation: { intent_id, status (FILLED|PARTIAL|CANCELLED|FAILED), " +
        "filled_quantity, filled_price, tx_hash, ledger_index, " +
        "confirmed_at (ISO), fee_drops?, failure_reason? }\n\n" +
        "position_update: { positions: [{ asset, issuer?, balance, value_in_pft?, " +
        "unrealized_pnl_pft?, as_of (ISO) }], total_value_pft?, snapshot_at (ISO) }\n\n" +
        "risk_metric: { overall_level (LOW|MEDIUM|HIGH|CRITICAL), var_95_pft?, " +
        "max_drawdown_pct?, sharpe_ratio?, liquidity_ratio?, concentration_ratio?, " +
        "window_seconds?, computed_at (ISO), custom_metrics? }\n\n" +
        "reward_offer / policy_update: any JSON object"
    ),

  correlation_id: z
    .string()
    .optional()
    .describe(
      "Optional correlation ID linking related signals (e.g. the signal_id of a " +
        "price_quote that triggered this trade_intent)"
    ),

  expires_at: z
    .string()
    .optional()
    .describe(
      "ISO 8601 datetime after which this signal should be ignored by the recipient"
    ),

  amount_pft: z
    .string()
    .optional()
    .describe(
      "PFT to attach to the on-chain payment (e.g. \"1\" = 1 PFT). Default: 1 drop."
    ),

  amount_drops: z
    .string()
    .optional()
    .describe("PFT in drops (ignored if amount_pft is set)"),

  thread_id: z
    .string()
    .optional()
    .describe("Thread ID for grouping a sequence of related signals"),

  reply_to_tx: z
    .string()
    .optional()
    .describe("Transaction hash this signal is replying to"),

  share_with_tasknode: z
    .boolean()
    .optional()
    .describe(
      "Include the TaskNode as a decryption recipient (default: true). " +
        "Set false for fully private agent-to-agent signals."
    ),
});

export type SendFinancialSignalParams = z.infer<
  typeof sendFinancialSignalSchema
>;

export async function executeSendFinancialSignal(
  config: Config,
  keypair: BotKeypair,
  grpcClient: KeystoneClient,
  params: SendFinancialSignalParams
): Promise<string> {
  // 1. Parse signal_data JSON
  let signalData: Record<string, unknown>;
  try {
    signalData = JSON.parse(params.signal_data);
  } catch {
    return JSON.stringify(
      { error: "signal_data must be a valid JSON string" },
      null,
      2
    );
  }

  // 2. Encode to AgentFinancialSignal protobuf bytes
  let signalBytes: Buffer;
  try {
    signalBytes = await encodeFinancialSignal(
      params.signal_kind,
      signalData,
      keypair.address,
      {
        recipientAgentId: params.recipient,
        correlationId: params.correlation_id,
        expiresAt: params.expires_at,
      }
    );
  } catch (err: any) {
    return JSON.stringify(
      { error: `Signal encoding failed: ${err.message}` },
      null,
      2
    );
  }

  // 3. Send via existing encrypted message infrastructure.
  //    The protobuf bytes are base64-encoded into the `message` field;
  //    content_type flags this as a machine-readable signal, not human text.
  return executeSendMessage(config, keypair, grpcClient, {
    recipient: params.recipient,
    message: signalBytes.toString("base64"),
    content_type: "application/x-pft-signal+proto",
    amount_pft: params.amount_pft,
    amount_drops: params.amount_drops,
    thread_id: params.thread_id,
    reply_to_tx: params.reply_to_tx,
    share_with_tasknode: params.share_with_tasknode,
  });
}
