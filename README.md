# YouTube MCP Server

A Model Context Protocol (MCP) server that fetches YouTube video metadata and transcripts using yt-dlp. Supports both local (stdio) and remote (Streamable HTTP) modes for use with Claude Desktop and Claude Web UI.

## Features

- **get_video**: Fetches video metadata (title, channel, duration, views, upload date) and English transcript
- **get_playlist**: Lists all videos in a YouTube playlist with titles, durations, and URLs
- **get_comments**: Fetches top comments with author, text, likes, and reply counts (requires YouTube API key)
- **get_screenshot**: Captures a frame from a video at any timestamp (requires ffmpeg)
- **OAuth 2.1 Authentication**: Secure access with PKCE, consent page, and token management

## Requirements

- Node.js 18+
- yt-dlp (must be kept up-to-date - YouTube breaks old versions frequently)
- ffmpeg (for screenshot feature)
- YouTube API key (for comments feature) - [Get one here](https://console.developers.google.com/)

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

# YouTube Data API Key (required for get_comments tool)
YOUTUBE_API_KEY=your-youtube-api-key-here
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

### get_comments

Fetches top comments from a YouTube video using the YouTube Data API v3.

**Parameters:**
- `url` (required): YouTube video URL or video ID
- `maxResults` (optional): Maximum comments to fetch (default: 25, max: 100)
- `order` (optional): Sort order - "relevance" (default) or "time"

**Returns:**
```
Comments for: Video Title Here
Total shown: 25

@Username1 (42 likes) [3 replies]
  This is an example comment text...

@Username2 (15 likes)
  Another comment here...
```

**Note:** Requires `YOUTUBE_API_KEY` environment variable. Get an API key from [Google Cloud Console](https://console.developers.google.com/).

### get_screenshot

Captures a screenshot from a YouTube video at a specific timestamp.

**Parameters:**
- `url` (required): YouTube video URL
- `timestamp` (optional): Time to capture (default: "0")
  - Accepts seconds: "30", "90.5"
  - Accepts MM:SS format: "1:30"
  - Accepts HH:MM:SS format: "1:30:00"

**Returns:** Base64-encoded JPEG image

**Note:** Requires ffmpeg to be installed (`apt install ffmpeg` on Ubuntu).

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

## Future Enhancements

Features inspired by [Mohammad1704/youtube-transcript-mcp](https://github.com/Mohammad1704/youtube-transcript-mcp) that could be added:

### 1. Multi-Language Support

Currently English-only. Add language parameter to `get_video` with auto-detection fallback.

**Implementation:**
```typescript
// In get_video tool, add language parameter
language: z.string().default("auto").describe("Language code (en, es, fr, etc.) or 'auto' for detection")

// Change subtitle fetch to use requested language
"--sub-lang", language === "auto" ? "en.*,es,fr,de,ja,ko,zh" : `${language}.*`

// Try multiple languages if auto-detection
const languagesToTry = ['en', 'es', 'fr', 'de', 'tr', 'pt', 'ja', 'ko', 'zh', 'it', 'ru', 'ar'];
for (const lang of languagesToTry) {
  // Try each language, return first success with prefix: [Auto-detected: ${lang}]
}
```

### 2. Transcript Caching

Add in-memory cache with TTL to avoid re-fetching the same video.

**Implementation:**
```typescript
// Cache structure
interface CacheEntry {
  data: string;
  expiresAt: number;
}
const transcriptCache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ERROR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for errors

// Cache key: videoId:language
function getCacheKey(videoId: string, language: string): string {
  return `${videoId}:${language}`;
}

// In get_video, check cache first
const cached = transcriptCache.get(getCacheKey(videoId, language));
if (cached && cached.expiresAt > Date.now()) {
  return cached.data;
}

// After successful fetch, cache result
transcriptCache.set(getCacheKey(videoId, language), {
  data: result,
  expiresAt: Date.now() + CACHE_TTL_MS
});
```

### 3. Retry Logic with Exponential Backoff

Add retry for transient yt-dlp failures.

**Implementation:**
```typescript
async function runYtDlpWithRetry(args: string[], cwd?: string, maxRetries = 3): Promise<string> {
  let lastError: Error;
  let backoff = 1000; // Start with 1 second

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await runYtDlp(args, cwd);
    } catch (error) {
      lastError = error as Error;
      console.log(`yt-dlp attempt ${attempt + 1} failed, retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2; // Exponential backoff
    }
  }
  throw lastError!;
}
```

### 4. URL Normalization

Explicit handling of all YouTube URL formats before passing to yt-dlp.

**Reference:** See `/tmp/youtube-transcript-mcp/src/utils/url-normalize.ts` for comprehensive implementation supporting:
- `youtube.com/watch?v=`
- `youtu.be/`
- `youtube.com/live/`
- `youtube.com/embed/`
- `youtube.com/shorts/`
- International domains (youtube.co.uk, youtube.de, etc.)
- Mobile URLs (m.youtube.com)

### 5. Analytics Tracking

Track usage metrics per video and daily totals.

**Implementation:**
```typescript
// Simple in-memory analytics
const analytics = {
  dailyRequests: new Map<string, number>(), // date -> count
  videoRequests: new Map<string, number>()  // videoId -> count
};

function trackRequest(videoId: string): void {
  const today = new Date().toISOString().split('T')[0];
  analytics.dailyRequests.set(today, (analytics.dailyRequests.get(today) || 0) + 1);
  analytics.videoRequests.set(videoId, (analytics.videoRequests.get(videoId) || 0) + 1);
}

