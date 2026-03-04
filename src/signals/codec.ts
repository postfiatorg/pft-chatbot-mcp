/**
 * codec.ts — protobuf serialize/deserialize for pf.signals.v1 messages.
 *
 * Uses protobufjs dynamic loading (same dep already in package.json).
 * All four signal proto files are loaded into a single shared Root so
 * cross-file type references resolve without duplication.
 */

import * as protobuf from "protobufjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, "../grpc/protos");

// ── Root loader ──────────────────────────────────────────────────────────────

let _root: protobuf.Root | null = null;

async function getRoot(): Promise<protobuf.Root> {
  if (_root) return _root;

  const root = new protobuf.Root();

  // Resolve imports: google well-known types stay as-is (protobufjs bundles them);
  // everything else is resolved relative to PROTO_DIR.
  root.resolvePath = (_origin: string, target: string): string => {
    if (target.startsWith("google/")) return target;
    return resolve(PROTO_DIR, target);
  };

  await root.load([
    resolve(PROTO_DIR, "pf/signals/v1/signal.proto"),
    resolve(PROTO_DIR, "pf/signals/v1/market.proto"),
    resolve(PROTO_DIR, "pf/signals/v1/trade.proto"),
    resolve(PROTO_DIR, "pf/signals/v1/portfolio.proto"),
  ]);

  // Early validation: confirm critical types resolved correctly.
  // Catches proto load failures at startup rather than at encode/decode time.
  root.lookupType("pf.signals.v1.AgentFinancialSignal");
  root.lookupType("pf.signals.v1.PriceQuote");
  root.lookupType("pf.signals.v1.TradeIntent");
  root.lookupType("pf.signals.v1.TradeConfirmation");
  root.lookupType("pf.signals.v1.PositionUpdate");
  root.lookupType("pf.signals.v1.RiskMetric");
  root.lookupEnum("pf.common.v4.ContentKind");

  _root = root;
  return root;
}

// ── Kind maps ────────────────────────────────────────────────────────────────

export const SIGNAL_KINDS = [
  "price_quote",
  "trade_intent",
  "trade_confirmation",
  "position_update",
  "risk_metric",
  "reward_offer",
  "policy_update",
] as const;

export type SignalKindKey = (typeof SIGNAL_KINDS)[number];

// Maps user-facing kind string → proto enum name and payload type
const KIND_META: Record<
  SignalKindKey,
  { enumName: string; contentKind: string; typeName: string | null }
> = {
  price_quote:       { enumName: "SIGNAL_KIND_PRICE_QUOTE",       contentKind: "PRICE_QUOTE",       typeName: "pf.signals.v1.PriceQuote" },
  trade_intent:      { enumName: "SIGNAL_KIND_TRADE_INTENT",      contentKind: "TRADE_INTENT",      typeName: "pf.signals.v1.TradeIntent" },
  trade_confirmation:{ enumName: "SIGNAL_KIND_TRADE_CONFIRMATION", contentKind: "TRADE_CONFIRMATION",typeName: "pf.signals.v1.TradeConfirmation" },
  position_update:   { enumName: "SIGNAL_KIND_POSITION_UPDATE",   contentKind: "POSITION_UPDATE",   typeName: "pf.signals.v1.PositionUpdate" },
  risk_metric:       { enumName: "SIGNAL_KIND_RISK_METRIC",       contentKind: "RISK_METRIC",       typeName: "pf.signals.v1.RiskMetric" },
  reward_offer:      { enumName: "SIGNAL_KIND_REWARD_OFFER",      contentKind: "REWARD_OFFER",      typeName: null },
  policy_update:     { enumName: "SIGNAL_KIND_POLICY_UPDATE",     contentKind: "POLICY_UPDATE",     typeName: null },
};

