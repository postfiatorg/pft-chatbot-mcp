# Frontend Dual Message Type Support

> **Target repo**: `pftasks` (frontend at `app/src/`, backend at `api/src/`)
>
> This document describes the changes needed to support both `pf.ptr.v4`
> (existing messages) and Keystone envelope messages from bots in the inbox UI.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Backend Changes](#2-backend-changes)
3. [Frontend Changes](#3-frontend-changes)
4. [New Agent Directory Page](#4-new-agent-directory-page)
5. [Implementation Order](#5-implementation-order)

---

## 1. Overview

Currently the messaging system only handles `pf.ptr.v4` pointer memos.
Bot messages will initially also use `pf.ptr.v4` (same on-chain format),
but the decrypted payload may contain richer content types and metadata
like `reply_to_tx` and MIME types beyond `text`.

Future: Keystone envelopes (`keystone.v1`) will be a second memo type
with on-chain context references. The backend needs to handle both.

### What changes

| Layer | Current | After |
|-------|---------|-------|
| Backend memo filter | `memoType === 'pf.ptr'` only | `memoType === 'pf.ptr'` OR `memoType === 'keystone'` |
| Backend decoder | `decodePointerMemo()` only | `decodePointerMemo()` + `decodeKeystoneEnvelope()` |
| Frontend content types | `text` and `encrypted` | `text`, `encrypted`, `image/*`, `application/json`, `application/pdf`, etc. |
| Frontend sender display | Raw wallet address | Bot name + badge for registered agents |
| Frontend thread display | Address only | Bot icon for agent threads |

---

## 2. Backend Changes

### 2.1 Dual memo type decoding in message_service.js

**File**: `api/src/services/message_service.js`

In `syncMessagesForWallet()`, the current logic at approximately line 330-340
filters memos:

```javascript
// CURRENT: only handles pf.ptr
const memoType = Buffer.from(memo.MemoType, 'hex').toString('utf8');
const memoFormat = Buffer.from(memo.MemoFormat || '', 'hex').toString('utf8');
if (memoType !== 'pf.ptr' || memoFormat !== 'v4') continue;
```

Change to handle both types:

```javascript
const memoType = Buffer.from(memo.MemoType, 'hex').toString('utf8');
const memoFormat = Buffer.from(memo.MemoFormat || '', 'hex').toString('utf8');

let pointer = null;
let pointerCid = null;

if (memoType === 'pf.ptr' && memoFormat === 'v4') {
  // Existing pf.ptr.v4 handling
  pointer = decodePointerMemo(memo.MemoData);
  if (pointer.kind !== 'CHAT') continue;
  pointerCid = pointer.cid;
} else if (memoType === 'keystone' && memoFormat === 'v1') {
  // New: Keystone envelope handling
  pointer = decodeKeystoneEnvelope(memo.MemoData);
  // Extract CID from envelope metadata or content descriptor
  pointerCid = pointer.metadata?.cid || null;
  // If the envelope has inline content (no CID), handle differently
} else {
  continue; // Skip unknown memo types
}
```

### 2.2 Add Keystone envelope decoder

**File**: `api/src/pftl/pointer.js` (or new file `api/src/pftl/keystone.js`)

Add a `decodeKeystoneEnvelope()` function. This requires loading the Keystone
proto definitions. Use `protobufjs`:

```javascript
const protobuf = require('protobufjs');
const path = require('path');

let keystoneEnvelopeType = null;

async function loadKeystoneProto() {
  if (keystoneEnvelopeType) return;
  // Copy the simplified envelope.proto from pft-chatbot-mcp/src/grpc/protos/
  const root = await protobuf.load(
    path.join(__dirname, '..', 'proto', 'keystone', 'v1', 'core', 'envelope.proto')
  );
  keystoneEnvelopeType = root.lookupType('keystone.v1.core.KeystoneEnvelope');
}

async function decodeKeystoneEnvelope(memoDataHex) {
  await loadKeystoneProto();
  const bytes = Buffer.from(memoDataHex, 'hex');
  const decoded = keystoneEnvelopeType.decode(bytes);
  return keystoneEnvelopeType.toObject(decoded, {
    longs: String,
    enums: String,
    bytes: String,
  });
}
```

Copy the simplified proto files from `pft-chatbot-mcp/src/grpc/protos/keystone/`
into `pftasks/api/proto/keystone/`. These are dependency-free versions without
A2A or Google API imports.

### 2.3 Store bot metadata in message records

**File**: `api/src/services/message_service.js`

In `recordMessage()`, add fields for bot-specific metadata:

```javascript
// In the INSERT statement for messages table, the pointer_payload JSONB
// column already stores decoded pointer data. For bot messages, include:
const pointerPayload = {
  ...existingPointerData,
  content_type: parsed?.content_type || 'text',
  reply_to_tx: parsed?.reply_to_tx || null,
  is_bot: senderIsBot, // looked up from agent registry
  bot_name: botName || null,
};
```

### 2.4 Agent registry API endpoint

**File**: New file `api/src/routes/agents.js`

Add a simple endpoint that proxies to the Keystone gRPC service's agent
registry, so the frontend can fetch bot info:

```javascript
// GET /agents/search?capabilities=text-summarization&query=image
// Returns: [{ agent_id, name, description, capabilities, wallet_address }]

// GET /agents/:walletAddress
// Returns: { agent_id, name, description, capabilities } or 404
```

This can call the Keystone gRPC service directly, or cache agent data
in a local `agent_cards` table (synced periodically from the registry).

For v1, a simple approach: the backend fetches from the Keystone gRPC
SearchAgents/GetAgentCard endpoints and caches results in memory with
a 5-minute TTL.

---

## 3. Frontend Changes

### 3.1 Rich content type rendering in inbox

**File**: `app/src/pages/phase4__inbox.jsx`

Currently, decrypted messages are displayed as plain text. After decryption
(around line 410-420 in `tryDecryptMessages`), the parsed message has a
`content_type` field and an optional `attachments` array. Use both to
render different content:

#### Decrypted payload structure

Bot messages (from MCP) produce this decrypted payload:

```json
{
  "message": "Here's the report you asked for",
  "content_type": "text",
  "attachments": [
    {
      "cid": "bafk...",
      "uri": "ipfs://bafk...",
      "content_type": "image/png",
      "filename": "chart.png"
    },
    {
      "cid": "bafk...",
      "uri": "ipfs://bafk...",
      "content_type": "text/markdown",
      "filename": "report.md"
    }
  ],
  "sender_address": "rBot...",
  "recipient_address": "rUser...",
  "thread_id": "...",
  "reply_to_tx": "...",
  "amount_drops": "1000000",
  "created_at": "2026-02-12T..."
}
```

The `attachments` field is optional and may be absent in plain text messages.
When present, each attachment has a `cid` pointing to content on IPFS.

#### Rendering logic

```jsx
const IPFS_GATEWAY = 'https://pft-ipfs-testnet-node-1.fly.dev/ipfs';

function ipfsUrl(cidOrUri) {
  if (!cidOrUri) return null;
  const cid = cidOrUri.replace('ipfs://', '');
  return `${IPFS_GATEWAY}/${cid}`;
}

function renderMessageContent(message, decryptedContent) {
  const contentType = decryptedContent?.content_type || message.content_type || 'text';
  const text = decryptedContent?.message || message.preview || '';
  const attachments = decryptedContent?.attachments || [];

  return (
    <div>
      {/* 1. Render the message text */}
      {text && renderTextContent(text, contentType)}

      {/* 2. Render attachments inline */}
      {attachments.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {attachments.map((att, i) => (
            <AttachmentRenderer key={att.cid || i} attachment={att} />
          ))}
        </div>
      )}
    </div>
  );
}

function renderTextContent(text, contentType) {
  // Markdown / plain text
  if (contentType === 'text' || contentType.startsWith('text/')) {
    return <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>;
  }

  // JSON: formatted code block
  if (contentType === 'application/json') {
    try {
      const formatted = JSON.stringify(JSON.parse(text), null, 2);
      return (
        <pre style={{
          background: 'rgba(0,0,0,0.05)',
          padding: 12,
          borderRadius: 8,
          overflow: 'auto',
          fontSize: 12,
        }}>
          {formatted}
        </pre>
      );
    } catch {
      return <ReactMarkdown>{text}</ReactMarkdown>;
    }
  }

  // Fallback
  return <ReactMarkdown>{text}</ReactMarkdown>;
}

function AttachmentRenderer({ attachment }) {
  const { cid, uri, content_type: ct, filename } = attachment;
  const url = ipfsUrl(uri || cid);

  // Images: inline preview
  if (ct?.startsWith('image/')) {
    return (
      <div>
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={url}
            alt={filename || 'Image attachment'}
            style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8 }}
            loading="lazy"
          />
        </a>
        {filename && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{filename}</div>}
      </div>
    );
  }

  // Markdown: fetch and render inline
  if (ct === 'text/markdown' || filename?.endsWith('.md')) {
    return <MarkdownAttachment url={url} filename={filename} />;
  }

  // PDF: embed viewer
  if (ct === 'application/pdf') {
    return (
      <div>
        <iframe
          src={url}
          title={filename || 'PDF'}
          style={{ width: '100%', height: 500, border: '1px solid #e0e0e0', borderRadius: 8 }}
        />
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#1a73e8' }}>
          {filename || 'Open PDF'} ↗
        </a>
      </div>
    );
  }

  // JSON: fetch and display formatted
  if (ct === 'application/json') {
    return <JsonAttachment url={url} filename={filename} />;
  }

  // Everything else: download link
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: 8,
      border: '1px solid #e0e0e0',
      borderRadius: 8,
    }}>
      <FontAwesomeIcon icon={faPaperclip} style={{ color: '#888' }} />
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#1a73e8' }}>
        {filename || `Attachment (${ct})`} ↗
      </a>
    </div>
  );
}

// Lazy-loaded markdown attachment
function MarkdownAttachment({ url, filename }) {
  const [content, setContent] = useState(null);

  useEffect(() => {
    fetch(url).then(r => r.text()).then(setContent).catch(() => setContent('_Failed to load_'));
  }, [url]);

  if (!content) return <div>Loading {filename || 'document'}...</div>;

  return (
    <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12 }}>
      {filename && <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{filename}</div>}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}

// Lazy-loaded JSON attachment
function JsonAttachment({ url, filename }) {
  const [content, setContent] = useState(null);

  useEffect(() => {
    fetch(url).then(r => r.text()).then(setContent).catch(() => setContent('Failed to load'));
  }, [url]);

  if (!content) return <div>Loading {filename || 'data'}...</div>;

  return (
    <div>
      {filename && <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{filename}</div>}
      <pre style={{
        background: 'rgba(0,0,0,0.05)',
        padding: 12,
        borderRadius: 8,
        overflow: 'auto',
        fontSize: 12,
        maxHeight: 300,
      }}>
        {(() => {
          try { return JSON.stringify(JSON.parse(content), null, 2); }
          catch { return content; }
        })()}
      </pre>
    </div>
  );
}
```

Import `faPaperclip` from `@fortawesome/free-solid-svg-icons`.

### 3.2 Reply reference display

If a decrypted message contains `reply_to_tx`, show a "replying to..." indicator:

```jsx
function ReplyIndicator({ replyToTx, threadMessages }) {
  if (!replyToTx) return null;

  // Find the original message in the thread
  const original = threadMessages.find(m => m.tx_hash === replyToTx);
  const preview = original?.preview?.slice(0, 80) || 'Original message';

  return (
    <div style={{
      fontSize: 12,
      color: '#888',
      borderLeft: '2px solid #ccc',
      paddingLeft: 8,
      marginBottom: 4,
    }}>
      Replying to: {preview}...
    </div>
  );
}
```

### 3.3 Bot badge on messages

When a message sender is a registered bot, show a badge next to their address:

```jsx
function SenderDisplay({ senderAddress, botInfo }) {
  if (botInfo) {
    return (
      <span>
        <span style={{
          background: '#e8f0fe',
          color: '#1a73e8',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 11,
          marginRight: 6,
        }}>
          BOT
        </span>
        {botInfo.name || senderAddress}
      </span>
    );
  }
  return <span>{senderAddress}</span>;
}
```

To get bot info, add a React hook or context that caches agent lookups:

```javascript
// In a new hook: app/src/hooks/useAgentRegistry.js
const agentCache = new Map();

async function fetchAgentInfo(walletAddress) {
  if (agentCache.has(walletAddress)) {
    return agentCache.get(walletAddress);
  }
  try {
    const res = await fetch(`/api/agents/${walletAddress}`);
    if (res.ok) {
      const data = await res.json();
      agentCache.set(walletAddress, data);
      return data;
    }
  } catch { /* ignore */ }
  agentCache.set(walletAddress, null);
  return null;
}
```

### 3.4 Thread list indicators

**File**: `app/src/pages/phase4__inbox.jsx`

In the thread list sidebar, show a bot icon for threads where the contact
is a registered agent:

```jsx
// In the thread list rendering (around line 500+)
{thread.contact_address && agentInfo[thread.contact_address] && (
  <span title={agentInfo[thread.contact_address].name} style={{ marginRight: 4 }}>
    <FontAwesomeIcon icon={faRobot} size="xs" style={{ color: '#1a73e8' }} />
  </span>
)}
```

Import `faRobot` from `@fortawesome/free-solid-svg-icons`.

For the thread contact name, prefer the bot name over raw address:

```jsx
const displayName = agentInfo[thread.contact_address]?.name
  || thread.contact_name
  || truncateAddress(thread.contact_address);
```

---

## 4. New Agent Directory Page

Add a new route `/agents` that shows all registered bots.

### 4.1 Route

**File**: `app/src/App.jsx` (or wherever routes are defined)

Add: `<Route path="/agents" element={<AgentDirectory />} />`

### 4.2 Component

**File**: New file `app/src/pages/phase5__agents.jsx`

Layout:
- Header: "Bot Directory" with a search input
- Grid of agent cards
- Each card shows:
  - Bot name (large)
  - Description (2-3 lines)
  - Capabilities as colored tags
  - Wallet address (truncated, with copy button)
  - "Message" button that navigates to `/inbox?contact=<address>`

```jsx
function AgentDirectory() {
  const [agents, setAgents] = useState([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetchAgents(search).then(setAgents);
  }, [search]);

  return (
    <div style={{ padding: 24 }}>
      <h2>Bot Directory</h2>
      <input
        type="text"
        placeholder="Search bots by name or capability..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', padding: 12, marginBottom: 24, borderRadius: 8 }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {agents.map(agent => (
          <AgentCard key={agent.agent_id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent }) {
  const navigate = useNavigate();

  return (
    <div style={{
      border: '1px solid #e0e0e0',
      borderRadius: 12,
      padding: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <FontAwesomeIcon icon={faRobot} style={{ color: '#1a73e8' }} />
        <h3 style={{ margin: 0 }}>{agent.name}</h3>
      </div>
      <p style={{ color: '#666', fontSize: 14 }}>{agent.description}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {agent.capabilities.map(cap => (
          <span key={cap} style={{
            background: '#e8f0fe',
            color: '#1a73e8',
            padding: '2px 8px',
            borderRadius: 12,
            fontSize: 11,
          }}>
            {cap.split('/').pop().replace(/-/g, ' ')}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <code style={{ fontSize: 11, color: '#999' }}>
          {agent.wallet_address.slice(0, 8)}...{agent.wallet_address.slice(-6)}
        </code>
        <button
          onClick={() => navigate(`/inbox?contact=${agent.wallet_address}`)}
          style={{
            background: '#1a73e8',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            padding: '6px 16px',
            cursor: 'pointer',
          }}
        >
          Message
        </button>
      </div>
    </div>
  );
}
```

### 4.3 Navigation

Add "Bots" to the main navigation (sidebar or header), linking to `/agents`.

---

## 5. Implementation Order

1. **Backend: Keystone proto files** -- Copy simplified protos from
   `pft-chatbot-mcp/src/grpc/protos/keystone/` into `pftasks/api/proto/keystone/`
2. **Backend: Dual decoder** -- Update `message_service.js` to handle both memo types
3. **Backend: Agent API** -- Add `GET /agents/search` and `GET /agents/:address` endpoints
4. **Frontend: Content renderer** -- Add `renderMessageContent()` with MIME type branching
5. **Frontend: Reply indicator** -- Add `ReplyIndicator` component
6. **Frontend: Bot badge** -- Add `SenderDisplay` component with bot detection
7. **Frontend: Thread indicators** -- Bot icon in thread list
8. **Frontend: Agent directory** -- New `/agents` page
9. **Frontend: Navigation** -- Add "Bots" link to sidebar/header

### Dependencies

- Steps 1-3 (backend) can be done independently of the frontend.
- Steps 4-7 depend on step 3 (agent API) for bot detection.
- Step 8 depends on step 3 for the agent search endpoint.
- Steps 4-8 can be developed in parallel with each other once step 3 is done.

### Testing

- Send a plain text message from a registered bot (via pft-chatbot-mcp) to a test user.
- Verify the message appears in the user's inbox.
- Verify the bot badge appears next to the sender.
- Send a markdown message with `content_type: "text/markdown"` and verify it renders with formatting.
- Upload an image via `upload_content`, then send a message with `attachments` containing the CID. Verify the image renders inline in the inbox.
- Upload a markdown doc via `upload_content`, then send a message with the doc as an attachment. Verify it fetches and renders inline.
- Upload a PDF via `upload_content`, then send as attachment. Verify the iframe embed viewer appears.
- Send a message with multiple attachments (image + doc) and verify both render.
- Send a reply with `reply_to_tx` and verify the reply indicator appears.
- Visit `/agents` and verify the bot directory loads.
- Click "Message" on a bot card and verify it opens the inbox with that contact.
