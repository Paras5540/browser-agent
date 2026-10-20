# GitHub Actions + Pages — free cloud setup (no card, no server)

Ye setup **bilkul free** hai aur **credit card nahi chahiye**.

Kya milta hai:
- ☁️ Agent **cloud me** chalta hai — phone/laptop band ho to bhi
- 💬 **Dashboard** (GitHub Pages) se task dete hain, result wahin dikhta hai
- ⏰ Roz **khud** chalta hai (cron)
- 📁 Result files repo me save

Kaise kaam karta hai:

```
Dashboard (Pages)
   │  task likha
   ▼
GitHub Issue  ──label: agent-task──►  Actions workflow
                                          │ Chromium + agent
                                          ▼
                                    Issue pe comment (result)
                                    outputs/ me files + artifact
```

---

## Step 1 — Repo banayein (PUBLIC)

GitHub → **New repository** → name `browser-agent` → **Public** ✅ → Create.

> ⚠️ **Private repo me cron chalta hi nahi** — free personal account pe `schedule` events
> silently disable hote hain (undocumented limitation). Public repo me cron chalta hai
> aur minutes **unlimited** ho jaate hain. Private chahiye to GitHub Pro ($4/mo) lagega.

Ab files upload karein — `browser-agent.zip` extract karke poora folder repo me daal dein
(GitHub web UI se drag-drop bhi chalega, ya):

```bash
cd browser-agent
git init
git add .
git commit -m "browser agent"
git branch -M main
git remote add origin https://github.com/YOUR_USER/browser-agent.git
git push -u origin main
```

---

## Step 2 — Gemini key secret me daalein

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | aapki key (aistudio.google.com/apikey) |

Optional — **Variables** tab me (secret nahi, plain):
| Name | Value |
|---|---|
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `MAX_STEPS` | `45` |

> Key code me kabhi nahi jaati — sirf secret me rehti hai.

---

## Step 3 — Dashboard on karein (GitHub Pages)

Repo → **Settings** → **Pages**

| Setting | Value |
|---|---|
| Source | **Deploy from a branch** |
| Branch | **main** |
| Folder | **/docs** |

Save → 1-2 minute → URL milega:

```
https://YOUR_USER.github.io/browser-agent/
```

---

## Step 4 — Token banayein (dashboard ke liye)

GitHub → **Settings** → **Developer settings** → **Personal access tokens** →
**Fine-grained tokens** → **Generate new token**

| Field | Value |
|---|---|
| Repository access | **Only select repositories** → `browser-agent` |
| Expiration | 90 days (ya jo chahiye) |

**Permissions** (Repository permissions):

| Permission | Level |
|---|---|
| **Issues** | Read and write |
| **Contents** | Read |
| **Actions** | Read and write |
| **Metadata** | Read (auto) |

Generate → token copy karein (`github_pat_...`).

> Token **sirf aapke browser** me localStorage me rehta hai. Kisi server pe nahi jaata.
> Isi liye dashboard ko public rakhna theek hai — token ke bina koi kuch nahi kar sakta.

---

## Step 5 — Dashboard configure karein

`https://YOUR_USER.github.io/browser-agent/` kholo → **⚙ Setup** tab →

- Owner: `YOUR_USER`
- Repo: `browser-agent`
- Branch: `main`
- Token: paste karein

**Save + Test** → `✓ Connected: your/repo · public ✓` aana chahiye.

---

## Step 6 — Pehla task

Chat me likhein:

> Hacker News pe aaj ke top 10 posts ka title aur link nikaalo, CSV banao

**Run** dabayein.

Kya hoga:
1. Issue ban jayegi (label `agent-task`)
2. Actions **1-2 minute** me start karega (queue)
3. Chromium install → agent chalta hai → 5-15 min
4. Issue pe **result comment** aayega, `agent-done` label lagega, issue close
5. Dashboard ke **Tasks** tab me result dikhega, **Files** tab me CSV

Progress live dekhna ho: repo → **Actions** tab.

---

## Step 7 — Roz automatic chalayein

`tasks/scheduled.txt` kholo (GitHub pe edit) aur apna task likh dein:

```
Roz Amazon pe mere 5 competitors ke price check karo, CSV banao.
```

Cron `.github/workflows/agent.yml` me set hai:

```yaml
- cron: "0 3 * * *"     # 03:00 UTC = 08:30 IST
```

Time badalna ho to wo line edit karein. Cron **UTC** me hota hai:
`IST = UTC + 5:30` → 9:00 IST = `30 3 * * *`

**Manually trigger:** dashboard → **Run scheduled now**

---

## Limits — honest list

| Cheez | Limit |
|---|---|
| Private repo cron | ❌ **chalta nahi** (free account) |
| Public repo | ✅ cron + **unlimited minutes** |
| Private repo minutes | 2000/month (cron fir bhi nahi) |
| Ek run ka max time | **6 ghante** (workflow 40 min pe capped hai) |
| Cron delay | busy times pe **10-30 min** late ho sakta hai |
| Artifact storage | 500 MB (30 din), outputs repo me bhi commit hote hain |
| Browser profile (logins) | Actions cache se persist hota hai, par cookies expire ho sakti hain |
| Screenshots | repo me commit nahi (size) — Actions artifacts me |

**Public repo ka matlab:** aapka code aur `outputs/` ki files sabko dikhengi.
Kuch sensitive ho to repo private karein aur GitHub Pro lein.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Cron kabhi trigger nahi hua | Repo **public** hai? (private pe cron dead hai) · `tasks/scheduled.txt` khaali nahi hai? · 15-20 min wait karein |
| `GEMINI_API_KEY set nahi hai` | Step 2 dobara — exact naam `GEMINI_API_KEY` |
| Workflow chala par issue pe comment nahi | Permissions me `issues: write` hai? (workflow file me already hai) |
| Dashboard "Token galat" | Naya token banayein — permissions check karein |
| Agent 40 min me ruk gaya | `MAX_STEPS` badhayein (Variable), ya task chhota karein |
| Chromium install fail | Actions runner ka issue — workflow dobara run karein |
| Login maangne wali site | Actions me headless hai, login mushkil. Laptop pe login karke `data/browser-profile` cache me daalein |
| Pages 404 | Settings → Pages → folder `/docs` chuna hai? 2 min wait |

---

## Laptop + cloud saath me

Same repo, do tarike:

| Tarika | Command | Kab |
|---|---|---|
| **Local server** (dashboard + scheduler) | `npm start` | Jab laptop on ho, live dekhna ho |
| **Cloud** (Actions + Pages) | GitHub pe push | 24x7 chahiye, phone se task dena ho |

Code same hai — `lib/` dono use karte hain. Local dashboard `http://localhost:3000`,
cloud dashboard `https://YOUR_USER.github.io/browser-agent/`.
