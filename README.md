# ☀ Sunday - Beta v.0.3 release

A local-first personal AI brainstorming assistant. Runs entirely on your machine, saves notes to Obsidian, and works as a creative collaborator with a point of view.

## ⚠ Disclaimer

Sunday is experimental software in active development. It is provided as-is with no guarantees of stability, security, or fitness for any purpose. Do not install it on a machine you rely on.

## What it does

- Chat with any local Ollama model via a clean glass UI
- **Four built-in modes** — free, riff, stuck, critique — each changes how the AI responds
- **Skills** — define your own modes as markdown files in your Obsidian vault
- **Model switching** — swap between any pulled Ollama model mid-conversation
- **Pull models** — browse and download new Ollama models directly from the UI
- **Past context** — recent notes are loaded as memory on every message
- **Stop generation** — cancel a response mid-stream at any time
- **Full-text search** — search across all saved notes from the history panel
- **History panel** — browse, resume, rename, and delete past sessions
- **Canvas view** — spatial layout of all saved notes with pan/zoom and connections
- **Gallery** — 3D carousel of saved notes
- Auto-saves every conversation to your Obsidian vault as markdown

## Requirements

- Linux (Ubuntu/Debian) or macOS
- [Obsidian](https://obsidian.md) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin enabled
- Node.js 18+
- [Ollama](https://ollama.com)

## Quick start

```bash
curl -fsSL https://jaacck.me/sunday/setup.sh | bash
```

Then open `http://localhost:3000`.

## Manual setup

```bash
git clone https://github.com/optimizedjack/sunday.git
cd sunday
cp .env.example .env
# Edit .env and set OBSIDIAN_KEY
npm install
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js -o marked.min.js
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js -o purify.min.js
node server.js
```

## Configuration

Edit `.env` (copied from `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_KEY` | *(required)* | API key from the Obsidian Local REST API plugin |
| `OBSIDIAN_URL` | `https://localhost:27124` | Obsidian REST API URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Default model |
| `VAULT_FOLDER` | *(root)* | Vault subfolder for saved notes |
| `SKILLS_FOLDER` | `Sunday/Skills` | Vault folder for skill definitions |
| `PORT` | `3000` | Port to serve Sunday on |
| `HOST` | `0.0.0.0` | Interface to bind to |

## Getting your Obsidian API key

1. Open Obsidian → Settings → Community plugins → browse → search **Local REST API** → install and enable
2. In the plugin settings, copy the API key
3. Paste it into `.env` as `OBSIDIAN_KEY=...`

Obsidian must be running for Sunday to save and load notes.

## Modes

| Mode | Behaviour |
|---|---|
| **free** | Open-ended creative conversation |
| **riff** | Takes your idea and runs with it in one committed direction |
| **stuck** | Asks one sharp reframing question to unlock a block |
| **critique** | Direct, specific critique with no softening |

## Skills

Create `.md` files in your vault under `Sunday/Skills/` (configurable via `SKILLS_FOLDER`). Each file needs this frontmatter:

```markdown
---
name: Debate
prompt: Take the opposing position on everything the user says. Steel-man it fully.
description: Argues against you
---
```

Skills appear as extra mode pills in the input bar. Edit or add them in Obsidian — no restart needed.

## Running as a service (Linux)

```bash
sudo systemctl start sunday
sudo systemctl stop sunday
sudo systemctl status sunday
sudo journalctl -u sunday -f
```

The setup script can install this automatically.

## Notes

- Conversations auto-save to Obsidian after every message
- Recent notes are loaded as context on startup and refreshed after each save
- Canvas layout persists in `localStorage`
- `marked.min.js` and `purify.min.js` are downloaded by setup.sh and gitignored
- No data leaves your machine — everything runs on localhost

## License

MIT
