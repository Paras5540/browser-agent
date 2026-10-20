# Hostinger pe deploy karna

## Pehle: aapke paas kaun sa plan hai?

Hostinger pe do bilkul alag cheezein "hosting" ke naam se bikti hain. **Browser Agent sirf VPS pe chalega.**

hPanel → left sidebar dekhein:

| Aapko ye dikhta hai | Plan | Browser Agent chalega? |
|---|---|---|
| **Websites**, **Hosting**, "Premium / Business / Cloud" | Shared / Cloud web hosting | ❌ **Nahi** |
| **VPS**, "KVM 1 / KVM 2…", SSH access, root password | KVM VPS | ✅ **Haan** |

---

## Agar aapke paas Shared / Business / Cloud hosting hai

Ye plan is app ke liye kaam **nahi** karega. Reason (Hostinger ke apne docs se):

1. **Node.js apps "on demand" chalte hain** — "After a period without incoming traffic, your app's process is stopped automatically." Matlab jab tak koi dashboard khol kar nahi baithta, process band. **Scheduler (cron) internally chalta hai — process band hone ka matlab scheduled task kabhi fire nahi hoga.**
2. **Root access nahi hai** — Chromium ki system libraries (`libnss3`, fonts, GPU deps) install nahi kar sakte. `npx playwright install --with-deps` fail hoga.
3. **Business/Cloud pe SSH se npm command nahi chala sakte** — sirf deploy ke waqt automatic build hota hai. Playwright browser download karne ka koi rasta nahi.
4. Hostinger khud kehta hai: *"customization of scheduled processes and access to edit crontab directly is supported on VPS Hosting plans."*

### Aapke paas 3 raste hain

| Rasta | Kya karna hoga |
|---|---|
| **A) VPS upgrade (recommended)** | Hostinger **KVM 1** — 1 vCPU / 4 GB RAM / 50 GB NVMe. Intro ~₹599/mo, renew ~₹999/mo. Pura guide neeche. |
| **B) Apna laptop/PC** | Abhi free me try karo. `npm start` chalao. **Scheduler sirf tab chalega jab machine on ho** — daily reports ke liye bekar, manual kaam ke liye theek. |
| **C) Shared hosting rakho, app laptop pe** | Shared hosting kisi aur site ke liye use karo, agent laptop pe chalao. |

> **Chhoti si baat:** KVM 1 (4 GB RAM) kaafi hai. 8 GB ki zaroorat nahi — Chromium ek time pe ek instance chalta hai, ~1.5 GB khaata hai.

---

## VPS pe deploy (10 minute)

### Step 0 — VPS banao
hPanel → **VPS** → naya server → template: **Ubuntu 24.04** (22.04 bhi chalega) → root password save karo.

### Step 1 — SSH se login
```bash
ssh root@YOUR_VPS_IP
```

### Step 2 — apna domain point karo (optional, par recommended)
hPanel → Domains → DNS → `A` record: `agent.yourdomain.com` → `YOUR_VPS_IP`

Domain ke bina bhi chalega (`IP:3000` se), par HTTPS nahi milega.

### Step 3 — app upload karo
Apne laptop se:

```bash
scp browser-agent.zip root@YOUR_VPS_IP:/root/
```

VPS pe:

```bash
cd /root
apt-get update -qq && apt-get install -y unzip
unzip -q browser-agent.zip
cd browser-agent
```

### Step 4 — ek command deploy
```bash
# domain ke saath + free SSL
sudo bash deploy/deploy.sh agent.yourdomain.com --ssl

# ya domain ke bina (IP:3000)
sudo bash deploy/deploy.sh
```

Script ye sab khud karta hai:

- Node.js 22 LTS install
- kam RAM ho to 2 GB swap
- `npm install`
- Playwright Chromium + saari system libraries (`--with-deps`)
- non-root user `browseragent` banana (root se browser chalana galat hai)
- `.env` banana — **API key poochhega**, aur ek **random dashboard password generate** karke screen pe dikhata hai
- systemd service (`browser-agent`) — auto-restart, boot pe auto-start
- nginx reverse proxy + optional Let's Encrypt SSL
- ufw firewall (80/443, ya 3000)

