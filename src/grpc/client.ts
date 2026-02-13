import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, "protos");

// Load options for proto-loader
const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

export interface ContentDescriptor {
  uri: string;
  contentType: string;
  contentLength: string; // long as string
  contentHash: Buffer;
}

export interface StoreContentResponse {
  descriptor: ContentDescriptor;
}

export interface StoreEnvelopeResponse {
  envelopeId: string;
  storageBackend: string;
  metadata: Record<string, string>;
}

export interface CommandDescriptor {
  command: string;
  example: string;
  description: string;
}

export interface AgentProviderData {
  url: string;
  organization: string;
}

export interface AgentCardData {
  name: string;
  description: string;
  url: string;
  provider: AgentProviderData;
  version: string;
}

export interface AgentCapabilitiesData {
  publicEncryptionKey: Buffer;
  supportedSemanticCapabilities: string[];
}

export interface AgentSearchResult {
  agentId: string;
  agentCard: AgentCardData;
  keystoneCapabilities: AgentCapabilitiesData;
  relevanceScore: number;
  supportedCommands: CommandDescriptor[];
}

export interface SearchAgentsResponse {
  results: AgentSearchResult[];
  totalCount: number;
}

export interface StoreAgentCardResponse {
  agentCard: AgentCardData;
  supportedCommands: CommandDescriptor[];
}

export interface GetAgentCardResponse {
  agentCard: AgentCardData;
  supportedCommands: CommandDescriptor[];
}

export interface VerifyAndIssueKeyResponse {
  apiKey: string;
  walletAddress: string;
  writeLimitPerHour: number;
  readLimitPerHour: number;
}

export interface RequestApiKeyResponse {
  challengeNonce: string;
  expiresAtUnix: string; // long as string
}

// Promisify a gRPC unary call
function promisify<TReq, TRes>(
  client: grpc.Client,
  method: (
    req: TReq,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res: TRes) => void
  ) => void
): (req: TReq, metadata?: grpc.Metadata) => Promise<TRes> {
  return (req: TReq, metadata?: grpc.Metadata) =>
    new Promise((resolve, reject) => {
      method.call(
        client,
        req,
        metadata || new grpc.Metadata(),
        (err: grpc.ServiceError | null, res: TRes) => {
          if (err) reject(err);
          else resolve(res);
        }
      );
    });
}

export class KeystoneClient {
  private contentStorage: grpc.Client;
  private envelopeStorage: grpc.Client;
  private agentRegistry: grpc.Client;
  private authService: grpc.Client;
  private apiKey: string | null;

  constructor(config: Config) {
    this.apiKey = config.keystoneApiKey;

    const target = config.keystoneGrpcUrl;
    // Default to TLS. Only use insecure for localhost/dev when explicitly opted in.
    const isInsecure =
      process.env.KEYSTONE_GRPC_INSECURE === "true" ||
      target.startsWith("localhost") ||
      target.startsWith("127.0.0.1") ||
      target.startsWith("[::1]");
    const credentials = isInsecure
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl();

    // Load storage proto
    const storagePkg = protoLoader.loadSync(
      "keystone/v1/storage/storage.proto",
      LOADER_OPTIONS
    );
    const storageProto = grpc.loadPackageDefinition(storagePkg) as any;

    this.contentStorage =
      new storageProto.keystone.v1.storage.KeystoneContentStorageService(
        target,
        credentials
      );
    this.envelopeStorage =
      new storageProto.keystone.v1.storage.KeystoneEnvelopeStorageService(
        target,
        credentials
      );

    // Load registry proto
    const registryPkg = protoLoader.loadSync(
      "keystone/v1/registry/registry.proto",
      LOADER_OPTIONS
    );
    const registryProto = grpc.loadPackageDefinition(registryPkg) as any;

    this.agentRegistry =
      new registryProto.keystone.v1.registry.KeystoneAgentRegistryService(
        target,
        credentials
      );

    // Load auth proto
    const authPkg = protoLoader.loadSync(
      "keystone/v1/auth/auth.proto",
      LOADER_OPTIONS
    );
    const authProto = grpc.loadPackageDefinition(authPkg) as any;

    this.authService = new authProto.keystone.v1.auth.KeystoneAuthService(
      target,
      credentials
    );
  }

