#!/usr/bin/env bash
# cURL command is inside README.md
set -euo pipefail

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
read -r -p "  Do you understand and wish to continue? [y/N] " DISCLAIMER || true
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
  read -r -p "  Install Git now? [y/N] " INSTALL_GIT || true
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
  read -r -p "  Clone now? [y/N] " DO_CLONE || true
  if [[ "$DO_CLONE" =~ ^[Yy]$ ]]; then
    git clone https://github.com/optimizedjack/sunday.git
    # Verify the clone contains expected files before proceeding
    for expected in sunday/server.js sunday/index.html sunday/package.json; do
      if [ ! -f "$expected" ]; then
        echo -e "${RED}✗ Clone appears incomplete — missing $expected. Exiting.${RESET}"
        exit 1
      fi
    done
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
  read -r -p "  Install Node.js via nvm? [y/N] " INSTALL_NODE || true
  if [[ "$INSTALL_NODE" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}  ⚠ This will download and execute a script from github.com/nvm-sh.${RESET}"
    echo -e "  To inspect it first: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | less"
    read -r -p "  Proceed with nvm install? [y/N] " CONFIRM_NVM
    if [[ ! "$CONFIRM_NVM" =~ ^[Yy]$ ]]; then
      echo -e "${RED}✗ Node.js is required. Install it manually and re-run setup. Exiting.${RESET}"
      exit 1
    fi
    curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="${HOME}/.nvm"
    # shellcheck source=/dev/null
    source "${NVM_DIR}/nvm.sh"
    nvm install --lts
    nvm use --lts
    echo -e "${GREEN}✓ Node.js $(node -v) installed${RESET}"
  else
    echo -e "${RED}✗ Node.js is required. Exiting.${RESET}"
    exit 1
  fi
else
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "${NODE_VERSION}" -lt 18 ]; then
    echo -e "${RED}✗ Node.js 18+ is required (found $(node -v)). Please upgrade and re-run.${RESET}"
    exit 1
  fi
  echo -e "${GREEN}✓ Node.js $(node -v) found${RESET}"
fi

