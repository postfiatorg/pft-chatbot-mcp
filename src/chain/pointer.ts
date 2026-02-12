import protobuf from "protobufjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, "..", "grpc", "protos");

// Memo type/format constants (hex-encoded)
const PF_PTR_MEMO_TYPE_HEX = "70662e707472"; // "pf.ptr"
const PF_PTR_MEMO_FORMAT_HEX = "7634"; // "v4"
const KEYSTONE_MEMO_TYPE_HEX = "6b657973746f6e65"; // "keystone"
const KEYSTONE_MEMO_FORMAT_HEX = "7631"; // "v1"

// Pointer flag bitmask (from pftasks)
export const POINTER_FLAGS = {
  encrypted: 0x01,
  public: 0x02,
  ephemeral: 0x04,
  tombstone: 0x08,
  multipart: 0x10,
} as const;

export type MemoType = "pf.ptr" | "keystone" | "unknown";

export interface DecodedPfPointer {
  type: "pf.ptr";
  cid: string;
  target: string;
  kind: string;
  schema: number;
  taskId: string;
  threadId: string;
  contextId: string;
  flags: number;
  isEncrypted: boolean;
}

export interface DecodedKeystoneEnvelope {
  type: "keystone";
  version: number;
  contentHash: Buffer;
  messageType: string;
  encryption: string;
  publicReferences: Array<{
    contentHash: Buffer;
    groupId: string;
    referenceType: string;
    annotation: string;
  }>;
  message: Buffer;
  metadata: Record<string, string>;
}

export type DecodedMemo = DecodedPfPointer | DecodedKeystoneEnvelope | null;

let pfPointerType: protobuf.Type | null = null;
let keystoneEnvelopeType: protobuf.Type | null = null;

async function loadProtos(): Promise<void> {
  if (pfPointerType && keystoneEnvelopeType) return;

  const pfRoot = await protobuf.load(
    resolve(PROTO_DIR, "pf/ptr/v4/pointer.proto")
  );
  pfPointerType = pfRoot.lookupType("pf.ptr.v4.Pointer");

  const ksRoot = await protobuf.load(
    resolve(PROTO_DIR, "keystone/v1/core/envelope.proto")
  );
  keystoneEnvelopeType = ksRoot.lookupType("keystone.v1.core.KeystoneEnvelope");
}

/**
 * Identify the memo type from hex-encoded MemoType and MemoFormat fields.
 */
export function identifyMemoType(
  memoTypeHex: string,
  memoFormatHex: string
): MemoType {
  if (
    memoTypeHex === PF_PTR_MEMO_TYPE_HEX &&
    memoFormatHex === PF_PTR_MEMO_FORMAT_HEX
  ) {
    return "pf.ptr";
  }
  if (
    memoTypeHex === KEYSTONE_MEMO_TYPE_HEX &&
    memoFormatHex === KEYSTONE_MEMO_FORMAT_HEX
  ) {
    return "keystone";
  }
  return "unknown";
}

/**
 * Decode a pf.ptr.v4.Pointer from hex-encoded MemoData.
 */
export async function decodePfPointer(
  memoDataHex: string
): Promise<DecodedPfPointer> {
  await loadProtos();
  const bytes = Buffer.from(memoDataHex, "hex");
  const decoded = pfPointerType!.decode(bytes) as any;

  return {
    type: "pf.ptr",
    cid: decoded.cid || "",
    target: decoded.target || "TARGET_UNSPECIFIED",
    kind: decoded.kind || "CONTENT_KIND_UNSPECIFIED",
    schema: decoded.schema || 0,
    taskId: decoded.taskId || "",
    threadId: decoded.threadId || "",
    contextId: decoded.contextId || "",
    flags: decoded.flags || 0,
    isEncrypted: (decoded.flags & POINTER_FLAGS.encrypted) !== 0,
  };
}

/**
 * Decode a KeystoneEnvelope from hex-encoded MemoData.
 */
export async function decodeKeystoneEnvelope(
  memoDataHex: string
): Promise<DecodedKeystoneEnvelope> {
  await loadProtos();
  const bytes = Buffer.from(memoDataHex, "hex");
  const decoded = keystoneEnvelopeType!.decode(bytes) as any;

  return {
    type: "keystone",
    version: decoded.version || 1,
    contentHash: decoded.contentHash
      ? Buffer.from(decoded.contentHash)
      : Buffer.alloc(0),
    messageType: decoded.messageType || "MESSAGE_TYPE_UNSPECIFIED",
    encryption: decoded.encryption || "ENCRYPTION_MODE_UNSPECIFIED",
    publicReferences: (decoded.publicReferences || []).map((ref: any) => ({
      contentHash: ref.contentHash
        ? Buffer.from(ref.contentHash)
        : Buffer.alloc(0),
      groupId: ref.groupId || "",
      referenceType: ref.referenceType || "CONTEXT_REFERENCE_TYPE_UNSPECIFIED",
      annotation: ref.annotation || "",
    })),
    message: decoded.message ? Buffer.from(decoded.message) : Buffer.alloc(0),
    metadata: decoded.metadata || {},
  };
}

/**
 * Build a pf.ptr.v4.Pointer memo for sending messages.
 * Returns hex-encoded memo fields ready for PFTL transaction.
 */
export async function buildPfPointerMemo(input: {
  cid: string;
  kind?: string;
  schema?: number;
  threadId?: string;
  contextId?: string;
  flags?: number;
}): Promise<{
  memoTypeHex: string;
  memoFormatHex: string;
  memoDataHex: string;
}> {
  await loadProtos();

  const payload: any = {
    cid: input.cid,
    target: "TARGET_CONTENT_BLOB",
    kind: input.kind || "CHAT",
    schema: input.schema || 1,
    threadId: input.threadId || "",
    contextId: input.contextId || "",
    flags: input.flags ?? POINTER_FLAGS.encrypted,
  };

  const err = pfPointerType!.verify(payload);
  if (err) throw new Error(`Invalid pointer payload: ${err}`);

  const message = pfPointerType!.create(payload);
  const bytes = pfPointerType!.encode(message).finish();

  return {
    memoTypeHex: PF_PTR_MEMO_TYPE_HEX,
    memoFormatHex: PF_PTR_MEMO_FORMAT_HEX,
    memoDataHex: Buffer.from(bytes).toString("hex"),
  };
}
