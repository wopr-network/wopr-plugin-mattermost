# wopr-plugin-mattermost

Mattermost channel plugin for WOPR. Uses the Mattermost REST API v4 + WebSocket directly (no @mattermost/client SDK).

## Commands

```bash
bun install       # Install dependencies
bun run build     # tsc
bun run check     # biome check + tsc --noEmit (run before committing)
bun run lint:fix  # biome check --fix src/
bun run format    # biome format --write src/
bun test          # vitest run
```

## Architecture

```
src/
  index.ts              # Plugin entry — exports WOPRPlugin default, wires WebSocket listener
  types.ts              # Plugin-local types + Mattermost-specific types
  mattermost-client.ts  # Thin REST API + WebSocket wrapper (fetch + ws)
```

## Key Details

- **No SDK**: Uses raw `fetch` for REST API v4 and `ws` for WebSocket (avoids @mattermost/client Node.js bugs)
- **WebSocket reconnect**: Exponential backoff, max 10 attempts
- **Auth**: Personal Access Token (preferred) or username/password login
- **Thread support**: Detects `root_id` on incoming posts, replies in-thread
- **DM detection**: Channel type "D" (direct) or "G" (group DM)

## Plugin Contract

Imports only from local `./types.js`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-mattermost`.
