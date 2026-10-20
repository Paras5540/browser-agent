# Oracle Cloud pe deploy (Always Free)

Oracle aapko **server** deta hai — koi API key nahi. API key sirf Gemini ki hai
(wo dashboard ke **Settings** tab me jaati hai). Yahan koi OCI key/tenancy OCID nahi chahiye.

---

## 1. Account banao

https://signup.cloud.oracle.com → card verification (₹1-2 temporary hold, charge nahi).

> **Region:** Hyderabad (`ap-hyderabad-1`) ya Singapore (`ap-singapore-1`) chunein.
> **Mumbai me ARM capacity nahi milti.** Home region baad me **nahi** badla ja sakta —
> ye permanent choice hai.

---

## 2. Instance banao

| Setting | Value |
|---|---|
| Shape | **VM.Standard.A1.Flex** (ARM Ampere) |
| OCPU | **2** |
| Memory | **12 GB** |
| Image | Ubuntu 24.04 (ya 22.04) |
| Boot volume | 50–100 GB |
| SSH key | apni public key upload karein (ya generated download karein) |

⚠️ **2 OCPU / 12 GB se zyada NA karein.** Oracle ne June 2026 me free limit aadhi ki hai;
zyada banaya to trial ke baad instance **terminate** ho jayegi.

**"Out of host capacity" aaye to:** dusra availability domain try karein, ya 1 OCPU / 6 GB
se try karein (baad me badha sakte hain), ya kuch ghanton baad retry karein. Ye normal hai,
Oracle pe ARM ke liye common.

---

## 3. Network kholna — DO jagah

### (a) Oracle console → Security List
Networking → Virtual Cloud Networks → apni VCN → Security Lists → Default Security List
→ **Add Ingress Rules**:

| Source | Protocol | Dest. Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | TCP | `22` (usually already hai) |

### (b) Server ke andar iptables — ye log bhool jaate hain

Oracle ki Ubuntu images me **pehle se iptables rules** hote hain jo sirf port 22 allow karte
hain. Sirf `ufw` on karne se kaam nahi chalta — iptables pehle chalta hai, isliye nginx 80 pe
sunta rahega par bahar se kuch nahi khulega (classic "502/timeout" wala 2-ghante ka bug).

`deploy/deploy.sh` ab **ye khud handle karta hai**. Manual karna ho to:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save      # reboot ke baad bhi rahe
```

---

## 4. Deploy

```bash
# laptop se
scp browser-agent.zip ubuntu@YOUR_VPS_IP:/home/ubuntu/

# server pe
ssh ubuntu@YOUR_VPS_IP
sudo -i
apt-get update -qq && apt-get install -y unzip
unzip -q /home/ubuntu/browser-agent.zip -d /home/ubuntu/
cd /home/ubuntu/browser-agent
bash deploy/deploy.sh agent.yourdomain.com --ssl
```

`ubuntu` user pe sudo hai, `root` nahi — isliye `sudo -i` pehle.

Script ye sab karta hai: Node 22, swap, `npm install`, Chromium + ARM64 libraries,
`browseragent` non-root user, systemd service, nginx, SSL, ufw, **aur Oracle iptables rules**.

---

## 5. Gemini key add karein

```
http://agent.yourdomain.com
```

Pehli baar **Settings** tab → Gemini key paste → **Test key** → **Save**.
Restart ki zaroorat nahi.

Key yahan se (free): https://aistudio.google.com/apikey

---

## 6. Verify

```bash
systemctl status browser-agent        # active (running)
journalctl -u browser-agent -n 30
curl -s localhost:3000/api/state      # {"ok":true,...}
```

Bahar se: browser me dashboard → task chalao.
Nahi khul raha? → Step 3 (a) aur (b) dono check karein.

---

## Oracle-specific troubleshooting

| Problem | Fix |
|---|---|
| **"Out of host capacity"** | Dusra AD/region try karein, ya 1 OCPU/6 GB pe banao |
| **Dashboard timeout, SSH theek hai** | iptables (Step 3b) + Security List (3a) — dono |
| **`Executable doesn't exist ... /opt/ms-playwright`** | `sudo PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright install chromium` |
| **Instance band ho gayi / "stopped"** | 2 OCPU / 12 GB se zyada allocate kiya tha — resize karo |
| **SSL fail** | DNS A record Oracle public IP pe hai? `dig +short agent.yourdomain.com` |
| **Browser crash / Target closed** | RAM: `free -h`. 12 GB hai to ye nahi hona chahiye — swap check karein |
| **Region galat chun liya** | Naya tenancy banana padega — home region change nahi hota |

---

## Free tier ki asli limits (Oct 2026)

| Cheez | Limit |
|---|---|
| ARM Ampere A1 | **2 OCPU / 12 GB** total |
| AMD micro (VM.Standard.E2.1.Micro) | 2 instances × 1/8 OCPU / 1 GB |
| Block + boot storage | 200 GB total |
| Outbound bandwidth | 10 TB/month |

Idle instances Oracle kabhi reclaim karta hai — scheduler laga rahe hain to app active rahega,
koi dikkat nahi.
