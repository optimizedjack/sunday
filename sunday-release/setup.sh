#!/usr/bin/env bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}  ☀  Sunday — setup${RESET}"
echo "  ─────────────────────────────────"
echo ""

# ── Node.js ─────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}→ Node.js not found. Installing via nvm...${RESET}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
else
  echo -e "${GREEN}✓ Node.js $(node -v) found${RESET}"
fi

# ── Ollama ───────────────────────────────────────────────
if ! command -v ollama &> /dev/null; then
  echo -e "${YELLOW}→ Ollama not found. Installing...${RESET}"
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo -e "${GREEN}✓ Ollama found${RESET}"
fi

# Pull default model if not present
MODEL=${OLLAMA_MODEL:-llama3.2}
if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo -e "${YELLOW}→ Pulling $MODEL...${RESET}"
  ollama pull "$MODEL"
else
  echo -e "${GREEN}✓ Model $MODEL found${RESET}"
fi

# ── npm install ──────────────────────────────────────────
echo -e "${YELLOW}→ Installing dependencies...${RESET}"
npm install
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# ── .env setup ───────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo -e "${BOLD}  Almost done. Fill in your Obsidian API key:${RESET}"
  echo ""
  echo -e "  1. Open Obsidian"
  echo -e "  2. Settings → Community plugins → Local REST API → enable"
  echo -e "  3. Copy the API key from the plugin settings"
  echo -e "  4. Paste it into ${BOLD}.env${RESET} next to OBSIDIAN_KEY="
  echo ""
  read -p "  Paste your Obsidian API key now (or press Enter to do it manually later): " KEY
  if [ -n "$KEY" ]; then
    sed -i "s/your_obsidian_api_key_here/$KEY/" .env
    echo -e "${GREEN}  ✓ Key saved${RESET}"
  else
    echo -e "${YELLOW}  ⚠ Edit .env manually before starting${RESET}"
  fi
else
  echo -e "${GREEN}✓ .env already exists${RESET}"
fi

# ── Optional: systemd service ────────────────────────────
echo ""
read -p "  Set up Sunday as a systemd service (auto-start on boot)? [y/N] " SYSTEMD
if [[ "$SYSTEMD" =~ ^[Yy]$ ]]; then
  WORKDIR=$(pwd)
  NODE_BIN=$(which node)
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
  echo -e "${BOLD}  Start Sunday with:${RESET}"
  echo -e "  ${GREEN}node server.js${RESET}"
  echo ""
  echo -e "  Then open: ${BOLD}http://localhost:3000${RESET}"
fi

echo ""
echo -e "${BOLD}  ☀  Setup complete${RESET}"
echo ""