// Add /analytics endpoint to view stats
app.get("/analytics", authMiddleware, (req, res) => {
  res.json({
    daily: Object.fromEntries(analytics.dailyRequests),
    topVideos: [...analytics.videoRequests.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
  });
});
```

### 6. Search Within Transcript

Search for keywords in the transcript and return highlighted matches with context.

**Source:** [ZubeidHendricks/youtube-mcp-server](https://github.com/ZubeidHendricks/youtube-mcp-server)

**Implementation:**
```typescript
// Add searchTerm parameter to get_video or create new tool
searchTerm: z.string().optional().describe("Search for this term in transcript")

// After getting transcript, filter and highlight matches
if (searchTerm) {
  const regex = new RegExp(searchTerm, 'gi');
  const lines = transcript.split('\n');
  const matches = lines
    .map((line, i) => ({ line, index: i }))
    .filter(({ line }) => regex.test(line))
    .map(({ line, index }) => `[${index}] ${line.replace(regex, m => `**${m}**`)}`);

  return `Found ${matches.length} matches:\n\n${matches.join('\n')}`;
}
```

### 7. Timestamped Transcript Output

Include timestamps with each line for "jump to" functionality.

**Source:** [ZubeidHendricks/youtube-mcp-server](https://github.com/ZubeidHendricks/youtube-mcp-server)

**Implementation:**
```typescript
// Add parameter
includeTimestamps: z.boolean().default(false).describe("Include timestamps with transcript lines")

// When parsing VTT, keep timestamps instead of stripping:
// Parse: "00:01:23.456 --> 00:01:25.789" and associate with following text
// Output: "[1:23] The transcript text here..."

function parseVttWithTimestamps(vttContent: string): Array<{time: string, text: string}> {
  const lines = vttContent.split('\n');
  const result: Array<{time: string, text: string}> = [];
  let currentTime = '';

  for (const line of lines) {
    const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})\.\d{3}\s*-->/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]);
      const mins = parseInt(timeMatch[2]);
      const secs = parseInt(timeMatch[3]);
      currentTime = hours > 0 ? `${hours}:${mins}:${secs.toString().padStart(2,'0')}`
                             : `${mins}:${secs.toString().padStart(2,'0')}`;
    } else if (line.trim() && !line.includes('WEBVTT') && currentTime) {
      result.push({ time: currentTime, text: line.trim() });
    }
  }
  return result;
}
```

### 8. Markdown Output Templates

Configurable output formats for different use cases (notes, blog posts, study guides).

**Source:** [nattyraz/youtube-mcp](https://github.com/nattyraz/youtube-mcp)

**Implementation:**
```typescript
// Add format parameter
format: z.enum(["plain", "markdown", "json"]).default("plain")

// Markdown format output:
function formatAsMarkdown(metadata: any, transcript: string): string {
  return `# ${metadata.title}

*${metadata.channel}* | ${metadata.duration} | ${metadata.views} views | ${metadata.uploadDate}

---

## Transcript

${transcript}

---
*Generated by YouTube MCP*
`;
}

// JSON format for programmatic use:
function formatAsJson(metadata: any, transcript: string): string {
  return JSON.stringify({
    metadata: {
      title: metadata.title,
      channel: metadata.channel,
      duration: metadata.duration,
      views: metadata.views,
      uploadDate: metadata.uploadDate
    },
    transcript: transcript.split('\n')
  }, null, 2);
}
```

### 9. MCP Resource URIs

Expose videos as MCP resources for protocol compliance.

**Source:** [nattyraz/youtube-mcp](https://github.com/nattyraz/youtube-mcp)

**Implementation:**
```typescript
// In server setup, add resource templates
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: 'youtube://{video_id}/transcript',
      name: 'Video transcript',
      description: 'Get transcript for a YouTube video',
      mimeType: 'text/plain'
    },
    {
      uriTemplate: 'youtube://{video_id}/info',
      name: 'Video metadata',
      description: 'Get video metadata (title, channel, etc)',
      mimeType: 'application/json'
    }
  ]
}));

// Handle resource reads
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const match = request.params.uri.match(/^youtube:\/\/([^\/]+)\/(.+)$/);
  if (!match) throw new Error('Invalid URI');

  const [_, videoId, type] = match;
  // Fetch and return based on type...
});
```

### Reference Repositories

Analyzed for feature ideas:

| Repository | Novel Features |
|------------|---------------|
| [Mohammad1704/youtube-transcript-mcp](https://github.com/Mohammad1704/youtube-transcript-mcp) | Multi-language, caching, retry logic |
| [ZubeidHendricks/youtube-mcp-server](https://github.com/ZubeidHendricks/youtube-mcp-server) | Transcript search, timestamped output, YouTube search |
| [nattyraz/youtube-mcp](https://github.com/nattyraz/youtube-mcp) | Markdown templates, MCP resources, chapter support |
| [mrgoonie/vidcap-mcp-server](https://github.com/mrgoonie/vidcap-mcp-server) | ✅ Screenshots, ✅ comments, AI summaries |
| [anaisbetts/mcp-youtube](https://github.com/anaisbetts/mcp-youtube) | (Similar to this implementation) |

Key advantages of this implementation over all others:
- **Only one with OAuth 2.1 + password protection** for remote access
- **Only one with Streamable HTTP transport** for Claude Web UI
- Uses yt-dlp (more reliable than npm transcript libraries)
- Full metadata + transcript in single call
- Playlist support
- **Screenshots** via ffmpeg (no external API dependency)
- **Comments** via YouTube Data API v3

## License

MIT
