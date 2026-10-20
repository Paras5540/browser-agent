#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Browser Agent — one-command installer for a Hostinger KVM VPS (Ubuntu 22.04/24.04)
#
#  Usage (from inside the browser-agent folder, as root):
#      sudo bash deploy/deploy.sh                          # no domain, IP:3000 se access
#      sudo bash deploy/deploy.sh agent.example.com        # domain + nginx
#      sudo bash deploy/deploy.sh agent.example.com --ssl   # + free Let's Encrypt SSL
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/browser-agent"
SERVICE="browser-agent"
RUN_USER="browseragent"
DOMAIN="${1:-}"
WANT_SSL="${2:-}"

c_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
step()    { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die()     { c_red "✗ $*"; exit 1; }

# ── guards ───────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Root chahiye. Chalao: sudo bash deploy/deploy.sh"
[ -f "./package.json" ] || die "Ye script browser-agent folder ke andar se chalao (package.json milega wahan)."
[ -f "./server.js" ]    || die "server.js nahi mila — galat folder?"

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) : ;;
  *) die "Ye script Ubuntu/Debian ke liye hai (mila: ${ID:-unknown}). Hostinger pe Ubuntu template use karein." ;;
esac

TOTAL_MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
c_green "OS: $PRETTY_NAME · RAM: ${TOTAL_MEM_MB} MB"
[ "$TOTAL_MEM_MB" -ge 1700 ] || c_red "⚠  RAM ${TOTAL_MEM_MB}MB kam hai. Chromium ko ~1.5GB chahiye — swap banaya ja raha hai."

# ── 1. system packages ──────────────────────────────────────────────────────
step "System packages install ho rahe hain"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git rsync unzip ufw >/dev/null

# ── 2. swap (chhoti RAM ke liye) ────────────────────────────────────────────
if [ "$TOTAL_MEM_MB" -lt 4096 ] && [ ! -f /swapfile ]; then
  step "2 GB swap bana rahe hain"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  c_green "swap ready"
fi

# ── 3. Node.js 22 LTS ───────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  step "Node.js 22 LTS install ho raha hai"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
c_green "Node $(node -v) · npm $(npm -v)"

# ── 4. app copy ─────────────────────────────────────────────────────────────
step "App /opt/browser-agent me copy ho raha hai"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'data/browser-profile' \
  --exclude 'outputs/*.png' \
  ./ "$APP_DIR/"

# run user (root se browser chalana galat hai)
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$RUN_USER" -s /bin/bash "$RUN_USER"

# ── 5. .env ─────────────────────────────────────────────────────────────────
cd "$APP_DIR"
if [ ! -f .env ]; then
  step "Environment setup"
  cp .env.example .env

  # API key: env se lo, warna prompt
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    KEY="$GEMINI_API_KEY"
  else
    echo "Gemini API key chahiye. Free key: https://aistudio.google.com/apikey"
    read -rp "GEMINI_API_KEY: " KEY
  fi
  [ -n "$KEY" ] || die "API key ke bina agent kaam nahi karega."

  # generated dashboard password
  DASHPASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"

  sed -i "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=${KEY}|" .env
  sed -i "s|^HOST=.*|HOST=127.0.0.1|" .env
  sed -i "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=${DASHPASS}|" .env

  echo ""
  c_green "Dashboard password generate hui: ${DASHPASS}"
  echo "  (baad me badal sakte hain: $APP_DIR/.env → DASHBOARD_PASSWORD)"
else
  c_green ".env pehle se maujood hai — chheda nahi gaya"
fi

# ── 6. dependencies + Chromium ──────────────────────────────────────────────
step "npm dependencies"
npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

step "Chromium + system libraries (2-4 minute lagenge)"
# Shared browser path — root install karta hai, service non-root user se padhta hai.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
mkdir -p /opt/ms-playwright
chmod 755 /opt/ms-playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright install --with-deps chromium
chmod -R a+rX /opt/ms-playwright

# ── 7. permissions ──────────────────────────────────────────────────────────
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
mkdir -p "$APP_DIR/outputs" "$APP_DIR/data"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR/outputs" "$APP_DIR/data"