### Step 5 — Gemini key
Script chalte waqt poochhega. Free key yahan se: **https://aistudio.google.com/apikey**

Ya pehle se de sakte hain:
```bash
GEMINI_API_KEY=your_key sudo -E bash deploy/deploy.sh agent.yourdomain.com --ssl
```

---

## Verify karo

```bash
systemctl status browser-agent          # active (running) dikhna chahiye
journalctl -u browser-agent -n 30       # koi error?
curl -s localhost:3000/api/state        # {"ok":true,...}
```

Browser me dashboard kholo → password daalo → ek chhota task chalao:

> *"Hacker News pe aaj ke top 5 posts ka title aur link nikaalo"*

Kaam kare to dashboard ke **Scheduler** tab me daal do: `0 9 * * *` — roz subah 9 baje (server ke timezone me; UTC hota hai by default).

**Timezone India chahiye?**
```bash
sudo timedatectl set-timezone Asia/Kolkata
sudo systemctl restart browser-agent
```

---

## Rozmarra ke commands

| Kaam | Command |
|---|---|
| Logs live dekho | `journalctl -u browser-agent -f` |
| Restart | `systemctl restart browser-agent` |
| Band karo | `systemctl stop browser-agent` |
| Settings badlo | `nano /opt/browser-agent/.env` → phir restart |
| Output files | `ls /opt/browser-agent/outputs/` |
| Login karke sites access karo | `HEADLESS=false` + VNC, ya neeche dekho |

---

## Login wali sites (LinkedIn, portal) VPS pe

VPS pe browser invisible hai, to login kaise karein? Do tarike:

**Tarika 1 (aasan) — laptop pe login, profile copy karo**

1. Laptop pe `.env` me `HEADLESS=false` karke ek baar login karo
2. `data/browser-profile/` folder copy karo
3. VPS pe upload karo:
```bash
scp -r data/browser-profile root@YOUR_VPS_IP:/opt/browser-agent/data/
sudo chown -R browseragent:browseragent /opt/browser-agent/data
sudo systemctl restart browser-agent
```

**Tarika 2 — VPS pe temporary visible browser**

```bash
sudo apt-get install -y xvfb x11vnc
# .env me: HEADLESS=false
xvfb-run -a -s "-screen 0 1366x900x24" node server.js &
# phir SSH tunnel se apne laptop pe VNC kholo
```

Zyada tar sites ke liye Tarika 1 kaafi hai.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Executable doesn't exist at /opt/ms-playwright/...` | `sudo PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright install chromium` |
| Service baar baar restart ho rahi | `journalctl -u browser-agent -n 50` — 90% cases me API key galat ya .env missing |
| Browser crash / `Target closed` | RAM kam. `free -h` dekho, swap on karo: `sudo swapon /swapfile` |
| `EACCES` outputs folder pe | `sudo chown -R browseragent:browseragent /opt/browser-agent` |
| Scheduler fire nahi ho raha | `timedatectl` — timezone check karo; `journalctl -u browser-agent \| grep cron` |
| 502 Bad Gateway | App band hai: `systemctl status browser-agent`; port `curl localhost:3000` |
| SSL fail | Domain ka DNS A record VPS IP pe point karta hai? `dig +short agent.yourdomain.com` |
| Dashboard 401 | Password `.env` ke `DASHBOARD_PASSWORD` me hai |

---

## Security (zaroori)

- `DASHBOARD_PASSWORD` **hamesha set** rakhein — ye dashboard aapke browser ko control karta hai
- Domain ke saath deploy karein to port 3000 band kar dein: `sudo ufw delete allow 3000/tcp`
- `.env` kabhi share/commit na karein
- Hostinger VPS pe weekly backup on karein (hPanel → VPS → Backups)
- Ek VPS pe ek hi instance chalayein (single browser profile = single session)

---

## Cost summary

| Cheez | Kharcha |
|---|---|
| Hostinger KVM 1 (1 vCPU / 4 GB / 50 GB) | ~₹599/mo intro, ~₹999/mo renew |
| Gemini API (free tier) | ₹0 — flash model ki free quota roz ke kaafi tasks ke liye kaafi |
| Domain | aapke paas already hai |
| **Total** | **~₹600–1000/mo** |
