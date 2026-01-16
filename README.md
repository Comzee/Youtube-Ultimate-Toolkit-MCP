# YouTube MCP Server

A Model Context Protocol (MCP) server that fetches YouTube video metadata and transcripts using yt-dlp. Supports both local (stdio) and remote (Streamable HTTP) modes for use with Claude Desktop and Claude Web UI.

## Features

- **get_video**: Fetches video metadata (title, channel, duration, views, upload date) and English transcript
- **get_playlist**: Lists all videos in a YouTube playlist with titles, durations, and URLs
- **get_comments**: Fetches top comments with author, text, likes, and reply counts (requires YouTube API key)
- **get_screenshot**: Captures a frame from a video at any timestamp (requires ffmpeg)
- **get_audio**: Extracts audio clips (max 120s) for speech/music analysis (requires ffmpeg)
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

Fetches video metadata and English transcript with advanced options.

**Parameters:**
- `url` (required): YouTube video URL (supports all formats: watch, youtu.be, shorts, live, embed, mobile)
- `includeTimestamps` (optional): Include timestamps with each line (default: false)
- `startTime` (optional): Start time for transcript range (e.g., "60", "1:00", "1:00:00")
- `endTime` (optional): End time for transcript range
- `searchTerm` (optional): Search for this term - returns matching lines with context
- `keySegmentsOnly` (optional): Return only hook (first 40s) and outro (last 30s) for token optimization

**URL Formats Supported:**
- `youtube.com/watch?v=VIDEO_ID`
- `youtu.be/VIDEO_ID`
- `youtube.com/shorts/VIDEO_ID`
- `youtube.com/live/VIDEO_ID`
- `youtube.com/embed/VIDEO_ID`
- `m.youtube.com/watch?v=VIDEO_ID` (mobile)
- `music.youtube.com/watch?v=VIDEO_ID`
- Direct video ID: `dQw4w9WgXcQ`

**Example Returns:**

*Basic (no options):*
```
Title: Video Title Here
Channel: Channel Name
Duration: 12:34 | Views: 1,234,567 | Uploaded: 2024-01-15

---
Transcript:

The cleaned transcript text appears here...
```

*With timestamps (`includeTimestamps: true`):*
```
---
Transcript:

[0:00] Welcome to this video
[0:05] Today we're going to talk about...
[1:23] The main point is...
```

*With time range (`startTime: "1:00", endTime: "2:00"`):*
```
---
Transcript ([1:00] - [2:00]):

Only the transcript from 1:00 to 2:00 appears here...
```

*With search (`searchTerm: "machine learning"`):*
```
---
Search Results for "machine learning" (3 matches):

[2:15] ...and that's where **machine learning** comes in
[2:18] The key to **machine learning** is data
[5:42] So to summarize, **machine learning** enables...
```

