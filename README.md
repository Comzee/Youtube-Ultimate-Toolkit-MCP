# YouTube MCP

Enhanced Model Context Protocol (MCP) server for YouTube integration with Claude. Provides transcripts with metadata, playlist information, and multi-language support.

## Features

- **Combined Output**: Get video metadata + transcript in a single call
- **Multi-language**: Support for 20+ languages with fallback to auto-generated captions
- **Playlist Support**: List all videos in a playlist with durations and URLs
- **Language Detection**: Check available subtitle languages before requesting

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and in PATH

Install yt-dlp:
```bash
# Windows (winget)
winget install yt-dlp.yt-dlp

# macOS (homebrew)
brew install yt-dlp

# Linux
pip install yt-dlp
```

## Installation

```bash
git clone git@giteassh.samjesberg.com:Comzee/YoutubeMCP.git
cd YoutubeMCP
npm install
npm run build
```

## Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["C:\\Users\\comzee\\Apps\\YoutubeMCP\\dist\\index.js"]
    }
  }
}
```

## Tools

### get_video

Get a YouTube video's metadata and transcript in one call. Fetches metadata and subtitles in parallel for speed.

**Parameters:**
- `url` (required): YouTube video URL
- `language` (optional): Language code (default: "en")

**Returns:**
```
Title: Video Title Here
Channel: Channel Name
Duration: 12:34 | Views: 1,234,567 | Uploaded: 2024-01-15

---
Transcript:

The cleaned transcript text appears here...
```

**Example:**
```
Summarize this video: https://youtube.com/watch?v=...
```

### get_playlist

List all videos in a YouTube playlist.

**Parameters:**
- `url` (required): YouTube playlist URL
- `limit` (optional): Max videos to list (default: 50, max: 200)

### get_available_languages

Check what subtitle languages are available for a video.

**Parameters:**
- `url` (required): YouTube video URL

**Returns:** List of manual subtitles and auto-generated caption languages

## Development

```bash
# Build
npm run build

# Run directly
npm start

# Build and run
npm run dev
```

## How It Works

1. Uses yt-dlp to fetch metadata and subtitle files in parallel
2. Parses and cleans VTT content:
   - Removes timestamps and positioning metadata
   - Strips HTML-like tags
   - Deduplicates consecutive lines (VTT repeats for karaoke display)
3. Combines compact metadata header with clean transcript
4. Returns optimized output for LLM context windows

## License

MIT
