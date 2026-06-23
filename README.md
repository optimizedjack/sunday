# ☀ Sunday

A personal AI brainstorming assistant. Runs locally on your machine, saves notes to Obsidian, and works as a creative collaborator with a point of view.

## ⚠ Disclaimer

Sunday is experimental software currently in active development. It is provided as-is, with no guarantees of stability, security, or fitness for any purpose.

By installing Sunday, you acknowledge that:
- This software may contain bugs or incomplete features
- You should **not** install this on a machine you rely on
- The author is not liable for any damage or data loss
- This is not production-ready software

## What it does

- Chat with a local Ollama model via a clean glass UI
- Four modes: **free**, **riff**, **stuck**, **critique** — each changes how the AI responds
- Auto-saves every conversation to your Obsidian vault as markdown
- **History panel** — browse and resume past sessions
- **Canvas view** — spatial layout of all saved notes with pan/zoom and connections
- **Gallery** — 3D carousel of saved notes

## Requirements

- Linux (Ubuntu/Debian recommended) or macOS
- [Obsidian](https://obsidian.md) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin enabled
- Node.js 18+ (setup script installs this if missing)
- [Ollama](https://ollama.com) (setup script installs this if missing)

## Quick start

```bash
curl -fsSL https://jaacck.me/sunday/setup.sh | bash
```

Then open `http://localhost:3000` in your browser.

## Manual setup

```bash
git clone https://github.com/optimizedjack/sunday.git
cd sunday
cp .env.example .env
# edit .env and add your OBSIDIAN_KEY
npm install
node server.js
```

## Configuration

All config lives in `.env`:

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_KEY` | *(required)* | API key from the Obsidian Local REST API plugin |
| `OBSIDIAN_URL` | `https://localhost:27124` | Obsidian REST API URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Model to use |
| `VAULT_FOLDER` | *(root)* | Subfolder in your vault to save notes |
| `PORT` | `3000` | Port to serve Sunday on |

## Getting your Obsidian API key

1. Open Obsidian
2. Settings → Community plugins → browse → search "Local REST API" → install & enable
3. In the plugin settings, copy the API key
4. Paste it into `.env` as `OBSIDIAN_KEY=...`

> Obsidian must be running for Sunday to save and load notes.

## Modes

| Mode | Behaviour |
|---|---|
| **free** | Default — open-ended creative conversation |
| **riff** | Takes your idea and runs with it in one committed direction |
| **stuck** | Asks one sharp reframing question to unlock a block |
| **critique** | Direct, specific critique with no softening |

## Running as a service (Linux)

The setup script can install a systemd service. To manage it manually:

```bash
sudo systemctl start sunday
sudo systemctl stop sunday
sudo systemctl status sunday
sudo journalctl -u sunday -f   # live logs
```

## Notes

- Conversations auto-save to Obsidian after every message
- Canvas layout persists in `localStorage`
- No data leaves your machine — everything runs locally

## License

MIT
