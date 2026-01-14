# YouTube MCP

Enhanced Model Context Protocol (MCP) server for YouTube integration with Claude. Provides transcripts, video metadata, playlist information, and multi-language support.

## Features

- **Transcripts**: Download and clean subtitles/captions from any YouTube video
- **Multi-language**: Support for 20+ languages with fallback to auto-generated captions
- **Video Metadata**: Get title, channel, duration, views, description, tags
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

Or if published to npm:
```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "youtube-mcp"]
    }
  }
}
```

## Tools

### get_transcript

Download cleaned transcript from a YouTube video.

**Parameters:**
- `url` (required): YouTube video URL
- `language` (optional): Language code (default: "en")

**Example:**
```
Get the transcript of https://youtube.com/watch?v=...
```

### get_video_metadata

Get video information without downloading.

**Parameters:**
- `url` (required): YouTube video URL

**Returns:** Title, channel, duration, view count, upload date, description, tags

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

1. Uses yt-dlp to fetch subtitle files in VTT format
2. Parses and cleans VTT content:
   - Removes timestamps and positioning metadata
   - Strips HTML-like tags
   - Deduplicates consecutive lines (VTT repeats for karaoke display)
3. Returns clean, readable text optimized for LLM context windows

## License

MIT
