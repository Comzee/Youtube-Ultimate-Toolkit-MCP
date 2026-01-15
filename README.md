# YouTube MCP Server

A Model Context Protocol (MCP) server that fetches YouTube video metadata and transcripts using yt-dlp. Supports both local (stdio) and remote (Streamable HTTP) modes for use with Claude Desktop and Claude Web UI.

## Features

- **get_video**: Fetches video metadata (title, channel, duration, views, upload date) and English transcript
- **get_playlist**: Lists all videos in a YouTube playlist with titles, durations, and URLs

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

Requires `.env` file with OAuth credentials (see `.env.example`).

The server exposes:
- `POST /mcp` - Main MCP endpoint (Streamable HTTP transport, spec 2025-03-26)
- `GET /mcp` - SSE stream for async responses
- `DELETE /mcp` - Session termination
- `GET /health` - Health check
- OAuth endpoints: `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`

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

For remote mode behind nginx (grey-cloud DNS on Cloudflare, not proxied):

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

## Claude Web UI Setup

1. Add MCP connection with URL: `https://youtubetools.samjesberg.com/mcp`
2. Recommended project description:
   ```
   When I paste a YouTube URL, automatically use the get_video tool to fetch its transcript, then give me a summary and key takeaways.
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
- Ensure DNS is grey-clouded (passthrough) on Cloudflare, not orange-clouded (proxied)
- Check service is running: `sudo systemctl status youtube-mcp`

## Architecture

- **Transport**: Streamable HTTP (MCP spec 2025-03-26) - replaced deprecated SSE transport
- **Session Management**: Stateful sessions with UUID identifiers stored in memory
- **OAuth**: Authorization Code flow with PKCE (currently bypassed for testing)

## Files

- `src/index.ts` - Main server code
- `youtube-mcp.service` - Systemd service file
- `.env` - OAuth credentials (not committed)
- `.env.example` - Example environment file
- `NEXT_SESSION_OAUTH.md` - Context for implementing OAuth in next session

## License

MIT