# ── 8. systemd service ──────────────────────────────────────────────────────
step "systemd service"
sed "s|__APP_DIR__|$APP_DIR|g; s|__RUN_USER__|$RUN_USER|g" deploy/browser-agent.service > "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 4
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Service start nahi hui"; }
c_green "Service chal rahi hai (systemctl status ${SERVICE})"

# ── 9. nginx ────────────────────────────────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  step "nginx reverse proxy → ${DOMAIN}"
  apt-get install -y -qq nginx >/dev/null
  SERVER_IP=$(curl -4 -s --max-time 5 ifconfig.me || echo "")
  sed "s|__DOMAIN__|$DOMAIN|g" deploy/nginx.conf.template > "/etc/nginx/sites-available/${SERVICE}"
  # server_name me domain + IP dono — IP se bhi khul jaye
  [ -n "$SERVER_IP" ] && sed -i "s|server_name ${DOMAIN};|server_name ${DOMAIN} ${SERVER_IP};|" "/etc/nginx/sites-available/${SERVICE}"
  ln -sf "/etc/nginx/sites-available/${SERVICE}" "/etc/nginx/sites-enabled/${SERVICE}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  c_green "nginx ready"

  if [ "$WANT_SSL" = "--ssl" ]; then
    step "Let's Encrypt SSL"
    read -rp "Email (SSL expiry alerts ke liye): " EMAIL
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
      c_red "SSL fail hui — domain ka DNS A record VPS IP ($SERVER_IP) pe point karta hai? Baad me: sudo certbot --nginx -d $DOMAIN"
  fi
fi

# ── 10. firewall ────────────────────────────────────────────────────────────
step "Firewall (ufw)"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
if [ -z "$DOMAIN" ]; then
  ufw allow 3000/tcp >/dev/null 2>&1 || true
  c_red "⚠  Port 3000 khula hai (domain ke bina). Domain lagane ke baad band kar dein: ufw delete allow 3000/tcp"
fi
yes | ufw enable >/dev/null 2>&1 || true

# ── 11. Oracle Cloud ka iptables (sirf Oracle images pe) ────────────────────
# Oracle ki Ubuntu images me pehle se iptables rules hote hain jo sirf 22 allow karte hain.
# ufw kaafi nahi — iptables pehle chalta hai. Isliye yahan explicit rules daalte hain.
if [ -f /etc/iptables/rules.v4 ] || command -v netfilter-persistent >/dev/null 2>&1; then
  step "Oracle-style iptables rules (80/443)"
  OPEN_PORTS="80 443"
  [ -z "$DOMAIN" ] && OPEN_PORTS="$OPEN_PORTS 3000"

  for p in $OPEN_PORTS; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || \
      iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT || true
    ip6tables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || \
      ip6tables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT 2>/dev/null || true
  done

  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  else
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  fi
  c_green "iptables rules set + saved"
fi

# ── done ────────────────────────────────────────────────────────────────────
echo ""
c_green "═════════════════════════════════════════════════════"
c_green "  HO GAYA"
c_green "═════════════════════════════════════════════════════"
if [ -n "$DOMAIN" ]; then
  echo "  Dashboard : http://${DOMAIN}"
else
  echo "  Dashboard : http://$(curl -4 -s --max-time 5 ifconfig.me || echo '<VPS-IP>'):3000"
fi
echo "  Password  : .env ke DASHBOARD_PASSWORD me (pehli baar generate hui thi)"
echo ""
echo "  Logs      : journalctl -u ${SERVICE} -f"
echo "  Restart   : systemctl restart ${SERVICE}"
echo "  Update    : cd /opt/browser-agent && git pull 2>/dev/null; sudo bash deploy/deploy.sh"
if [ -n "${ORACLE:-}" ] || curl -s --max-time 2 http://169.254.169.254/opc/v1/instance/ >/dev/null 2>&1; then
  echo ""
  echo "  ⚠  Oracle Cloud: VCN Security List me bhi port 80/443 kholen"
  echo "     Console → Networking → VCN → Security Lists → Add Ingress Rule"
fi
echo ""
