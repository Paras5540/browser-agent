# Browser Agent

Ek self-hosted AI browser agent: chat me task likho, agent khud Chrome khol kar search/click/form-fill
karta hai, data jama karta hai, file banata hai — aur cron scheduler se roz khud chal sakta hai.

```
browser-agent/
├── server.js              Express API + cron scheduler
├── lib/
│   ├── agent.js           Reasoning loop (goal → Gemini → tools → repeat)
│   ├── browser.js         Playwright wrapper + 18 tools
│   ├── llm.js             Gemini REST client (koi SDK nahi)
│   └── store.js           JSON store (data/db.json)
├── deploy/               Deploy guides (Hostinger, Oracle, GitHub Actions)
├── public/                Local dashboard (chat UI + scheduler)
├── docs/                  Cloud dashboard — GitHub Pages (no server needed)
├── .github/workflows/     GitHub Actions: cron + issue-triggered runs
├── run-task.mjs           Ek task chala kar result file banata hai (no server)
├── outputs/               Agent ki banayi files (CSV, MD, screenshots)
├── data/browser-profile/  Persistent Chrome profile — logins/cookies yahin rehte hain
└── .env                   Aapki API key
```

---

## Do tareeke se chala sakte hain

| | **Local** (laptop/PC) | **Cloud** (GitHub) |
|---|---|---|
| Command | `npm start` | git push |
| Dashboard | `localhost:3000` | `youruser.github.io/browser-agent` |
| 24x7 | ❌ jab machine on ho | ✅ |
| Kharcha | ₹0 | ₹0 — card nahi chahiye |
| Scheduler | in-app cron | GitHub Actions cron |
| Setup | neeche section 1 | `deploy/DEPLOY-GITHUB-ACTIONS.md` |

Dono ek hi `lib/` code use karte hain. Cloud setup ke liye **`deploy/DEPLOY-GITHUB-ACTIONS.md`** padhein.

---

## 1. Setup (5 minute)

Zaroorat: **Node.js 18+** (20+ recommended) aur internet.

```bash
cd browser-agent
npm install
npx playwright install chromium     # browser download (~150 MB, ek hi baar)
cp .env.example .env                # Windows: copy .env.example .env
```

`.env` me key daalna **optional** hai — aap app chalu karke dashboard ke **Settings** tab se
bhi key add kar sakte hain (file khud update ho jaati hai, restart nahi chahiye).

```bash
npm start
```

Browser me kholo: **http://localhost:3000** → pehli baar **Settings** tab khulega →
Gemini key paste karein → **Test key** → **Save**.

**Free key yahan se milegi:** https://aistudio.google.com/apikey — free tier me
`gemini-2.5-flash` roz kaafi requests ke liye kaafi hai.

> **Oracle Cloud ka koi API key nahi chahiye.** Oracle sirf server deta hai — wahan SSH se
> login hota hai (`ssh ubuntu@your-vps-ip`). API key sirf Gemini ki hoti hai.

---

## 2. Kaise use karein

### Settings (yahan key add hoti hai)
Right panel → **Settings** tab:

| Field | Kaam |
|---|---|
| **Gemini API key** | Paste → **Test key** → **Save**. Key `.env` me chmod 600 se save hoti hai, UI pe wapas nahi dikhti (sirf `AIza…7890` mask) |
| **Model** | flash / flash-lite / pro |
| **Max steps** | ek task me max tool calls |
| **Browser mode** | headless (server) ya visible (login karne ke liye) |
| **Dashboard password** | set karte hi dashboard password maangne lagega — turant, restart ke bina |

Key invalid ho to upar laal banner dikhega aur chat block rahega — galat key se run start nahi hoga.

### Chat
Neeche composer me task likho aur **Run** dabao (ya `Ctrl+Enter`).

Achhe task ka format — *kaam + scope + output*:

> Amazon pe "noise cancelling headphones" search karo. Top 5 products ke naam, price,
> rating aur review count nikaalo. CSV file banao.

Agent right side me live steps dikhata hai (`search`, `navigate`, `click`, `extract`…)
aur kaam khatam hone pe result + file de deta hai.

### Scheduler
`Scheduler` tab → naam, task, aur cron expression bharo. Presets se select kar sakte hain.

```
0 9 * * *       roz 9:00 AM
0 */6 * * *     har 6 ghante
0 9 * * 1       har Monday 9 AM
0 9 1 * *       mahine ki 1 tareekh, 9 AM
```

- `Pause` / `Resume`, `Run now` buttons available hain
- Har scheduled run ka result **Tasks** tab me chala jata hai
- Cron server ke local timezone me chalta hai

### Files
Agent `save_results()` se jo bhi file banata hai, `Files` tab me download ke liye aati hai.

---

## 3. Login wali sites (LinkedIn, Instagram, company portal…)

Default me browser **headless** hai — aap use nahi dekh sakte. Pehli baar login karne ke liye:

1. `.env` me `HEADLESS=false` karo
2. `npm start` — Chrome window khulegi
3. Chat me likho: *"linkedin.com kholo aur login page tak jao"*
4. Khud us window me login karo (2FA bhi)
5. Login ke baad `HEADLESS=true` kar ke restart kar do

Login **save ho jata hai** — `data/browser-profile/` folder me. Dobara kabhi nahi poochna padega.

> Ek hi browser profile shared hai. Ek time pe ek task chalta hai — tasks queue me lag jaate hain.
> Isi wajah se logins safe rehte hain.

---

## 4. Agent ke tools

| Tool | Kaam |
|---|---|
| `search` | Web search (DuckDuckGo, fail hone pe Bing) |
| `navigate` | Koi bhi URL kholna |
| `elements` | Page ke clickable/typable elements, index ke saath |
| `click` | Index / text / CSS selector se click |
| `type` | Input me likhna, `submit:true` se Enter |
| `press` | Keyboard key (Enter, Tab, Escape…) |
| `scroll` `back` `forward` `wait` | Navigation control |
| `read_page` | Poora visible text |
| `extract` | CSS selector se list nikalna (href/src bhi) |
| `tabs` | Tab list / new / switch / close |
| `screenshot` | Screenshot — agent use *dekh* sakta hai |
| `save_results` | CSV / MD / JSON file banana |
| `note` / `read_notes` | Long task ka scratchpad |
| `finish` | Task khatam + summary |

---

## 5. Settings (.env)

| Variable | Default | Matlab |
|---|---|---|
| `GEMINI_API_KEY` | — | **zaroori** |
| `GEMINI_MODEL` | `gemini-2.5-flash` | `gemini-2.5-pro` mushkil tasks ke liye |
| `PORT` | `3000` | dashboard port |
| `HEADLESS` | `true` | `false` = browser dikhta hai |
| `MAX_STEPS` | `45` | ek task me max tool calls |
| `USER_DATA_DIR` | `./data/browser-profile` | login/cookies folder |
| `DASHBOARD_PASSWORD` | *(empty)* | set karo to dashboard password protected |

---

## 6. Kahan host karein

| Jagah | Kab theek hai |
|---|---|
| **Apna laptop/PC** | Try karne ke liye. Scheduler sirf tab chalega jab machine on ho. |
| **Windows/Mac** | Chalega. `HEADLESS=false` se Chrome dikhta hai. |
| **Linux VPS (recommend)** | 24x7 chalane ke liye. Ek command: `sudo bash deploy/deploy.sh yourdomain.com --ssl` |
| **Docker** | `mcr.microsoft.com/playwright` image base use karein. |

**24x7 ke liye minimum:** 2 vCPU, 4 GB RAM, 20 GB disk (Chromium + profile ke liye).

> **Hostinger user?** `deploy/DEPLOY-HOSTINGER.md` padhein.
> Shared/Cloud hosting pe ye app **nahi** chalega (Node.js apps wahan on-demand band ho jaate hain,
> root access nahi hota) — **VPS** chahiye. KVM 1 (4 GB) kaafi hai.

VPS pe background me chalane ka simple tarika:

```bash
npm install -g pm2
pm2 start server.js --name browser-agent
pm2 save && pm2 startup
```

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `GEMINI_API_KEY missing` | `.env` file check karo — naam bilkul same hona chahiye |
| `browserType.launch: Executable doesn't exist` | `npx playwright install chromium` |
| VPS pe browser crash (`libnss3` etc.) | `npx playwright install --with-deps chromium` |
| Site bot-block kar rahi hai | Agent khud doosri site try karta hai. `HEADLESS=false` se kaafi block hat jaate hain |
| Task 45 steps pe ruk gaya | `.env` me `MAX_STEPS=80` karo |
| Login baar baar maang raha | `USER_DATA_DIR` folder delete mat karo — wahi login save karta hai |
| Gemini 429 error | Free tier limit — thoda wait karo ya `gemini-2.5-flash-lite` try karo |

---

## 8. Security notes

- Dashboard localhost pe chalta hai. Internet pe kholna ho to `DASHBOARD_PASSWORD` set karo
  aur reverse proxy (Caddy/Nginx) ke peeche rakho.
- `.env` ko git me commit mat karo — `.gitignore` me already hai.
- Agent **aapke browser** ke andar kaam karta hai. Jo task doge wahi karega — posting/money
  wale kaam dhyan se do, aur unka schedule review karo.

---

## 9. Limits (honest)

- Ye app **Gemini ke function-calling** pe depend karta hai. Bahut complex ya ambiguous task
  pe agent galat site pe jaa sakta hai — goal specific likhne se bahut farak padta hai.
- Ek time pe ek task (single browser profile). Throughput chahiye to multiple instances chalao,
  alag `USER_DATA_DIR` aur `PORT` ke saath.
- Captcha aa jaye to agent `screenshot` le kar try karta hai, par solve nahi kar sakta.
  Headless false karne se ya login karke ye kaafi kam ho jata hai.