// Reverse map: proto SignalKind enum value → SignalKindKey
// (protobufjs decodes enums as their string name by default)
const ENUM_NAME_TO_KIND: Record<string, SignalKindKey> = {
  SIGNAL_KIND_PRICE_QUOTE:       "price_quote",
  SIGNAL_KIND_TRADE_INTENT:      "trade_intent",
  SIGNAL_KIND_TRADE_CONFIRMATION:"trade_confirmation",
  SIGNAL_KIND_POSITION_UPDATE:   "position_update",
  SIGNAL_KIND_RISK_METRIC:       "risk_metric",
  SIGNAL_KIND_REWARD_OFFER:      "reward_offer",
  SIGNAL_KIND_POLICY_UPDATE:     "policy_update",
};

// ── Timestamp helpers ─────────────────────────────────────────────────────────

function toTimestamp(
  value: string | number | undefined | null
): { seconds: number; nanos: number } | undefined {
  if (value == null) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value as string);
  if (isNaN(ms)) return undefined;
  const nanos = ((ms % 1000) + 1000) % 1000 * 1_000_000; // guard against negative remainder
  return { seconds: Math.floor(ms / 1000), nanos };
}

function fromTimestamp(
  ts: { seconds: string | number; nanos?: number } | null | undefined
): string | null {
  if (!ts) return null;
  const secs =
    typeof ts.seconds === "string"
      ? parseInt(ts.seconds, 10)
      : (ts.seconds as number);
  if (isNaN(secs)) return null;
  return new Date(secs * 1000).toISOString();
}

function isTimestampShape(
  val: unknown
): val is { seconds: string | number; nanos?: number } {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const keys = Object.keys(val as object);
  return keys.includes("seconds") && keys.length <= 2;
}

/** Recursively convert any Timestamp-shaped objects to ISO strings. */
function timestampsToIso(obj: unknown): unknown {
  if (isTimestampShape(obj)) return fromTimestamp(obj);
  if (Array.isArray(obj)) return obj.map(timestampsToIso);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = timestampsToIso(v);
    }
    return out;
  }
  return obj;
}

// ── Payload timestamp field normalization (ISO string → Timestamp object) ────

const TIMESTAMP_FIELDS: Record<SignalKindKey, string[]> = {
  price_quote:        ["quoted_at", "valid_until"],
  trade_intent:       ["expires_at"],
  trade_confirmation: ["confirmed_at"],
  position_update:    ["snapshot_at"],
  risk_metric:        ["computed_at"],
  reward_offer:       [],
  policy_update:      [],
};

