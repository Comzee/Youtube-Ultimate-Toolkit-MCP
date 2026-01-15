# Next Session: Enable OAuth Authentication

## Current State

The YouTube MCP server is **fully functional** with Streamable HTTP transport. OAuth is **implemented but bypassed** for testing.

## What Works

1. **Streamable HTTP Transport** (MCP spec 2025-03-26) - the modern standard, replaces deprecated SSE
2. **Stateful session management** with UUID session IDs
3. **Tools**: `get_video` (metadata + English transcript), `get_playlist`
4. **Systemd service** running on port 3010
5. **Nginx reverse proxy** at `youtubetools.samjesberg.com`
6. **Claude Web UI integration** - tested and working

## What Needs To Be Done

Enable OAuth authentication. The code is already written, just bypassed.

### Location of Auth Bypass

In `src/index.ts` around line 620-640, the `authMiddleware` function:

```typescript
const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace("Bearer ", "");

  if (!token || !validTokens.has(token)) {
    // TEMPORARY: Skip auth to test if MCP works
    console.log("Auth bypassed for testing - request to:", req.path);
    next();
    return;

    // Uncomment below to enable auth:
    // console.log("Unauthorized request to:", req.path);
    // const baseUrl = getBaseUrl(req);
    // res.setHeader('WWW-Authenticate', `Bearer realm="${baseUrl}", error="invalid_token"`);
    // res.status(401).json({ error: "unauthorized" });
    // return;
  }
  next();
};
```

### To Enable OAuth

1. Remove/comment out the bypass block (lines with `next(); return;`)
2. Uncomment the authorization enforcement block
3. Test the full OAuth flow with Claude Web UI

### OAuth Flow Already Implemented

The server already has:

- `/.well-known/oauth-authorization-server` - OAuth metadata discovery (RFC 8414)
- `/.well-known/oauth-protected-resource` - Protected resource metadata
- `/register` - Dynamic Client Registration (RFC 7591)
- `/authorize` - Authorization endpoint (Authorization Code + PKCE)
- `/token` - Token endpoint (handles auth code exchange and refresh)

### OAuth Credentials

Stored in `.env`:
```
OAUTH_CLIENT_ID=youtube-mcp-client
OAUTH_CLIENT_SECRET=<generated-secret>
```

### Claude's OAuth Callback

Claude Web UI uses: `https://claude.ai/api/mcp/auth_callback`

### Key MCP OAuth Specs Referenced

- MCP Authorization Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- Claude supports both 3/26 and 6/18 auth specs
- PKCE is required for all clients
- Dynamic Client Registration is supported

## Testing OAuth

1. Enable auth in the code
2. Rebuild: `npm run build`
3. Restart: `sudo systemctl restart youtube-mcp`
4. In Claude Web UI, disconnect and reconnect the MCP
5. Should trigger OAuth flow - browser opens for authorization
6. After auth, tools should work as before

## Potential Issues to Watch For

1. **Redirect URI validation** - ensure it matches Claude's callback URL
2. **Token expiration** - currently set to 86400 seconds (24 hours)
3. **PKCE verification** - using S256 and plain methods
4. **Session/token storage** - currently in-memory (lost on restart)

## Files to Review

- `src/index.ts` - Main server code, OAuth implementation starts around line 400
- `.env` - OAuth credentials
- `.env.example` - Template for credentials

## Commands

```bash
# Build
cd /home/comzee/Apps/YoutubeMCP
npm run build

# Restart service
sudo systemctl restart youtube-mcp

# Watch logs
sudo journalctl -u youtube-mcp -f

# Check service status
sudo systemctl status youtube-mcp
```
