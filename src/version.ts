/**
 * Version tracking for the MCP server and its protocol dependencies.
 *
 * When the Keystone protocol protos are updated, bump KEYSTONE_PROTOCOL_VERSION
 * to match the new proto version, then update the MCP server code accordingly.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** MCP server version (read from package.json -- single source of truth) */
export const MCP_VERSION: string = pkg.version;

/** Keystone protocol version this MCP server is compatible with */
export const KEYSTONE_PROTOCOL_VERSION = "v1";

/** pf.ptr pointer version supported */
export const PF_PTR_VERSION = "v4";

/**
 * Minimum compatible Keystone gRPC server version.
 * The MCP server will check this on startup if the gRPC server
 * exposes a version endpoint in the future.
 */
export const MIN_KEYSTONE_SERVER_VERSION = "0.1.0";
