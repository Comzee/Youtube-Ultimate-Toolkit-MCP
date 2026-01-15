# YouTube MCP - Remote Server Setup Handoff

## Context

I have a YouTube MCP server that currently works locally with Claude Desktop (stdio transport). I need to add remote MCP support (HTTP/SSE transport) so I can use it from Claude's web interface.

## Git Repository

```
git@giteassh.samjesberg.com:Comzee/YoutubeMCP.git
```

Clone it first, then modify to add remote support.

## Current State

- Working local MCP using `@modelcontextprotocol/sdk` with stdio transport
- Tools: `get_video`, `get_playlist`, `get_available_languages`
- Requires `yt-dlp` installed on the system
- Built with TypeScript, runs on Node.js 18+

## What Needs To Be Done

1. **Install yt-dlp** on this Ubuntu server if not present:
   ```bash
   pip install yt-dlp
   # or
   sudo apt install yt-dlp
   ```

2. **Clone the repo** and install dependencies:
   ```bash
   git clone git@giteassh.samjesberg.com:Comzee/YoutubeMCP.git
   cd YoutubeMCP
   npm install
   ```

3. **Add HTTP/SSE transport** to the MCP server:
   - The MCP SDK supports `SSEServerTransport` for remote connections
   - Need to add an HTTP server (express or native http) that handles:
     - `GET /sse` - SSE endpoint for server-to-client messages
     - `POST /messages` - endpoint for client-to-server messages
   - Add token-based authentication (check Authorization header)

4. **Support dual mode**:
   - `node dist/index.js` - runs in stdio mode (for Claude Desktop)
   - `node dist/index.js --remote --port 3000 --token SECRET` - runs HTTP server

5. **Set up as systemd service** for persistence:
   - Create `/etc/systemd/system/youtube-mcp.service`
   - Run on a port (e.g., 3000)
   - Store auth token securely (env var or config file)

6. **Push changes** back to git when done

## Example Remote MCP Implementation

```typescript
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

const app = express();
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "your-secret-token";

// Auth middleware
app.use((req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  next();
});

// SSE endpoint
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

// Messages endpoint
app.post("/messages", async (req, res) => {
  // Handle incoming messages
});

app.listen(3000);
```

## After Setup

Once running, I'll add it to Claude web:
- Settings > MCP Connectors
- URL: `https://your-server:3000/sse` (or with reverse proxy)
- Auth token: the secret token configured

## Notes

- Server needs Node.js 18+ and yt-dlp in PATH
- Consider running behind nginx with SSL for production
- The MCP should work identically to local version, just different transport