*Key segments only (`keySegmentsOnly: true`):*
```
---
Key Segments (Token Optimized):

--- HOOK (first 40s) ---
The opening hook text from the video intro...

--- OUTRO (last 30s) ---
The closing text from the video outro...
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

### get_audio

Extracts an audio clip from a YouTube video for speech or music analysis.

**Parameters:**
- `url` (required): YouTube video URL
- `startTime` (optional): Start time for the clip (default: "0")
  - Accepts seconds: "30", "90.5"
  - Accepts MM:SS format: "1:30"
  - Accepts HH:MM:SS format: "1:30:00"
- `endTime` (optional): End time for the clip. If not specified, extracts up to maxDuration from startTime
- `maxDuration` (optional): Maximum duration in seconds (default: 60, max: 120)

**Returns:** Base64-encoded MP3 audio (128kbps)

**Example Usage:**
- Extract first 30 seconds: `{ url: "...", maxDuration: 30 }`
- Extract 1:00-2:00: `{ url: "...", startTime: "1:00", endTime: "2:00" }`
- Extract chorus at 2:30: `{ url: "...", startTime: "2:30", maxDuration: 45 }`

**Use Cases:**
- Analyzing speech when transcript isn't available or is poor quality
- Analyzing music (instruments, mood, tempo)
- Extracting audio from non-English videos
- Getting audio context for specific moments in a video

**Note:** Requires ffmpeg. Audio is capped at 120 seconds to prevent excessive file sizes.

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

Features inspired by various YouTube MCP implementations. Items marked ✅ are now implemented.

### ✅ 4. URL Normalization (IMPLEMENTED)
All YouTube URL formats now supported: watch, youtu.be, shorts, live, embed, mobile, music.youtube.com, and direct video IDs.

### ✅ 6. Search Within Transcript (IMPLEMENTED)
Use `searchTerm` parameter to find and **highlight** matches with context lines.

### ✅ 7. Timestamped Transcript Output (IMPLEMENTED)
Use `includeTimestamps: true` to get `[M:SS]` prefixes on each line.

### ✅ Time Range Filtering (IMPLEMENTED)
Use `startTime` and `endTime` parameters to extract only a portion of the transcript.

### ✅ Key Segments Extraction (IMPLEMENTED)
Use `keySegmentsOnly: true` to get only the hook (first 40s) and outro (last 30s) for token optimization.

---

### Remaining Future Enhancements:

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

### 4. Analytics Tracking

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

### 5. Markdown Output Templates

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

### 6. MCP Resource URIs

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
- **Audio extraction** for speech/music analysis (max 120s)
- **Comments** via YouTube Data API v3

## Project Prompt for Claude Web UI

Use this prompt in a Claude Project to automatically leverage the MCP when YouTube URLs are shared:

```
You have access to the YouTube MCP server with 5 tools. Use them automatically when I share YouTube content.

## Tools Available

### get_video - Transcript & Metadata
Fetches video title, channel, duration, views, upload date, and English transcript.

**Parameters:**
- `url` (required) - Any YouTube URL format: watch, youtu.be, shorts, live, embed, mobile, or just video ID
- `includeTimestamps` - Add [M:SS] timestamps to each line (default: false)
- `startTime` / `endTime` - Extract only a time range (e.g., "1:00" to "3:00")
- `searchTerm` - Search transcript and return **highlighted** matches with context
- `keySegmentsOnly` - Return only hook (first 40s) + outro (last 30s) for token savings

### get_playlist - List Videos
Lists all videos in a playlist with titles, durations, and URLs.
- `url` (required) - Playlist URL
- `limit` - Max videos (default: 50, max: 200)

### get_comments - Video Comments
Fetches top comments with author, likes, and reply counts.
- `url` (required) - Video URL or ID
- `maxResults` - Number of comments (default: 25, max: 100)
- `order` - "relevance" (default) or "time"

### get_screenshot - Video Frame Capture
Captures a frame at any timestamp as an image.
- `url` (required) - Video URL
- `timestamp` - Time to capture (e.g., "30", "1:30", "1:30:00")

### get_audio - Audio Clip Extraction
Extracts audio clips (max 120s) for speech or music analysis.
- `url` (required) - Video URL
- `startTime` - Start time (default: "0")
- `endTime` - End time (optional, defaults to startTime + maxDuration)
- `maxDuration` - Max clip duration in seconds (default: 60, max: 120)

## Default Behavior

When I paste a YouTube URL:
1. Automatically fetch the transcript with get_video (don't ask permission)
2. Provide a summary (2-3 paragraphs), key takeaways, and notable quotes
3. For long videos (10+ min), consider using keySegmentsOnly=true first

## Advanced Usage Examples

- "Search for 'budget' in this video" → use searchTerm parameter
- "Get the transcript from 5:00 to 10:00" → use startTime/endTime
- "Show me a screenshot at 2:30" → use get_screenshot
- "What are people saying in the comments?" → use get_comments
- "Just give me the intro and conclusion" → use keySegmentsOnly=true
- "Get the transcript with timestamps" → use includeTimestamps=true
- "Let me hear the intro music" → use get_audio with maxDuration: 30
- "What does the speaker sound like at 5:00?" → use get_audio with startTime: "5:00"
```

## License

MIT