# Resolve node binary for systemd service (nvm installs to a non-standard path)
NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -z "${NODE_BIN}" ]; then
  NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  if [ -f "${NVM_DIR}/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "${NVM_DIR}/nvm.sh"
    NODE_BIN=$(command -v node 2>/dev/null || true)
  fi
fi
if [ -z "${NODE_BIN}" ]; then
  echo -e "${RED}✗ Cannot locate node binary. Please install Node.js manually and re-run.${RESET}"
  exit 1
fi

# ── Ollama ───────────────────────────────────────────────
if ! command -v ollama &> /dev/null; then
  echo -e "${YELLOW}→ Ollama is not installed. It is required for local AI inference.${RESET}"
  read -r -p "  Install Ollama now? [y/N] " INSTALL_OLLAMA || true
  if [[ "$INSTALL_OLLAMA" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}  ⚠ This will download and execute a script from ollama.com.${RESET}"
    echo -e "  To inspect it first: curl -fsSL https://ollama.com/install.sh | less"
    read -r -p "  Proceed with Ollama install? [y/N] " CONFIRM_OLLAMA
    if [[ ! "$CONFIRM_OLLAMA" =~ ^[Yy]$ ]]; then
      echo -e "${RED}✗ Ollama is required. Install it manually and re-run setup. Exiting.${RESET}"
      exit 1
    fi
    curl -fsSL --proto '=https' --tlsv1.2 https://ollama.com/install.sh | sh
    echo -e "${GREEN}✓ Ollama installed${RESET}"
  else
    echo -e "${RED}✗ Ollama is required. Exiting.${RESET}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Ollama found${RESET}"
fi

# Start Ollama server in background if not already running
if ! pgrep -x "ollama" > /dev/null 2>&1; then
  echo -e "${YELLOW}→ Starting Ollama server...${RESET}"
  OLLAMA_LOG=$(mktemp)
  chmod 600 "${OLLAMA_LOG}"
  ollama serve >> "${OLLAMA_LOG}" 2>&1 &

  # Poll until ready (up to 15 seconds)
  echo -n "  Waiting for Ollama"
  for i in $(seq 1 15); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
      echo ""
      echo -e "${GREEN}✓ Ollama is ready${RESET}"
      break
    fi
    if [ "${i}" -eq 15 ]; then
      echo ""
      echo -e "${RED}✗ Ollama did not start in time. Check logs: ${OLLAMA_LOG}${RESET}"
      exit 1
    fi
    echo -n "."
    sleep 1
  done
fi

# Pull default model
MODEL="${OLLAMA_MODEL:-llama3.2}"
if ! ollama list 2>/dev/null | grep -q "${MODEL}"; then
  echo ""
  echo -e "${YELLOW}→ Model ${BOLD}${MODEL}${RESET}${YELLOW} is not pulled yet.${RESET}"
  echo -e "  This is the AI model Sunday will use. Download size is ~2GB."
  read -r -p "  Pull ${MODEL} now? [y/N] " PULL_MODEL || true
  if [[ "$PULL_MODEL" =~ ^[Yy]$ ]]; then
    ollama pull "${MODEL}"
    echo -e "${GREEN}✓ Model ${MODEL} ready${RESET}"
  else
    echo -e "${YELLOW}⚠ Skipping model pull. Sunday will not work until you run: ollama pull ${MODEL}${RESET}"
  fi
else
  echo -e "${GREEN}✓ Model ${MODEL} found${RESET}"
fi

# ── npm install ──────────────────────────────────────────
echo ""
echo -e "${YELLOW}→ Installing Node dependencies...${RESET}"
npm install
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# ── Download client-side dependencies ───────────────────
echo -e "${YELLOW}→ Downloading client dependencies (marked, DOMPurify)...${RESET}"
curl -fsSL --proto '=https' --tlsv1.2 "https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js" -o marked.min.js
curl -fsSL --proto '=https' --tlsv1.2 "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js" -o purify.min.js
echo -e "${GREEN}✓ marked.min.js and purify.min.js downloaded${RESET}"

# ── .env setup ───────────────────────────────────────────
if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    echo -e "${RED}✗ .env.example not found. Cannot create .env. Exiting.${RESET}"
    exit 1
  fi
  cp .env.example .env
  chmod 600 .env

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
  # read -rs: silent (no echo) to keep key out of terminal output
  read -rs -p "  Paste your Obsidian API key now (or press Enter to do it manually later): " KEY || true
  echo ""
  if [ -n "${KEY}" ]; then
    if ! command -v python3 &> /dev/null; then
      echo -e "${YELLOW}  ⚠ python3 not found — edit .env manually and set OBSIDIAN_KEY=${RESET}"
    else
      # Use Python to substitute the key safely — avoids sed metacharacter injection
      # (keys containing /, &, or \ would corrupt a sed substitution)
      python3 - "${KEY}" << 'PYEOF'
import sys, pathlib
key = sys.argv[1]
p = pathlib.Path('.env')
p.write_text(p.read_text().replace('your_obsidian_api_key_here', key))
PYEOF
      echo -e "${GREEN}  ✓ Key saved${RESET}"
    fi
  else
    echo -e "${YELLOW}  ⚠ Edit .env manually before starting Sunday${RESET}"
  fi
else
  echo -e "${GREEN}✓ .env already exists${RESET}"
  # Ensure permissions are correct even on existing .env
  chmod 600 .env
fi

# ── Optional: systemd service ────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}  Auto-start on boot${RESET}"
echo -e "  This sets up Sunday as a systemd service so it starts automatically."
read -r -p "  Set up systemd service? [y/N] " SYSTEMD || true
if [[ "$SYSTEMD" =~ ^[Yy]$ ]]; then
  WORKDIR="$(pwd)"
  USERNAME="$(whoami)"

  # Write the unit file via tee to avoid variable-in-heredoc quoting issues
  sudo tee /etc/systemd/system/sunday.service > /dev/null << UNITEOF
[Unit]
Description=Sunday AI assistant
After=network.target

[Service]
Type=simple
User=${USERNAME}
WorkingDirectory=${WORKDIR}
ExecStart=${NODE_BIN} ${WORKDIR}/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=${WORKDIR}/.env
# Harden the service process
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${WORKDIR}

[Install]
WantedBy=multi-user.target
UNITEOF

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
