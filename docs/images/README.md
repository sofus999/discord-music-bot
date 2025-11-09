# Documentation Images

This directory contains screenshots used in the main README.md documentation.

## Required Screenshots

### 1. bot-working.png
**Description:** Screenshot showing the bot working successfully with music playing

**What to capture:**
- Discord channel with bot's "Now Playing" embed
- Shows:
  - Song title and artist
  - Duration and progress bar
  - Auto-play status (ON)
  - Interactive seek buttons (-30s, -10s, +10s, +30s)
  - Queue information showing next song
  - Volume indicator

**Example from your screenshots:**
```
Your first screenshot showing:
"Auto-play - Now Playing"
"Sad Night Dynamite - Icy Violence (Official Music Video)"
Duration: 05:20
Progress bar at 0:00/5:20
Queue: 1 songs | Auto-play: ON | 1 dag kl. 12:35
Seek buttons: ⏮️ -30s | ⏪ -10s | ⏩ +10s | ⏭️ +30s
Added to Queue: "Sad Night Dynamite - Krunk (Official Audio)"
```

### 2. ffmpeg-error.png
**Description:** Screenshot showing the FFMPEG error that occurs when native modules aren't rebuilt

**What to capture:**
- Discord channel showing error message from bot
- Error text:
  ```
  ❌ Could not play the song. ffmpeg is not installed at 'ffmpeg' path
  ```

**Example from your screenshots:**
```
Your second screenshot showing:
"sofus999. used 🎵 play"
"Micasso Mozart APP Yesterday at 11:44 PM"
"❌ Could not play the song. ffmpeg is not installed at 'ffmpeg' path"
```

## How to Add Screenshots

1. Take the screenshots in Discord (as shown above)
2. Save them in this directory with the exact filenames:
   - `bot-working.png`
   - `ffmpeg-error.png`
3. The README.md will automatically display them

## Image Guidelines

- **Format:** PNG (preferred) or JPG
- **Size:** Optimal width 600-800px (Discord screenshots are usually good as-is)
- **Quality:** Clear text, readable at normal viewing size
- **Dark/Light Mode:** Dark mode screenshots are fine (most Discord users use dark mode)

## Alternative: Using Your Screenshots

If you have these screenshots saved elsewhere:

```powershell
# Copy your screenshots to this directory
copy path\to\your\screenshot1.png docs\images\bot-working.png
copy path\to\your\screenshot2.png docs\images\ffmpeg-error.png
```

Or just drag and drop them into this folder via File Explorer.

