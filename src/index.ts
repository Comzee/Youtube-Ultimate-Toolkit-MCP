#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { rimraf } from "rimraf";

const server = new Server(
  {
    name: "youtube-mcp",
    version: "1.0.0",
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
    // Skip timestamp lines
    if (line.includes("-->")) continue;
    // Skip positioning metadata
    if (line.includes("align:") || line.includes("position:")) continue;
    // Skip empty lines
    if (line.trim() === "") continue;

    // Remove inline timestamps and tags
    const cleanedLine = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
      .replace(/<\/?c>/g, "")
      .replace(/<[^>]+>/g, "") // Remove any other HTML-like tags
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

// Parse yt-dlp JSON output for metadata
interface VideoMetadata {
  title: string;
  channel: string;
  channelId: string;
  duration: number;
  durationFormatted: string;
  viewCount: number;
  uploadDate: string;
  description: string;
  tags: string[];
  categories: string[];
  thumbnailUrl: string;
  url: string;
}

function parseMetadata(json: string): VideoMetadata {
  const data = JSON.parse(json);

  const duration = data.duration || 0;
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = Math.floor(duration % 60);
  const durationFormatted = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;

  return {
    title: data.title || "Unknown",
    channel: data.channel || data.uploader || "Unknown",
    channelId: data.channel_id || "",
    duration,
    durationFormatted,
    viewCount: data.view_count || 0,
    uploadDate: data.upload_date || "",
    description: data.description || "",
    tags: data.tags || [],
    categories: data.categories || [],
    thumbnailUrl: data.thumbnail || "",
    url: data.webpage_url || data.url || "",
  };
}

// Format metadata for display
function formatMetadata(meta: VideoMetadata): string {
  const lines = [
    `Title: ${meta.title}`,
    `Channel: ${meta.channel}`,
    `Duration: ${meta.durationFormatted}`,
    `Views: ${meta.viewCount.toLocaleString()}`,
    `Upload Date: ${meta.uploadDate}`,
    `URL: ${meta.url}`,
    "",
    "Description:",
    meta.description,
  ];

  if (meta.tags.length > 0) {
    lines.push("", `Tags: ${meta.tags.join(", ")}`);
  }

  return lines.join("\n");
}

// Parse playlist info
interface PlaylistInfo {
  title: string;
  channel: string;
  videoCount: number;
  videos: Array<{
    index: number;
    title: string;
    url: string;
    duration: string;
  }>;
}

function parsePlaylist(jsonLines: string): PlaylistInfo {
  const videos: PlaylistInfo["videos"] = [];
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
    videoCount: videos.length,
    videos,
  };
}

function formatPlaylist(playlist: PlaylistInfo): string {
  const lines = [
    `Playlist: ${playlist.title}`,
    `Channel: ${playlist.channel}`,
    `Videos: ${playlist.videoCount}`,
    "",
    "Contents:",
  ];

  for (const video of playlist.videos) {
    lines.push(`${video.index}. ${video.title} (${video.duration})`);
    lines.push(`   ${video.url}`);
  }

  return lines.join("\n");
}

// Available languages for subtitles
const COMMON_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh",
  "ar", "hi", "nl", "pl", "tr", "vi", "th", "id", "sv", "da"
];

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_transcript",
        description:
          "Download and return cleaned transcript/subtitles from a YouTube video. " +
          "Supports multiple languages and falls back to auto-generated captions. " +
          "Use this tool to read YouTube video content for summarization or analysis.",
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
        name: "get_video_metadata",
        description:
          "Get metadata about a YouTube video including title, channel, duration, " +
          "view count, upload date, description, and tags. Does not download the video.",
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
      case "get_transcript": {
        const url = args.url as string;
        const language = (args.language as string) || "en";

        const tempDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}youtube-`);

        try {
          // Try manual subtitles first, then auto-generated
          await runYtDlp([
            "--write-sub",
            "--write-auto-sub",
            "--sub-lang", language,
            "--skip-download",
            "--sub-format", "vtt",
            "-o", "%(id)s.%(ext)s",
            url
          ], tempDir);

          let content = "";
          const files = fs.readdirSync(tempDir);

          for (const file of files) {
            if (file.endsWith(".vtt")) {
              const fileContent = fs.readFileSync(path.join(tempDir, file), "utf8");
              const cleanedContent = stripVttContent(fileContent);
              if (cleanedContent) {
                content = cleanedContent;
                break; // Use first valid subtitle file
              }
            }
          }

          if (!content) {
            return {
              content: [{
                type: "text",
                text: `No subtitles found for language '${language}'. Try 'get_available_languages' to see what's available.`
              }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: content }],
          };
        } finally {
          rimraf.sync(tempDir);
        }
      }

      case "get_video_metadata": {
        const url = args.url as string;

        const output = await runYtDlp([
          "--dump-json",
          "--no-download",
          url
        ]);

        const metadata = parseMetadata(output);
        return {
          content: [{ type: "text", text: formatMetadata(metadata) }],
        };
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

        // Parse the output to extract available languages
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

          // Language lines typically start with a language code
          const match = line.match(/^([a-z]{2}(-[a-zA-Z]+)?)\s+/);
          if (match) {
            const lang = match[1];
            if (inManual) manualSubs.push(lang);
            else if (inAuto) autoSubs.push(lang);
          }
        }

        let result = "Available Subtitles:\n\n";

        if (manualSubs.length > 0) {
          result += "Manual subtitles:\n";
          result += manualSubs.join(", ") + "\n\n";
        } else {
          result += "No manual subtitles available.\n\n";
        }

        if (autoSubs.length > 0) {
          result += "Auto-generated captions:\n";
          result += autoSubs.join(", ");
        } else {
          result += "No auto-generated captions available.";
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

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
