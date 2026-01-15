#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { rimraf } from "rimraf";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";

// Parse command line arguments
function parseArgs(): { remote: boolean; port: number } {
  const args = process.argv.slice(2);
  let remote = false;
  let port = 3010;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--remote") {
      remote = true;
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { remote, port };
}

// Helper to run yt-dlp and capture output
async function runYtDlp(args: string[], cwd?: string): Promise<string> {
  const startTime = Date.now();
  console.log(`yt-dlp starting: ${args.slice(0, 3).join(' ')}...`);

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      cwd,
      shell: false,  // Don't use shell - avoids URL character escaping issues
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      console.log(`yt-dlp finished in ${duration}ms, code: ${code}`);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`yt-dlp failed (code ${code}): ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      console.log(`yt-dlp spawn error: ${err.message}`);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

// Strip VTT formatting and return clean text
function stripVttContent(vttContent: string): string {
  if (!vttContent || vttContent.trim() === "") {
    return "";
  }

  const lines = vttContent.split("\n");
  if (lines.length < 4 || !lines[0].includes("WEBVTT")) {
    return "";
  }

  const contentLines = lines.slice(4);
  const textLines: string[] = [];

  for (const line of contentLines) {
    if (line.includes("-->")) continue;
    if (line.includes("align:") || line.includes("position:")) continue;
    if (line.trim() === "") continue;

    const cleanedLine = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
      .replace(/<\/?c>/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();

    if (cleanedLine !== "") {
      textLines.push(cleanedLine);
    }
  }

  // Deduplicate consecutive identical lines
  const uniqueLines: string[] = [];
  for (let i = 0; i < textLines.length; i++) {
    if (i === 0 || textLines[i] !== textLines[i - 1]) {
      uniqueLines.push(textLines[i]);
    }
  }

  return uniqueLines.join("\n");
}

// Parse and format compact metadata header
function formatCompactMetadata(json: string): string {
  const data = JSON.parse(json);

  const duration = data.duration || 0;
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = Math.floor(duration % 60);
  const durationFormatted = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;

  const viewCount = (data.view_count || 0).toLocaleString();
  const uploadDate = data.upload_date || "Unknown";
  // Format date from YYYYMMDD to YYYY-MM-DD
  const formattedDate = uploadDate.length === 8
    ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
    : uploadDate;

  return [
    `Title: ${data.title || "Unknown"}`,
    `Channel: ${data.channel || data.uploader || "Unknown"}`,
    `Duration: ${durationFormatted} | Views: ${viewCount} | Uploaded: ${formattedDate}`,
  ].join("\n");
}

// Parse playlist info
interface PlaylistVideo {
  index: number;
  title: string;
  url: string;
  duration: string;
}

function parsePlaylist(jsonLines: string): { title: string; channel: string; videos: PlaylistVideo[] } {
  const videos: PlaylistVideo[] = [];
  let playlistTitle = "";
  let playlistChannel = "";

  const lines = jsonLines.trim().split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);

      if (!playlistTitle && data.playlist_title) {
        playlistTitle = data.playlist_title;
      }
      if (!playlistChannel && (data.playlist_uploader || data.channel)) {
        playlistChannel = data.playlist_uploader || data.channel;
      }

      const duration = data.duration || 0;
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);

      videos.push({
        index: data.playlist_index || videos.length + 1,
        title: data.title || "Unknown",
        url: data.webpage_url || data.url || "",
        duration: `${minutes}:${seconds.toString().padStart(2, "0")}`,
      });
    } catch {
      // Skip malformed JSON lines
    }
  }

  return {
    title: playlistTitle || "Unknown Playlist",
    channel: playlistChannel || "Unknown",
    videos,
  };
}

function formatPlaylist(playlist: { title: string; channel: string; videos: PlaylistVideo[] }): string {
  const lines = [
    `Playlist: ${playlist.title}`,
    `Channel: ${playlist.channel}`,
    `Videos: ${playlist.videos.length}`,
    "",
  ];

  for (const video of playlist.videos) {
    lines.push(`${video.index}. ${video.title} (${video.duration})`);
    lines.push(`   ${video.url}`);
  }

  return lines.join("\n");
}

// Create and configure the MCP server with tools
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: "2.0.0",
  });

  // Tool: get_video - fetch metadata and transcript
  server.tool(
    "get_video",
    "Get a YouTube video's metadata and English transcript. " +
    "Returns title, channel, duration, views, upload date, followed by the full transcript. " +
    "Use this to summarize YouTube videos or extract key takeaways.",
    {
      url: z.string().describe("YouTube video URL"),
    },
    async ({ url }) => {
      const language = "en";
      console.log(`get_video: Starting for ${url}`);

      const tempDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}youtube-`);

      try {
        console.log("get_video: Running yt-dlp...");
        const startTime = Date.now();

        // Get metadata first (fast, ~1-2s)
        const metadataJson = await runYtDlp(["--dump-json", "--no-download", "--no-warnings", "--no-playlist", url]);
        console.log(`get_video: metadata fetched in ${Date.now() - startTime}ms`);

        // Then get subtitles (can fail, that's ok)
        // Use en.* to match en, en-US, en-GB, en-orig, etc.
        try {
          await runYtDlp([
            "--write-sub",
            "--write-auto-sub",
            "--sub-lang", "en.*",
            "--skip-download",
            "--sub-format", "vtt",
            "--no-warnings",
            "--no-playlist",
            "-o", "%(id)s.%(ext)s",
            url
          ], tempDir);
        } catch (subErr) {
          console.log(`get_video: subtitle fetch failed (continuing anyway): ${(subErr as Error).message}`);
        }
        console.log(`get_video: yt-dlp completed in ${Date.now() - startTime}ms`);

        // Format metadata header
        const metadataHeader = formatCompactMetadata(metadataJson);

        // Get transcript
        let transcript = "";
        const files = fs.readdirSync(tempDir);

        for (const file of files) {
          if (file.endsWith(".vtt")) {
            const fileContent = fs.readFileSync(path.join(tempDir, file), "utf8");
            const cleanedContent = stripVttContent(fileContent);
            if (cleanedContent) {
              transcript = cleanedContent;
              break;
            }
          }
        }

        if (!transcript) {
          console.log("get_video: No transcript found, returning result");
          return {
            content: [{
              type: "text" as const,
              text: `${metadataHeader}\n\n---\n\nNo English transcript available for this video.`
            }],
          };
        }

        console.log(`get_video: Success! Transcript length: ${transcript.length} chars`);
        return {
          content: [{
            type: "text" as const,
            text: `${metadataHeader}\n\n---\nTranscript:\n\n${transcript}`
          }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      } finally {
        rimraf.sync(tempDir);
      }
    }
  );

  // Tool: get_playlist - list videos in a playlist
  server.tool(
    "get_playlist",
    "Get information about a YouTube playlist including all video titles, " +
    "durations, and URLs. Useful for understanding playlist contents before " +
    "selecting specific videos to transcribe.",
    {
      url: z.string().describe("YouTube playlist URL"),
      limit: z.number().default(50).describe("Maximum number of videos to list (default: 50, max: 200)"),
    },
    async ({ url, limit }) => {
      try {
        const actualLimit = Math.min(limit, 200);
        const output = await runYtDlp([
          "--dump-json",
          "--flat-playlist",
          "--playlist-end", actualLimit.toString(),
          url
        ]);

        const playlist = parsePlaylist(output);
        return {
          content: [{ type: "text" as const, text: formatPlaylist(playlist) }],
        };
      } catch (err) {
        const error = err as Error;
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function runStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runRemoteServer(port: number) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));  // Required for OAuth token requests

  // CORS middleware - must be before other routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Session-Id');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    next();
  });

  // Trust proxy for correct protocol detection behind nginx
  app.set('trust proxy', true);

  // OAuth credentials from environment
  const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    console.error("Error: OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET environment variables are required for remote mode");
    process.exit(1);
  }

  // Store issued access tokens and authorization codes
  const validTokens = new Set<string>();
  const authCodes = new Map<string, { codeChallenge: string; codeChallengeMethod: string; clientId: string; redirectUri: string; expiresAt: number }>();

  // Generate a random token
  function generateToken(length: number = 64): string {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
  }

  // Verify PKCE code challenge
  function verifyCodeChallenge(codeVerifier: string, codeChallenge: string, method: string): boolean {
    if (method === 'S256') {
      const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      return hash === codeChallenge;
    } else if (method === 'plain') {
      return codeVerifier === codeChallenge;
    }
    return false;
  }

  // Helper to get base URL
  const getBaseUrl = (req: Request): string => {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    return `${proto}://${req.get('host')}`;
  };

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    console.log("OAuth metadata discovery request");

    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      scopes_supported: ["mcp"]
    });
  });

  // Protected Resource Metadata (draft-ietf-oauth-resource-metadata)
  app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    console.log("Protected resource metadata request");

    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"]
    });
  });

  // Dynamic Client Registration endpoint (RFC 7591)
  app.post("/register", (req: Request, res: Response) => {
    console.log("Dynamic client registration request");
    const body = req.body || {};

    res.status(201).json({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris || ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "mcp"
    });
  });

  // OAuth Authorization endpoint - shows consent page
  app.get("/authorize", (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state
    } = req.query;

    console.log("OAuth authorize request received");
    console.log("  client_id:", client_id);
    console.log("  redirect_uri:", redirect_uri);

    // Validate required parameters
    if (response_type !== 'code') {
      res.status(400).send(renderErrorPage("Unsupported response type"));
      return;
    }

    if (client_id !== OAUTH_CLIENT_ID) {
      res.status(400).send(renderErrorPage("Invalid client"));
      return;
    }

    if (!redirect_uri || !code_challenge) {
      res.status(400).send(renderErrorPage("Missing required parameters"));
      return;
    }

    // Build approval URL with all parameters
    const baseUrl = getBaseUrl(req);
    const approveUrl = new URL(`${baseUrl}/authorize/approve`);
    approveUrl.searchParams.set('client_id', client_id as string);
    approveUrl.searchParams.set('redirect_uri', redirect_uri as string);
    approveUrl.searchParams.set('code_challenge', code_challenge as string);
    approveUrl.searchParams.set('code_challenge_method', (code_challenge_method as string) || 'S256');
    if (state) approveUrl.searchParams.set('state', state as string);

    // Show consent page
    res.status(200).send(renderConsentPage(approveUrl.toString()));
  });

  // OAuth Approval endpoint - generates code and redirects
  app.get("/authorize/approve", (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state
    } = req.query;

    console.log("OAuth approval - generating authorization code");

    if (!client_id || !redirect_uri || !code_challenge) {
      res.status(400).send(renderErrorPage("Missing parameters"));
      return;
    }

    // Generate authorization code
    const authCode = generateToken(32);

    // Store the code with its challenge for later verification
    authCodes.set(authCode, {
      codeChallenge: code_challenge as string,
      codeChallengeMethod: (code_challenge_method as string) || 'S256',
      clientId: client_id as string,
      redirectUri: redirect_uri as string,
      expiresAt: Date.now() + 600000 // 10 minutes
    });

    console.log("Authorization code issued, redirecting to:", redirect_uri);

    // Redirect back to Claude with the authorization code
    const redirectUrl = new URL(redirect_uri as string);
    redirectUrl.searchParams.set('code', authCode);
    if (state) {
      redirectUrl.searchParams.set('state', state as string);
    }

    res.redirect(redirectUrl.toString());
  });

  // Helper to render consent page HTML
  function renderConsentPage(approveUrl: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Authorize YouTube MCP</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center; min-height: 100vh;
           margin: 0; background: #1a1a2e; color: #eee; }
    .container { background: #16213e; padding: 2rem; border-radius: 12px;
                 max-width: 400px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    h1 { margin-top: 0; color: #fff; }
    p { color: #aaa; line-height: 1.6; }
    .btn { display: inline-block; background: #e94560; color: white; padding: 12px 32px;
           border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 1rem;
           transition: background 0.2s; }
    .btn:hover { background: #ff6b6b; }
    .scope { background: #0f3460; padding: 0.5rem 1rem; border-radius: 4px;
             display: inline-block; margin: 0.5rem 0.25rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>YouTube MCP Server</h1>
    <p>Claude wants to access your YouTube MCP tools:</p>
    <div>
      <span class="scope">get_video</span>
      <span class="scope">get_playlist</span>
    </div>
    <p>Click Authorize to allow access.</p>
    <a href="${approveUrl}" class="btn">Authorize</a>
  </div>
</body>
</html>`;
  }

  // Helper to render error page HTML
  function renderErrorPage(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Error</title>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { background: #16213e; padding: 2rem; border-radius: 12px; text-align: center; }
    h1 { color: #e94560; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Error</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  }

  // Helper to get client credentials from request (supports both Basic auth and POST body)
  function getClientCredentials(req: Request): { clientId: string | undefined, clientSecret: string | undefined } {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      const base64 = authHeader.slice(6);
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      const [clientId, clientSecret] = decoded.split(':');
      return { clientId, clientSecret };
    }
    return {
      clientId: req.body?.client_id,
      clientSecret: req.body?.client_secret
    };
  }

  // OAuth Token endpoint - handles both authorization_code and refresh_token grants
  app.post("/token", (req: Request, res: Response) => {
    const { grant_type, code, code_verifier, refresh_token } = req.body;
    const { clientId: client_id, clientSecret: client_secret } = getClientCredentials(req);

    console.log("OAuth token request received, grant_type:", grant_type);
    console.log("  client_id:", client_id);

    // Handle refresh token grant
    if (grant_type === "refresh_token") {
      if (!refresh_token || !validTokens.has(refresh_token)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }

      const newAccessToken = generateToken(64);
      const newRefreshToken = generateToken(64);
      validTokens.add(newAccessToken);
      validTokens.add(newRefreshToken);

      console.log("Token refreshed successfully");

      res.json({
        access_token: newAccessToken,
        token_type: "Bearer",
        expires_in: 86400,
        refresh_token: newRefreshToken,
        scope: "mcp"
      });
      return;
    }

    // Handle authorization code grant
    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    // Look up the authorization code
    const authData = authCodes.get(code);
    if (!authData) {
      console.log("Invalid authorization code");
      res.status(400).json({ error: "invalid_grant", error_description: "Invalid authorization code" });
      return;
    }

    // Check expiration
    if (Date.now() > authData.expiresAt) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code expired" });
      return;
    }

    // Verify client
    if (client_id !== OAUTH_CLIENT_ID) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    // Verify client secret if provided
    if (client_secret && client_secret !== OAUTH_CLIENT_SECRET) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    // Verify PKCE code verifier
    if (!code_verifier || !verifyCodeChallenge(code_verifier, authData.codeChallenge, authData.codeChallengeMethod)) {
      console.log("PKCE verification failed");
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    // Delete the used authorization code
    authCodes.delete(code);

    // Generate access token and refresh token
    const accessToken = generateToken(64);
    const refreshToken = generateToken(64);
    validTokens.add(accessToken);
    validTokens.add(refreshToken);

    console.log("Access token issued successfully");

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
      refresh_token: refreshToken,
      scope: "mcp"
    });
  });

  // Auth middleware for MCP endpoint
  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    // Allow handshake methods without auth - auth happens on actual tool calls
    const method = req.body?.method;
    const allowedMethods = ["initialize", "ping", "notifications/initialized", "tools/list", "prompts/list", "resources/list"];
    if (allowedMethods.includes(method)) {
      console.log("Allowing unauthenticated:", method);
      next();
      return;
    }

    // Also allow GET requests (SSE setup)
    if (req.method === "GET") {
      console.log("Allowing unauthenticated GET");
      next();
      return;
    }

    if (!token || !validTokens.has(token)) {
      console.log("Unauthorized request:", req.method, req.path);
      console.log("  Headers:", JSON.stringify({
        authorization: authHeader ? "Bearer ..." : undefined,
        origin: req.headers.origin,
        "content-type": req.headers["content-type"]
      }));
      if (req.body && Object.keys(req.body).length > 0) {
        console.log("  Body:", JSON.stringify(req.body).slice(0, 200));
      }
      const baseUrl = getBaseUrl(req);
      // Include resource_metadata per MCP spec so client knows where to find OAuth info
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", version: "2.0.0", transport: "streamable-http" });
  });

  // Store sessions: sessionId -> { server, transport }
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  // MCP endpoint using Streamable HTTP transport (stateful mode with sessions)
  app.all("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.log(`MCP request: ${req.method} from ${req.ip}, session: ${sessionId || "new"}`);

    // Handle GET requests for SSE stream
    if (req.method === "GET") {
      console.log("GET /mcp - SSE stream requested");

      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: "Invalid or missing session ID" });
        return;
      }

      const session = sessions.get(sessionId)!;

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Handle the SSE request through the transport
      try {
        await session.transport.handleRequest(req, res);
      } catch (error) {
        console.error("Error handling SSE request:", error);
      }
      return;
    }

    // Handle DELETE for session termination
    if (req.method === "DELETE") {
      console.log("DELETE /mcp - Session termination requested");
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.close();
        sessions.delete(sessionId);
        console.log(`Session ${sessionId} terminated`);
      }
      res.status(200).json({ status: "session terminated" });
      return;
    }

    // Handle POST requests (main MCP communication)
    if (req.method === "POST") {
      try {
        console.log("POST /mcp - Message received:", JSON.stringify(req.body).slice(0, 200));

        let session = sessionId ? sessions.get(sessionId) : undefined;

        // Check if this is an initialize request (new session)
        const isInitialize = req.body?.method === "initialize";

        if (!session) {
          if (!isInitialize && sessionId) {
            // Session not found but client expects one
            console.log(`Session ${sessionId} not found`);
            res.status(404).json({ error: "Session not found" });
            return;
          }

          // Create new session
          console.log("Creating new session...");
          const server = createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });

          await server.connect(transport);

          // Store session after we get the session ID from the response
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && sessions.has(sid)) {
              console.log(`Transport closed, removing session ${sid}`);
              sessions.delete(sid);
            }
          };

          session = { server, transport };

          // Handle the request - this will generate the session ID
          await transport.handleRequest(req, res, req.body);

          // Store the session with the generated ID
          const newSessionId = transport.sessionId;
          if (newSessionId) {
            sessions.set(newSessionId, session);
            console.log(`New session created: ${newSessionId}`);
          }
        } else {
          // Existing session - handle the request
          await session.transport.handleRequest(req, res, req.body);
        }

        console.log("MCP request handled successfully");
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
      return;
    }

    // Method not allowed
    res.status(405).json({ error: "Method not allowed" });
  });

  app.listen(port, () => {
    console.log(`YouTube MCP server running in remote mode on port ${port}`);
    console.log(`Transport: Streamable HTTP (2025-03-26 spec)`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`OAuth endpoints:`);
    console.log(`  - Metadata: http://localhost:${port}/.well-known/oauth-authorization-server`);
    console.log(`  - Authorize: http://localhost:${port}/authorize`);
    console.log(`  - Token: http://localhost:${port}/token`);
  });
}

async function main() {
  const { remote, port } = parseArgs();

  if (remote) {
    await runRemoteServer(port);
  } else {
    await runStdioServer();
  }
}

main().catch(console.error);
