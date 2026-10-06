#!/usr/bin/env bash
# GreenYield SPV — one-click demo.  Usage:  ./run-demo.sh        (full demo)
#                                           ./run-demo.sh fraud  (one lying epoch)
#                                           ./run-demo.sh honest (one honest epoch)
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
step(){ echo; echo "${B}━━━ $* ━━━${N}"; }
die(){ echo "${R}✗ $*${N}"; exit 1; }
export PATH="$HOME/.cre/bin:$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

# ── 1. tools ──────────────────────────────────────────────
step "1/6 Checking tools"
miss=0
for t in node npm bun forge cast cre; do
  if command -v $t >/dev/null; then echo "${G}✓${N} $t"; else echo "${R}✗ $t missing${N}"; miss=1; fi
done
if [ $miss = 1 ]; then cat <<HELP

${Y}Install the missing tools, then run this script again:${N}
  node/npm : https://nodejs.org (LTS)
  bun      : curl -fsSL https://bun.sh/install | bash
  forge    : curl -L https://foundry.paradigm.xyz | bash && foundryup
  cre      : curl -sSL https://cre.chain.link/install.sh | bash
Then close and reopen the terminal.
HELP
exit 1; fi

# ── 2. secrets ────────────────────────────────────────────
step "2/6 Checking .env"
[ -f .env ] || { cp .env.example .env; die "Created .env — open it, paste your testnet private key (and LLM key), then rerun."; }
set -a; . ./.env; set +a
[ -n "${CRE_ETH_PRIVATE_KEY:-}" ] || die "CRE_ETH_PRIVATE_KEY is empty in .env"
case "$CRE_ETH_PRIVATE_KEY" in 0x*) PK="$CRE_ETH_PRIVATE_KEY";; *) PK="0x$CRE_ETH_PRIVATE_KEY";; esac
export CRE_ETH_PRIVATE_KEY="${PK#0x}"
RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
ME=$(cast wallet address --private-key "$PK")
BAL=$(cast balance "$ME" --rpc-url "$RPC" --ether)
echo "Wallet $ME  balance ${BAL} Sepolia ETH"
awk "BEGIN{exit !($BAL < 0.02)}" && die "Need ≥ 0.02 Sepolia ETH. Get some free: https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
[ "${LLM_API_KEY:-none}" = "none" ] && echo "${Y}! LLM_API_KEY not set — AI score will run in offline mode${N}"
node -e 'const f="project.yaml";const fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/url: .*/,"url: "+process.argv[1]))' "$RPC"

# ── 3. CRE login ─────────────────────────────────────────
step "3/6 Chainlink CRE login"
if ! cre whoami >/dev/null 2>&1; then echo "A browser will open — sign in to Chainlink."; cre login; fi
cre whoami | head -3

# ── 4. deploy (once) ──────────────────────────────────────
step "4/6 Smart contracts on Sepolia"
if [ -f .deployed ]; then echo "Already deployed: $(cat .deployed)  (delete .deployed to redeploy)"
else
  (cd contracts && CRE_ETH_PRIVATE_KEY="$PK" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow --evm-version amsterdam 2>&1 | grep -E "USDC|HUB|Error|error" || true)
  [ -f .deployed ] || die "Deploy failed — scroll up for the error."
fi
HUB=$(tr -d '[:space:]' < .deployed)
# the script writes .deployed even when a broadcast tx reverts, so check the hub really has code
[ "$(cast code "$HUB" --rpc-url "$RPC")" != 0x ] || { rm -f .deployed; die "No contract at $HUB — deploy failed, rerun to redeploy."; }
node -e 'const f="workflow/config.staging.json";const fs=require("fs");const c=JSON.parse(fs.readFileSync(f));c.hubAddress=process.argv[1];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$HUB"
echo "${G}✓${N} Hub $HUB  → https://sepolia.etherscan.io/address/$HUB"

# ── 5. mock API + dashboard ───────────────────────────────
step "5/6 Starting demo server + dashboard"
(cd mock-api && [ -d node_modules ] || npm install --silent)
(cd workflow && [ -d node_modules ] || bun install)
if ! curl -s localhost:8788/state >/dev/null 2>&1; then
  DEPLOYER="$ME" SEPOLIA_RPC="$RPC" nohup node mock-api/server.js > mock-api.log 2>&1 &
  sleep 2
fi
echo "${G}✓${N} Dashboard: http://localhost:8788"
(open http://localhost:8788 || xdg-open http://localhost:8788 || start http://localhost:8788) >/dev/null 2>&1 || true

# ── 6. run epochs through Chainlink CRE ───────────────────
run_epoch(){
  curl -s -XPOST "localhost:8788/operator/$1" >/dev/null
  if [ "$1" = fraud ]; then echo "${R}${B}🚨 Epoch: the operator LIES about generation${N}"; else echo "${G}${B}✅ Epoch: the operator reports HONESTLY${N}"; fi
  cre workflow simulate ./workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast 2>&1 \
    | tee -a simulate.log | grep -E "🏭|📡|🔌|☀️|✅|❌|💵|🤖|🟢|🔴|⛓️|rror|\[USER LOG\]" | sed 's/.*\[USER LOG\] *//'
}
step "6/6 Chainlink CRE verifies each epoch"
case "${1:-all}" in
  fraud)  run_epoch fraud ;;
  honest) run_epoch honest ;;
  *) run_epoch fraud; echo; read -r -p "Press Enter for the honest epoch… " _; run_epoch honest ;;
esac
echo; echo "${B}Done. Watch the dashboard: http://localhost:8788${N}  (full logs in simulate.log)"