function normalizePayloadTimestamps(
  kind: SignalKindKey,
  data: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...data };

  for (const field of TIMESTAMP_FIELDS[kind]) {
    if (result[field] && typeof result[field] === "string") {
      result[field] = toTimestamp(result[field] as string);
    }
  }

  // Handle nested `as_of` timestamps inside PositionUpdate.positions
  if (kind === "position_update" && Array.isArray(result.positions)) {
    result.positions = (result.positions as any[]).map((pos: any) => ({
      ...pos,
      as_of: pos.as_of ? toTimestamp(pos.as_of as string) : undefined,
    }));
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a kind-specific payload object (e.g. a PriceQuote) to protobuf bytes.
 * ISO timestamp strings in the payload are automatically converted.
 */
export async function encodePayload(
  kind: SignalKindKey,
  data: Record<string, unknown>
): Promise<Uint8Array> {
  const meta = KIND_META[kind];
  if (!meta.typeName) {
    // reward_offer / policy_update have no typed payload — serialize as JSON
    return Buffer.from(JSON.stringify(data), "utf8");
  }

  const root = await getRoot();
  const MsgType = root.lookupType(meta.typeName);
  const normalized = normalizePayloadTimestamps(kind, data);

  const err = MsgType.verify(normalized);
  if (err) throw new Error(`Invalid ${kind} payload: ${err}`);

  return MsgType.encode(MsgType.create(normalized)).finish() as Uint8Array;
}

/**
 * Encode a complete AgentFinancialSignal to a Buffer ready for transport.
 *
 * The resulting bytes should be base64-encoded and sent as the `message`
 * field in a standard send_message call with
 * content_type = "application/x-pft-signal+proto".
 */
export async function encodeFinancialSignal(
  kind: SignalKindKey,
  payloadData: Record<string, unknown>,
  senderAgentId: string,
  options?: {
    recipientAgentId?: string;
    correlationId?: string;
    expiresAt?: string;
    metadata?: Record<string, string>;
  }
): Promise<Buffer> {
  const meta = KIND_META[kind];
  const root = await getRoot();
  const SignalType = root.lookupType("pf.signals.v1.AgentFinancialSignal");

  const payloadBytes = await encodePayload(kind, payloadData);

  const msgObj: Record<string, unknown> = {
    signalId: randomUUID(),
    senderAgentId,
    recipientAgentId: options?.recipientAgentId ?? "",
    kind: meta.enumName,
    contentKind: meta.contentKind,
    createdAt: toTimestamp(Date.now()),
    payload: payloadBytes,
    correlationId: options?.correlationId ?? "",
    schemaVersion: 1,
    metadata: options?.metadata ?? {},
  };

  if (options?.expiresAt) {
    msgObj.expiresAt = toTimestamp(options.expiresAt);
  }

  const err = SignalType.verify(msgObj);
  if (err) throw new Error(`AgentFinancialSignal validation failed: ${err}`);

  return Buffer.from(SignalType.encode(SignalType.create(msgObj)).finish());
}

// ── Decoded signal shape ──────────────────────────────────────────────────────

export interface DecodedSignal {
  signal_id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  kind: string;
  content_kind: string;
  created_at: string | null;
  expires_at: string | null;
  correlation_id: string;
  schema_version: number;
  metadata: Record<string, string>;
  payload: Record<string, unknown>;
}

/**
 * Decode a Buffer (from base64 message field) into a structured DecodedSignal.
 * The nested payload bytes are also decoded to a plain JS object.
 */
export async function decodeFinancialSignal(
  bytes: Buffer
): Promise<DecodedSignal> {
  const root = await getRoot();
  const SignalType = root.lookupType("pf.signals.v1.AgentFinancialSignal");

  const signal = SignalType.decode(bytes).toJSON() as any;

  // Determine kind from enum string name
  const kindEnumName: string = signal.kind ?? "";
  const kindKey: SignalKindKey | undefined = ENUM_NAME_TO_KIND[kindEnumName];

  let decodedPayload: Record<string, unknown> = {};

  if (signal.payload && kindKey) {
    const meta = KIND_META[kindKey];
    let rawBytes: Buffer;
    if (typeof signal.payload === "string") {
      rawBytes = Buffer.from(signal.payload, "base64");
    } else if (Buffer.isBuffer(signal.payload)) {
      rawBytes = signal.payload;
    } else if (signal.payload instanceof Uint8Array) {
      rawBytes = Buffer.from(signal.payload);
    } else {
      rawBytes = Buffer.alloc(0);
    }

    if (meta.typeName && rawBytes.length > 0) {
      const PayloadType = root.lookupType(meta.typeName);
      const decoded = PayloadType.decode(rawBytes).toJSON();
      decodedPayload = timestampsToIso(decoded) as Record<string, unknown>;
    } else if (!meta.typeName && rawBytes.length > 0) {
      // reward_offer / policy_update were serialized as JSON
      try {
        decodedPayload = JSON.parse(rawBytes.toString("utf8"));
      } catch {
        decodedPayload = { raw: rawBytes.toString("utf8") };
      }
    }
  }

  return {
    signal_id:        signal.signalId ?? "",
    sender_agent_id:  signal.senderAgentId ?? "",
    recipient_agent_id: signal.recipientAgentId ?? "",
    kind:             kindKey ?? kindEnumName ?? "unknown",
    content_kind:     signal.contentKind ?? "",
    created_at:       fromTimestamp(signal.createdAt),
    expires_at:       fromTimestamp(signal.expiresAt),
    correlation_id:   signal.correlationId ?? "",
    schema_version:   signal.schemaVersion ?? 0,
    metadata:         signal.metadata ?? {},
    payload:          decodedPayload,
  };
}
