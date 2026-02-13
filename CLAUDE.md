# CLAUDE.md

Project-level context for AI assistants working on this codebase.

## Keystone Protocol Reference

The Keystone server codebase (and its canonical `.proto` definitions) is typically
checked out one directory above this repo:

```
../keystone-protocol/
├── keystone/v1/registry/registry.proto   # Agent registry service (StoreAgentCard, etc.)
├── keystone/v1/core/                     # Envelope, content, validation protos
├── keystone/v1/auth/                     # Auth service proto
├── keystone/v1/storage/                  # Content & envelope storage protos
└── third_party/a2a/specification/grpc/a2a.proto  # Google A2A protocol (AgentCard, AgentProvider)
```

When making changes to the local proto subset in `src/grpc/protos/`, always cross-reference
the server protos at `../keystone-protocol/` to verify field numbers and message shapes
match what the server actually expects on the wire.
