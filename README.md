# YouTube MCP Server

A Model Context Protocol (MCP) server that fetches YouTube video metadata and transcripts using yt-dlp. Supports both local (stdio) and remote (Streamable HTTP) modes for use with Claude Desktop and Claude Web UI.

## Features

- **get_video**: Fetches video metadata (title, channel, duration, views, upload date) and English transcript
- **get_playlist**: Lists all videos in a YouTube playlist with titles, durations, and URLs
- **OAuth 2.1 Authentication**: Secure access with PKCE, consent page, and token management

## Requirements

- Node.js 18+
- yt-dlp (must be kept up-to-date - YouTube breaks old versions frequently)

### Updating yt-dlp

```bash
pip3 install --upgrade --break-system-packages yt-dlp
```

## Installation

```bash
git clone git@giteassh.samjesberg.com:Comzee/YoutubeMCP.git
cd YoutubeMCP
npm install
npm run build
```

## Usage

### Local Mode (Claude Desktop - stdio)

```bash
node dist/index.js
```

Add to Claude Desktop config (`~/.config/claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/path/to/YoutubeMCP/dist/index.js"]
    }
  }
}
```

### Remote Mode (Claude Web UI - Streamable HTTP)

```bash
node dist/index.js --remote --port 3010
```

Requires `.env` file with OAuth credentials:
```bash
OAUTH_CLIENT_ID=youtube-mcp-client
OAUTH_CLIENT_SECRET=your-secret-here  # Generate with: openssl rand -hex 32
# Generate password hash with: node -e "require('bcrypt').hash('yourpassword', 12).then(console.log)"
AUTH_PASSWORD_HASH=$2b$12$...your-bcrypt-hash-here...
```

The server exposes:
- `POST /mcp` - Main MCP endpoint (Streamable HTTP transport, spec 2025-03-26)
- `GET /mcp` - SSE stream for async responses
- `DELETE /mcp` - Session termination
- `GET /health` - Health check
- OAuth endpoints (see below)

## OAuth Implementation

The server implements OAuth 2.1 with PKCE for Claude Web UI authentication.

### OAuth Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-authorization-server` | OAuth server metadata discovery |
| `/.well-known/oauth-protected-resource` | Protected resource metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint - shows consent page |
| `/authorize/approve` | Handles user approval, generates auth code |
| `/token` | Token exchange and refresh |

### How It Works

1. **Connection**: Claude connects to `/mcp` - handshake methods (`initialize`, `tools/list`) are allowed without auth
2. **Tool Call**: When you use a tool, Claude gets 401 with `WWW-Authenticate` header
3. **OAuth Discovery**: Claude discovers OAuth endpoints via protected resource metadata
4. **Dynamic Registration**: Claude registers and gets client credentials
5. **Authorization**: Browser opens consent page - user clicks "Authorize"
6. **Token Exchange**: Claude exchanges auth code for access token (with PKCE verification)
7. **Authenticated Request**: Claude retries tool call with Bearer token

### Auth-Free Methods

These MCP methods work without authentication (for discovery/handshake):
- `initialize`
- `notifications/initialized`
- `tools/list`
- `prompts/list`
- `resources/list`
- `ping`

Actual tool calls (`tools/call`) require authentication.

### Security Notes

- **Password-protected consent page** - Only users who know the password can authorize access
- **Bcrypt password hashing** - Password stored as bcrypt hash, not plaintext
- **Rate limiting** - Max 5 attempts per IP before 10-minute lockout
- **IP-based lockout** - Failed attempts tracked per IP with automatic lockout
- **XSS protection** - All user-controlled OAuth parameters are HTML-escaped
- **Command injection protection** - yt-dlp spawned with `shell: false`
- PKCE (S256) is required for all authorization flows
- Tokens are stored in memory (lost on restart)
- CORS is configured for Claude Web UI access

### Security Assessment

| Layer | Protection | Status |
|-------|-----------|--------|
| Network | Cloudflare proxy | IP hidden, DDoS protection |
| Transport | HTTPS/TLS | Via nginx + Let's Encrypt |
| Authentication | Password-protected consent | Only owner can authorize |
| Password Storage | Bcrypt hash | Not reversible |
| Brute Force | Rate limiting + lockout | 5 attempts, 10min lockout |
| XSS | HTML escaping | All OAuth params sanitized |
| Command Injection | shell: false on spawn | Safe by design |
| PKCE | S256 verification | Prevents code interception |

**Threat Level: Low** - Suitable for personal use. Protected against script kiddies, automated scanners, and opportunistic attackers. No obvious attack surface for competent hackers.

**Remaining theoretical risks:**
- Password guessing (mitigated by lockout)
- Zero-day in Node.js/Express (keep updated)
- Password reuse from other compromised services

## Claude Web UI Setup

1. Go to Settings → Connectors → Add Custom Connector
2. Enter URL: `https://youtubetools.samjesberg.com/mcp`
3. (Optional) Enter client ID/secret in Advanced Settings, or let Dynamic Client Registration handle it
4. Start a new chat and enable the MCP
5. Use a YouTube URL - authorization popup will appear on first tool use
6. Click "Authorize" on the consent page

Recommended project description:
```
When I paste a YouTube URL, automatically use the get_video tool to fetch its transcript, then give me a summary and key takeaways.
```

## Systemd Service

```bash
sudo cp youtube-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable youtube-mcp
sudo systemctl start youtube-mcp

# View logs
sudo journalctl -u youtube-mcp -f
```

## Nginx Configuration

For remote mode behind nginx (works with Cloudflare proxy enabled):

```nginx
server {
    listen 443 ssl;
    server_name youtubetools.samjesberg.com;

    ssl_certificate /etc/letsencrypt/live/samjesberg.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/samjesberg.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3010;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Important for long-running tool calls
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_set_header X-Accel-Buffering no;
    }
}
```

## Tools

### get_video

Fetches video metadata and English transcript.

**Parameters:**
- `url` (required): YouTube video URL

**Returns:**
```
Title: Video Title Here
Channel: Channel Name
Duration: 12:34 | Views: 1,234,567 | Uploaded: 2024-01-15

---
Transcript:

The cleaned transcript text appears here...
```

### get_playlist

Lists videos in a YouTube playlist.

**Parameters:**
- `url` (required): YouTube playlist URL
- `limit` (optional): Max videos to list (default: 50, max: 200)

## Troubleshooting

### "No English transcript available"
Update yt-dlp - YouTube changes their API frequently:
```bash
pip3 install --upgrade --break-system-packages yt-dlp
```

### Claude using wrong/old tools
Disconnect and reconnect the MCP in Claude settings to refresh the tool list.

### MCP won't connect from Claude Web UI
- Cloudflare proxy (orange-cloud) is supported
- Check service is running: `sudo systemctl status youtube-mcp`
- Check logs: `sudo journalctl -u youtube-mcp -f`

### OAuth flow not starting
- Verify CORS headers are present (check browser console)
- Ensure `/.well-known/` endpoints return 200 (not 401)
- Check that `/register` returns valid client credentials

### Authorization window doesn't appear
- OAuth flow triggers on first tool USE, not on connection
- Start a chat, enable MCP, then ask Claude to fetch a YouTube video

## Architecture

- **Transport**: Streamable HTTP (MCP spec 2025-03-26)
- **Session Management**: Stateful sessions with UUID identifiers stored in memory
- **OAuth**: Authorization Code flow with PKCE, Dynamic Client Registration
- **Token Storage**: In-memory (tokens lost on service restart)

## Files

- `src/index.ts` - Main server code with OAuth implementation
- `youtube-mcp.service` - Systemd service file
- `.env` - OAuth credentials (not committed)
- `.env.example` - Example environment file

## License

MIT
