# MASTER-MOLD Federation Mesh

MASTER-MOLD federation is an ad-hoc peer mesh. There is no permanent central hub. Each host keeps its own local MCP server, local SQLite/event log, local desktop/context capture, and local authorization policy. A lightweight sidecar on each approved host publishes a bounded signed context stream to whichever peers it is configured to trust.

## Wire Diagram

```mermaid
flowchart LR
  subgraph A["Host A: local MASTER-MOLD"]
    AAgents["IDE/agent clients<br/>Codex, Claude, Cursor"]
    AMcp["MCP HTTP/STDIO<br/>tools + Agent Office"]
    AStore["Local SQLite<br/>events, worker.fabric, memories"]
    AContext["Local capture<br/>kernel.summary, event.tail, desktop.context"]
    ASidecar["federation_sidecar.mjs<br/>bounded publisher"]
    ASecrets["Host secrets<br/>bearer token + Ed25519 identity"]
  end

  subgraph B["Host B: local MASTER-MOLD"]
    BAgents["IDE/agent clients"]
    BMcp["MCP HTTP/STDIO<br/>/federation/ingest"]
    BStore["Local SQLite<br/>events, worker.fabric, memories"]
    BContext["Local capture"]
    BSidecar["federation_sidecar.mjs"]
    BSecrets["Host secrets"]
  end

  subgraph C["Host C: optional peer"]
    CMcp["MCP HTTP/STDIO<br/>/federation/ingest"]
    CStore["Local SQLite"]
    CSidecar["federation_sidecar.mjs"]
  end

  AAgents --> AMcp
  AMcp --> AStore
  AMcp --> AContext
  AContext --> ASidecar
  ASecrets --> ASidecar

  BAgents --> BMcp
  BMcp --> BStore
  BMcp --> BContext
  BContext --> BSidecar
  BSecrets --> BSidecar

  ASidecar -- "signed POST /federation/ingest<br/>compact context + event summary" --> BMcp
  BSidecar -- "signed POST /federation/ingest<br/>compact context + event summary" --> AMcp
  ASidecar -- "optional peer tendril" --> CMcp
  CSidecar -- "optional peer tendril" --> AMcp

  BMcp --> BStore
  AMcp --> AStore
  CMcp --> CStore
```

## Trust Flow

```mermaid
sequenceDiagram
  participant Host as New Host
  participant OP as 1Password CLI
  participant Peer as Existing Peer
  participant Office as Agent Office

  Host->>Host: federation_secret_bootstrap.mjs creates bearer token + Ed25519 host key
  Host->>OP: Upsert user-scoped host credential item
  Host->>Peer: request_remote_access.mjs sends public key + host metadata
  Peer->>Office: Stage pending worker.fabric host
  Office->>Peer: Operator approves host and scopes permission_profile
  Host->>Peer: federation_sidecar.mjs signs each /federation/ingest request
  Peer->>Peer: Verify network gate, host key, timestamp, nonce, bearer token
  Peer->>Peer: Persist federation.ingest event and update worker.fabric freshness
```

## Team Bootstrap

Run this on each host that will participate in the mesh:

```bash
npm run federation:secrets:bootstrap -- \
  --vault Employee \
  --host-id my-host \
  --peers http://peer-a.local:8787,http://peer-b.local:8787 \
  --write-env
```

The script assumes `op` is installed and unlocked on that host. Use `--op-path /path/to/op` when SSH or launchd does not inherit the normal shell PATH.

For the first same-day mesh, use a shared MCP bearer token across the whitelisted peers or run a separate sidecar process per peer/token. The Ed25519 host signature is still the durable host identity; the bearer token is the HTTP transport gate. To seed a shared token on a host, pass `--shared-bearer-token` or set `MASTER_MOLD_FEDERATION_SHARED_BEARER_TOKEN` before running the bootstrap script.

The script performs these local actions:

- Creates or reuses `data/imprint/http_bearer_token` with `0600` permissions.
- Creates or reuses `~/.master-mold/identity/<host-id>-ed25519.pem`.
- Saves the bearer token, private key, public key, host ID, hostname, workspace path, and peer list into a 1Password API Credential item.
- Optionally writes only non-secret federation settings into `.env`.

After secrets exist, request access from each peer that should trust this host:

```bash
node scripts/request_remote_access.mjs \
  --server http://peer-a.local:8787 \
  --host-id my-host \
  --workspace-root "$PWD" \
  --identity-key-path ~/.master-mold/identity/my-host-ed25519.pem
```

Approve the pending host in Agent Office. Then start the sidecar:

```bash
npm run federation:sidecar -- --once
npm run federation:launchd:install
```

## Payload Boundary

The sidecar intentionally streams a compact subset by default:

- `kernel.summary` highlights.
- Recent runtime event headers and summaries, excluding federation echo events.
- `desktop.context` freshness, source, frame paths, and stale/unavailable reasons.
- Host identity metadata such as host ID, hostname, agent runtime, and model label.

It does not stream raw screenshots, raw transcripts, full memory stores, or broad filesystem content by default. Peers can use the received context as a routing and awareness signal, then request more authoritative information through explicit MCP tools when authorized.