  private authMetadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.apiKey) {
      md.set("x-api-key", this.apiKey);
    }
    return md;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  // --- Auth Service ---

  async requestApiKey(walletAddress: string): Promise<RequestApiKeyResponse> {
    const call = promisify<any, RequestApiKeyResponse>(
      this.authService,
      (this.authService as any).requestApiKey
    );
    return call({ walletAddress });
  }

  async verifyAndIssueKey(
    walletAddress: string,
    challengeNonce: string,
    signatureHex: string,
    label: string
  ): Promise<VerifyAndIssueKeyResponse> {
    const call = promisify<any, VerifyAndIssueKeyResponse>(
      this.authService,
      (this.authService as any).verifyAndIssueKey
    );
    return call({ walletAddress, challengeNonce, signatureHex, label });
  }

  // --- Content Storage ---

  async storeContent(
    content: Buffer,
    contentType: string
  ): Promise<StoreContentResponse> {
    const call = promisify<any, StoreContentResponse>(
      this.contentStorage,
      (this.contentStorage as any).storeContent
    );
    return call({ content, contentType }, this.authMetadata());
  }

  // --- Envelope Storage ---

  async storeEnvelope(envelope: any): Promise<StoreEnvelopeResponse> {
    const call = promisify<any, StoreEnvelopeResponse>(
      this.envelopeStorage,
      (this.envelopeStorage as any).storeEnvelope
    );
    return call({ envelope }, this.authMetadata());
  }

  async listEnvelopesBySender(
    sender: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ envelopes: any[]; totalCount: number }> {
    const call = promisify<any, any>(
      this.envelopeStorage,
      (this.envelopeStorage as any).listEnvelopesBySender
    );
    return call({ sender, limit, offset }, this.authMetadata());
  }

  // --- Agent Registry ---

  async storeAgentCard(
    agentCard: {
      name: string;
      description: string;
      url?: string;
      version?: string;
      organization?: string;
    },
    capabilities: {
      publicEncryptionKey: Buffer;
      supportedSemanticCapabilities: string[];
    },
    commands?: Array<{
      command: string;
      example: string;
      description: string;
    }>,
    agentId?: string
  ): Promise<StoreAgentCardResponse> {
    const call = promisify<any, StoreAgentCardResponse>(
      this.agentRegistry,
      (this.agentRegistry as any).storeAgentCard
    );
    return call(
      {
        agentCard: {
          name: agentCard.name,
          description: agentCard.description,
          url: agentCard.url || "",
          provider: {
            organization: agentCard.organization || "",
          },
          version: agentCard.version || "1.0.0",
        },
        keystoneCapabilities: {
          envelopeProcessing: true,
          ledgerPersistence: true,
          publicEncryptionKey: capabilities.publicEncryptionKey,
          publicKeyAlgorithm: "PUBLIC_KEY_ALGORITHM_CURVE25519",
          supportedSemanticCapabilities:
            capabilities.supportedSemanticCapabilities,
          supportedEncryptionModes: ["ENCRYPTION_MODE_PUBLIC_KEY"],
        },
        agentId: agentId || "",
        // supported_commands is a top-level field on the request, NOT inside agentCard
        supportedCommands: (commands || []).map((cmd) => ({
          command: cmd.command,
          example: cmd.example,
          description: cmd.description,
        })),
      },
      this.authMetadata()
    );
  }

  async searchAgents(
    query?: string,
    capabilities?: string[],
    limit: number = 20
  ): Promise<SearchAgentsResponse> {
    const call = promisify<any, SearchAgentsResponse>(
      this.agentRegistry,
      (this.agentRegistry as any).searchAgents
    );
    return call(
      {
        query: query || "",
        capabilities: capabilities || [],
        limit,
        offset: 0,
      },
      this.authMetadata()
    );
  }

  async getAgentCard(agentId: string): Promise<GetAgentCardResponse> {
    const call = promisify<any, GetAgentCardResponse>(
      this.agentRegistry,
      (this.agentRegistry as any).getAgentCard
    );
    return call({ agentId }, this.authMetadata());
  }

  async deleteAgentCard(agentId: string): Promise<Record<string, never>> {
    const call = promisify<any, Record<string, never>>(
      this.agentRegistry,
      (this.agentRegistry as any).deleteAgentCard
    );
    return call({ agentId }, this.authMetadata());
  }

  close(): void {
    (this.contentStorage as any).close?.();
    (this.envelopeStorage as any).close?.();
    (this.agentRegistry as any).close?.();
    (this.authService as any).close?.();
  }
}
