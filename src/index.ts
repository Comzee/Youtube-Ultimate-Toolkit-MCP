#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { rimraf } from "rimraf";
import express, { Request, Response, NextFunction } from "express";

// Parse command line arguments
function parseArgs(): { remote: boolean; port: number } {
  const args = process.argv.slice(2);
  let remote = false;
  let port = 3000;

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

const server = new Server(
  {
    name: "youtube-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to run yt-dlp and capture output
async function runYtDlp(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      cwd,
      shell: true,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`yt-dlp failed (code ${code}): ${stderr}`));
      }
    });

    proc.on("error", (err) => {
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

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_video",
        description:
          "Get a YouTube video's metadata and transcript in one call. " +
          "Returns title, channel, duration, views, upload date, followed by the full transcript. " +
          "Supports multiple languages. Use this for summarization or analysis of YouTube content.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "YouTube video URL"
            },
            language: {
              type: "string",
              description: "Subtitle language code (e.g., 'en', 'es', 'fr', 'de', 'ja'). Defaults to 'en'",
              default: "en"
            },
          },
          required: ["url"],
        },
      },
      {
        name: "get_playlist",
        description:
          "Get information about a YouTube playlist including all video titles, " +
          "durations, and URLs. Useful for understanding playlist contents before " +
          "selecting specific videos to transcribe.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "YouTube playlist URL"
            },
            limit: {
              type: "number",
              description: "Maximum number of videos to list (default: 50, max: 200)",
              default: 50
            },
          },
          required: ["url"],
        },
      },
      {
        name: "get_available_languages",
        description:
          "List available subtitle languages for a YouTube video. " +
          "Useful for checking what languages are available before requesting a transcript.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "YouTube video URL"
            },
          },
          required: ["url"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments as Record<string, unknown>;

  try {
    switch (name) {
      case "get_video": {
        const url = args.url as string;
        const language = (args.language as string) || "en";

        // Fetch metadata and subtitles in parallel
        const tempDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}youtube-`);

        try {
          const [metadataJson] = await Promise.all([
            runYtDlp(["--dump-json", "--no-download", url]),
            runYtDlp([
              "--write-sub",
              "--write-auto-sub",
              "--sub-lang", language,
              "--skip-download",
              "--sub-format", "vtt",
              "-o", "%(id)s.%(ext)s",
              url
            ], tempDir)
          ]);

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
            return {
              content: [{
                type: "text",
                text: `${metadataHeader}\n\n---\n\nNo subtitles found for language '${language}'. Try 'get_available_languages' to see what's available.`
              }],
            };
          }

          return {
            content: [{
              type: "text",
              text: `${metadataHeader}\n\n---\nTranscript:\n\n${transcript}`
            }],
          };
        } finally {
          rimraf.sync(tempDir);
        }
      }

      case "get_playlist": {
        const url = args.url as string;
        const limit = Math.min((args.limit as number) || 50, 200);

        const output = await runYtDlp([
          "--dump-json",
          "--flat-playlist",
          "--playlist-end", limit.toString(),
          url
        ]);

        const playlist = parsePlaylist(output);
        return {
          content: [{ type: "text", text: formatPlaylist(playlist) }],
        };
      }

      case "get_available_languages": {
        const url = args.url as string;

        const output = await runYtDlp([
          "--list-subs",
          "--skip-download",
          url
        ]);

        const lines = output.split("\n");
        const manualSubs: string[] = [];
        const autoSubs: string[] = [];
        let inManual = false;
        let inAuto = false;

        for (const line of lines) {
          if (line.includes("Available subtitles")) {
            inManual = true;
            inAuto = false;
            continue;
          }
          if (line.includes("Available automatic captions")) {
            inManual = false;
            inAuto = true;
            continue;
          }

          const match = line.match(/^([a-z]{2}(-[a-zA-Z]+)?)\s+/);
          if (match) {
            const lang = match[1];
            if (inManual) manualSubs.push(lang);
            else if (inAuto) autoSubs.push(lang);
          }
        }

        let result = "Available Subtitles:\n\n";

        if (manualSubs.length > 0) {
          result += "Manual: " + manualSubs.join(", ") + "\n\n";
        } else {
          result += "No manual subtitles.\n\n";
        }

        if (autoSubs.length > 0) {
          result += "Auto-generated: " + autoSubs.join(", ");
        } else {
          result += "No auto-generated captions.";
        }

        return {
          content: [{ type: "text", text: result }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const error = err as Error;
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`
      }],
      isError: true,
    };
  }
});

async function runStdioServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runRemoteServer(port: number) {
  const app = express();

  // OAuth credentials from environment
  const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    console.error("Error: OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET environment variables are required for remote mode");
    process.exit(1);
  }

  // Store issued access tokens (in production, use Redis or similar)
  const validTokens = new Set<string>();

  // Generate a random token
  function generateToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 64; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  // Store active transports for message routing
  const transports = new Map<string, SSEServerTransport>();

  // Parse JSON and URL-encoded bodies
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // OAuth token endpoint - no auth required
  app.post("/oauth/token", (req: Request, res: Response) => {
    const { client_id, client_secret, grant_type } = req.body;

    // Support both form-encoded and JSON
    const clientId = client_id || req.body.clientId;
    const clientSecret = client_secret || req.body.clientSecret;

    if (grant_type && grant_type !== "client_credentials") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    if (clientId !== OAUTH_CLIENT_ID || clientSecret !== OAUTH_CLIENT_SECRET) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    const accessToken = generateToken();
    validTokens.add(accessToken);

    console.log("OAuth token issued");

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400 // 24 hours (tokens don't actually expire in this simple impl)
    });
  });

  // Auth middleware - skip for OAuth token endpoint
  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth for token endpoint
    if (req.path === "/oauth/token") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!token || !validTokens.has(token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  // Apply auth middleware
  app.use(authMiddleware);

  // SSE endpoint - client connects here to receive messages
  app.get("/sse", async (req: Request, res: Response) => {
    console.log("SSE connection established");

    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    res.on("close", () => {
      console.log(`SSE connection closed: ${sessionId}`);
      transports.delete(sessionId);
    });

    await server.connect(transport);
  });

  // Messages endpoint - client sends messages here
  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId query parameter" });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error handling message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", version: "1.2.0" });
  });

  app.listen(port, () => {
    console.log(`YouTube MCP server running in remote mode on port ${port}`);
    console.log(`OAuth token endpoint: http://localhost:${port}/oauth/token`);
    console.log(`SSE endpoint: http://localhost:${port}/sse`);
    console.log(`Messages endpoint: http://localhost:${port}/messages`);
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
