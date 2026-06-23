#!/usr/bin/env bash
#cURL command is inside of README.md
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}  ☀  Sunday — setup${RESET}"
echo "  ─────────────────────────────────"
echo ""

# ── Disclaimer ───────────────────────────────────────────
echo -e "${RED}${BOLD}  ⚠  DISCLAIMER${RESET}"
echo ""
echo -e "  Sunday is experimental software, currently in active development."
echo -e "  It is provided as-is, with no guarantees of stability, security,"
echo -e "  or fitness for any purpose."
echo ""
echo -e "  By continuing, you acknowledge that:"
echo -e "  • This software may contain bugs or incomplete features"
echo -e "  • You should ${BOLD}not${RESET} install this on a machine you rely on"
echo -e "  • The author is not liable for any damage or data loss"
echo -e "  • This is not production-ready software"
echo ""
read -p "  Do you understand and wish to continue? [y/N] " DISCLAIMER
if [[ ! "$DISCLAIMER" =~ ^[Yy]$ ]]; then
  echo ""
  echo -e "  Installation cancelled."
  echo ""
  exit 0
fi

echo ""

# ── Git ──────────────────────────────────────────────────
if ! command -v git &> /dev/null; then
  echo -e "${YELLOW}→ Git is not installed. It is required to clone Sunday.${RESET}"
  read -p "  Install Git now? [y/N] " INSTALL_GIT
  if [[ "$INSTALL_GIT" =~ ^[Yy]$ ]]; then
    sudo apt-get update -qq && sudo apt-get install -y git
    echo -e "${GREEN}✓ Git installed${RESET}"
  else
    echo -e "${RED}✗ Git is required. Exiting.${RESET}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Git found${RESET}"
fi

# ── Clone repo ───────────────────────────────────────────
if [ ! -d "sunday" ]; then
  echo -e "${YELLOW}→ Sunday will be cloned into ./sunday${RESET}"
  read -p "  Clone now? [y/N] " DO_CLONE
  if [[ "$DO_CLONE" =~ ^[Yy]$ ]]; then
    git clone https://github.com/optimizedjack/sunday.git
    echo -e "${GREEN}✓ Cloned${RESET}"
  else
    echo -e "${RED}✗ Cannot continue without the Sunday source. Exiting.${RESET}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ sunday/ already exists, skipping clone${RESET}"
fi

cd sunday

# ── Node.js ──────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}→ Node.js is not installed. It is required to run Sunday.${RESET}"
  read -p "  Install Node.js via nvm? [y/N] " INSTALL_NODE
  if [[ "$INSTALL_NODE" =~ ^[Yy]$ ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
    echo -e "${GREEN}✓ Node.js $(node -v) installed${RESET}"
  else
    echo -e "${RED}✗ Node.js is required. Exiting.${RESET}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Node.js $(node -v) found${RESET}"
fi

# ── Ollama ───────────────────────────────────────────────
if ! command -v ollama &> /dev/null; then
  echo -e "${YELLOW}→ Ollama is not installed. It is required for local AI inference.${RESET}"
  read -p "  Install Ollama now? [y/N] " INSTALL_OLLAMA
  if [[ "$INSTALL_OLLAMA" =~ ^[Yy]$ ]]; then
    curl -fsSL https://ollama.com/install.sh | sh
    echo -e "${GREEN}✓ Ollama installed${RESET}"
  else
    echo -e "${RED}✗ Ollama is required. Exiting.${RESET}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Ollama found${RESET}"
fi

# Start Ollama server in background if not already running
if ! pgrep -x "ollama" > /dev/null; then
  echo -e "${YELLOW}→ Starting Ollama server...${RESET}"
  ollama serve &> /tmp/ollama.log &
  sleep 3
fi

# Pull default model
MODEL=${OLLAMA_MODEL:-llama3.2}
if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo ""
  echo -e "${YELLOW}→ Model ${BOLD}$MODEL${RESET}${YELLOW} is not pulled yet.${RESET}"
  echo -e "  This is the AI model Sunday will use. Download size is ~2GB."
  read -p "  Pull $MODEL now? [y/N] " PULL_MODEL
  if [[ "$PULL_MODEL" =~ ^[Yy]$ ]]; then
    ollama pull "$MODEL"
    echo -e "${GREEN}✓ Model $MODEL ready${RESET}"
  else
    echo -e "${YELLOW}⚠ Skipping model pull. Sunday will not work until you run: ollama pull $MODEL${RESET}"
  fi
else
  echo -e "${GREEN}✓ Model $MODEL found${RESET}"
fi

# ── npm install ──────────────────────────────────────────
echo ""
echo -e "${YELLOW}→ Installing Node dependencies...${RESET}"
npm install
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# ── .env setup ───────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo -e "${CYAN}${BOLD}  Obsidian API Key${RESET}"
  echo ""
  echo -e "  Sunday saves notes to your Obsidian vault via the Local REST API plugin."
  echo -e "  To get your key:"
  echo ""
  echo -e "  1. Open Obsidian"
  echo -e "  2. Settings → Community plugins → Local REST API → enable"
  echo -e "  3. Copy the API key shown in the plugin settings"
  echo ""
  read -p "  Paste your Obsidian API key now (or press Enter to do it manually later): " KEY
  if [ -n "$KEY" ]; then
    sed -i "s/your_obsidian_api_key_here/$KEY/" .env
    echo -e "${GREEN}  ✓ Key saved${RESET}"
  else
    echo -e "${YELLOW}  ⚠ Edit .env manually before starting Sunday${RESET}"
  fi
else
  echo -e "${GREEN}✓ .env already exists${RESET}"
fi

# ── Optional: systemd service ────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}  Auto-start on boot${RESET}"
echo -e "  This sets up Sunday as a systemd service so it starts automatically."
read -p "  Set up systemd service? [y/N] " SYSTEMD
if [[ "$SYSTEMD" =~ ^[Yy]$ ]]; then
  WORKDIR=$(pwd)
  NODE_BIN=$(command -v node || echo "$NVM_DIR/versions/node/$(nvm current)/bin/node")
  USERNAME=$(whoami)

  SERVICE="[Unit]
Description=Sunday AI assistant
After=network.target

[Service]
Type=simple
User=$USERNAME
WorkingDirectory=$WORKDIR
ExecStart=$NODE_BIN $WORKDIR/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=$WORKDIR/.env

[Install]
WantedBy=multi-user.target"

  echo "$SERVICE" | sudo tee /etc/systemd/system/sunday.service > /dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable sunday
  sudo systemctl start sunday
  echo -e "${GREEN}✓ Service installed and started${RESET}"
  echo -e "  Manage with: ${BOLD}sudo systemctl [start|stop|restart|status] sunday${RESET}"
else
  echo ""
  echo -e "${BOLD}  Start Sunday manually with:${RESET}"
  echo -e "  ${GREEN}cd sunday && node server.js${RESET}"
  echo ""
  echo -e "  Then open: ${BOLD}http://localhost:3000${RESET}"
fi

echo ""
echo -e "${BOLD}  ☀  Setup complete${RESET}"
echo ""
