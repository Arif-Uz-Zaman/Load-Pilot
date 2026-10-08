# LoadPilot

**Self-hosted distributed JMeter load testing** — upload a `.jmx`, spread the load across as many office/lab PCs as you want, and watch a live dashboard. No JMeter, Java, or install needed on the worker PCs: they bootstrap everything themselves from the controller.

![LoadPilot run results](docs/images/09-run-detail.png)

> **New to LoadPilot?** Read the **[User guide](docs/USER-GUIDE.md)** — every screen explained with screenshots, step-by-step recipes, and what LoadPilot can and can't do.

> **Platform note:** LoadPilot is a **Windows** application built with Node.js and packaged into standalone `.exe` files (there is no Android `.apk` — "build the app" here means **building the `.exe` + installer**, covered below).

---

## Table of contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Tech stack — how it was built](#tech-stack--how-it-was-built)
- [Running from source (development)](#running-from-source-development)
- [Try it locally with the demo plan](#try-it-locally-with-the-demo-plan)
- [Build everything in one step](#build-everything-in-one-step)
- [Building the executables](#building-the-executables)
- [Building the installers](#building-the-installers)
- [Deploying / installing](#deploying--installing)
- [Stopping the controller](#stopping-the-controller)
- [Updating agents](#updating-agents)
- [Upgrading JMeter](#upgrading-jmeter)
- [Managing agents (portable controller)](#managing-agents-portable-controller)
- [Data & configuration locations](#data--configuration-locations)
- [Key features](#key-features)
- [Known limitations](#known-limitations)

---

## What it does

1. **Upload a JMeter test plan** (`.jmx`) in the web UI.
2. **Pick the worker PCs (agents)** that should generate load, and choose how to split the work:
   - **Even split** — the controller divides threads/rate evenly across agents.
   - **Per-agent profiles** — give each agent its own workload (different samplers, threads, rate).
3. **Start the run.** The controller prepares each agent's copy of the plan, dispatches jobs, and streams live results.
4. **Watch the live dashboard** (virtual users, throughput, response times, errors — per sampler and per thread group) and get a full **post-run report** you can export to Excel or auto-append to a **Google Sheet**.
5. **Find out why requests failed** — the Errors tab groups every failure and shows the real request and response, with the assertion explained in plain words.

---

## Screenshots

*(From the demo setup in [`sample/`](#try-it-locally-with-the-demo-plan) — three agents load-testing a local demo site.)*

| | |
|---|---|
| **Home** — readiness, today's runs, fleet health<br>![Home](docs/images/01-home.png) | **New run · Workload** — users per thread group and the request tree<br>![Workload](docs/images/04-new-run-step2-workload.png) |
| **New run · Review** — summary and pre-flight checks<br>![Review](docs/images/06-new-run-step4-review.png) | **Live monitor** — numbers and charts while the test runs<br>![Live](docs/images/07-live-monitor.png) |
| **Errors** — failures grouped, with request + response<br>![Errors](docs/images/11-run-errors.png) | **Compare** — two runs side by side<br>![Compare](docs/images/14-compare.png) |
| **Agents & teams**<br>![Agents](docs/images/16-agents.png) | **Reports** — Excel-style report, export to .xlsx<br>![Reports](docs/images/19-reports.png) |

Every screen is explained in the **[User guide](docs/USER-GUIDE.md)**.

---

## How it works

```
                 ┌──────────────────────────────────────────────┐
                 │                CONTROLLER PC                  │
                 │   loadpilot-controller.exe  (web UI :4000)    │
                 │   • parses the JMX                            │
                 │   • splits work across agents                 │
                 │   • dispatches jobs, aggregates results       │
                 │   • bundles JMeter + JRE for agents           │
                 └───────────────┬──────────────────────────────┘
             WebSocket (ws://…:4000/ws/agent)   ▲  outbound from each agent
        ┌───────────────┬────────┴────────┬───────────────┐
        ▼               ▼                 ▼               ▼
   ┌─────────┐     ┌─────────┐       ┌─────────┐     ┌─────────┐
   │ Agent PC│     │ Agent PC│  ...  │ Agent PC│     │ Agent PC│
   │ .exe    │     │ .exe    │       │ .exe    │     │ .exe    │
   │ runs    │     │ runs    │       │ runs    │     │ runs    │
   │ JMeter  │     │ JMeter  │       │ JMeter  │     │ JMeter  │
   └─────────┘     └─────────┘       └─────────┘     └─────────┘
```

**Run lifecycle:**

1. Each **agent** connects **outbound** to the controller over a WebSocket (`/ws/agent`) — so worker PCs need **no inbound firewall rules** just to participate. On its first job an agent that lacks JMeter/Java **downloads the bundles** (`/bundle/jmeter.zip`, `/bundle/jre.zip`) from the controller and extracts them locally.
2. The **controller** parses the uploaded JMX, computes each agent's share (rewriting thread counts / bzm target rates via JMeter `-J` properties like `lp_threads_N`), and sends each agent a job with the prepared plan + any data files.
3. Agents run JMeter **headless** (`-n`), tail the `.jtl` results file, and stream live sample rows back over the WebSocket. CPU/RAM is streamed too, so the controller can flag a saturated (untrustworthy) load generator.
4. When the run ends, each agent uploads its full `.jtl` (and any captured error responses). The controller merges everything, computes the summary, and renders the dashboard/report.

---

## Architecture

### Controller (`controller/`)

A single Node.js process that is both an **HTTP API + static web UI** and a **WebSocket hub**.

| Module | Responsibility |
|---|---|
| `src/server.js` | Express app, REST API, WebSocket upgrade, static UI, run orchestration wiring |
| `src/agents.js` | `AgentHub` — tracks connected agents, their state, live CPU/RAM, dispatch |
| `src/runs.js` | `RunManager` — prepares per-agent plans, splits load, tracks run state, JMeter discovery |
| `src/jmx.js` | JMX parser/rewriter (thread groups, samplers, controllers, CSV, pre/post processors, variables) |
| `src/stats.js` | JTL parsing, live windowed aggregation, per-label/timeline summaries |
| `src/report.js` / `src/xlsx.js` | Excel-style report store and `.xlsx` export |
| `src/scheduler.js` | Scheduled / recurring runs |
| `src/config.js` | Reads/writes `config.json` (port, data/runtime/bundle dirs) |
| `src/fsutil.js` | Crash-safe JSON writes (temp file + rename) for settings, library and schedules |

- **Web UI** is plain HTML/CSS/vanilla JS in `controller/public/` — bundled **into** the exe as pkg assets, so a UI change requires a rebuild.
- **Frontend ↔ backend**: REST (`/api/*`) + two WebSockets (`/ws/agent` for agents, `/ws/ui` for live browser updates).
- **Default port `4000`** (configurable in `config.json`).

### Agent (`agent/`)

A single, **windowless** Node.js exe (`src/agent.js`) that runs in the background on each worker PC.

- Connects **outbound** to the controller (`ws://<controller>:4000/ws/agent`); auto-reconnects if the controller restarts.
- **Self-bootstrapping**: downloads and extracts JMeter (and a JRE if Java is missing) from the controller on first use.
- **Control endpoint on TCP `4101`** (`/lp-agent/ping`, `/lp-agent/set-controller`): lets a controller *discover* the agent on the LAN and *redirect* it to a different controller. A redirect must be a real JSON request (no CORS, so a web page can't trigger it) and the agent only switches to an address it can reach. See [Managing agents](#managing-agents-portable-controller).
- **Keeps worker PCs tidy**: only the last 5 run folders stay in `work/`; the controller holds the real copies.
- **Self-installer**: `loadpilot-agent.exe --install <controller-url>` registers a startup task and opens the firewall port; `--uninstall` removes them.

### Communication summary

| Channel | Direction | Purpose |
|---|---|---|
| `ws://controller:4000/ws/agent` | agent → controller | register, receive jobs, stream samples + CPU/RAM |
| `ws://controller:4000/ws/ui` | browser → controller | live dashboard updates |
| `http://controller:4000/bundle/*` | agent → controller | download JMeter / JRE bundles |
| `http://controller:4000/api/runs/:id/results` | agent → controller | upload final `.jtl` |
| `http://agent:4101/lp-agent/*` | controller → agent | discovery + redirect (portable controller) |

---

## Repository layout

```
loadpilot/
├── controller/
│   ├── src/                 # controller Node.js source (see table above)
│   ├── public/              # web UI (index.html, app.js, style.css) — bundled into the exe
│   ├── bundles/
│   │   └── jmeter.zip        # JMeter bundle agents download (+ optional jre.zip)
│   ├── data/                 # runtime data (plans, runs, reports, config) — created at run time
│   ├── package.json
│   └── dist/                 # build output: loadpilot-controller.exe
├── agent/
│   ├── src/agent.js
│   ├── hide-console.js       # post-build: flips the exe PE subsystem to GUI (windowless)
│   ├── install-service.bat   # optional manual startup-task installer
│   ├── update-agent.bat      # one-click agent update on a worker PC (self-elevates)
│   ├── update-agent.ps1      #   …keeps the PC's agent names, count and controller URL
│   ├── uninstall-agent.bat
│   ├── package.json
│   └── dist/                 # build output: loadpilot-agent.exe
├── installer/
│   ├── loadpilot.iss         # Inno Setup script → LoadPilot-Setup.exe (controller)
│   ├── agent.iss             # Inno Setup script → LoadPilot-Agent-Setup.exe (agent)
│   └── dist/                 # build output: the Setup .exe installers
├── sample/
│   ├── target-server.js      # tiny local website to load-test (port 9091)
│   ├── demo-portal.jmx       # demo plan: CSV logins, extractor, assertions, 3 thread groups
│   ├── students.csv          # fake accounts for the demo plan
│   └── sample-plan.jmx       # minimal plan
├── docs/
│   ├── USER-GUIDE.md         # how to use every screen, recipes, can / can't
│   └── images/               # screenshots used by the docs
├── build.bat                 # one-step build: both exes + both installers (double-click)
├── build.ps1                 #   …the script build.bat runs
└── README.md
```

---

## Tech stack — how it was built

- **Runtime:** Node.js (no framework on the frontend — vanilla JS/HTML/CSS).
- **HTTP/API:** [Express](https://expressjs.com/) 4.
- **Realtime:** [`ws`](https://github.com/websockets/ws) WebSockets.
- **XML/JMX:** [`@xmldom/xmldom`](https://github.com/xmldom/xmldom) for parsing/rewriting the test plan.
- **Load engine:** [Apache JMeter](https://jmeter.apache.org/) (bundled as `jmeter.zip`), run headless on agents.
- **Packaging:** [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) compiles each Node app into a **single self-contained `.exe`** (target `node22-win-x64`) — no Node install needed on target PCs.
- **Windowless agent:** `agent/hide-console.js` patches the built exe's PE header (console → GUI subsystem) so the background agent shows no console window.
- **Installers:** [Inno Setup 6](https://jrsoftware.org/isinfo.php) wizards (`.iss` scripts).

**Why single-exe?** Worker PCs only ever need one file. No Node, no Python, no JMeter, no Java preinstalled — the agent pulls what it needs from the controller.

---

## Running from source (development)

Requires **Node.js 18+** installed.

```bash
# --- controller ---
cd controller
npm install
npm start                 # serves the UI on http://localhost:4000

# --- agent (in another terminal) ---
cd agent
npm install
npm start -- http://localhost:4000 --name dev-agent
#   add --stub to fake load without a real JMeter (quick UI testing)
```

Open <http://localhost:4000> in a browser. Any UI edit under `controller/public/` is picked up on refresh when running from source (when running the built exe, the UI is bundled in, so you must rebuild).

---

## Try it locally with the demo plan

Everything runs on your own PC and only talks to `localhost` — no real system is load-tested.

```bash
node sample/target-server.js          # 1. the demo website on http://localhost:9091
# 2. start the controller (above) and one or more agents, e.g. --name Lab-PC-01
```

3. Open the UI → **New run** → upload `sample/demo-portal.jmx`.
4. Step 3: attach `sample/students.csv` for the *Student accounts* data file.
5. Start. The demo site fails ~2% of logins with a `500`, so the **Errors** tab has something to show.

The screenshots in this README and the user guide were taken exactly this way.

---

## Build everything in one step

**Double-click `build.bat`** in the repository folder. It builds both executables and both installers, and opens `installer\dist` when it's done:

| Output | Install it on |
|---|---|
| `installer\dist\LoadPilot-Setup.exe` | the controller PC |
| `installer\dist\LoadPilot-Agent-Setup.exe` | each worker PC |

What it does, in order (stopping with a red message at the first problem):

1. Checks for **Node.js 18+** and **Inno Setup 6** (offers to install Inno Setup with `winget` if it's missing), that `controller\bundles\jmeter.zip` and `jre.zip` and every other file the installers pack are present, and that no LoadPilot program is running from the `dist` folders.
2. Installs the npm packages and builds `controller\dist\loadpilot-controller.exe`.
3. Installs the npm packages and builds `agent\dist\loadpilot-agent.exe` (windowless).
4. Compiles `installer\loadpilot.iss` → `LoadPilot-Setup.exe`.
5. Compiles `installer\agent.iss` → `LoadPilot-Agent-Setup.exe`.
6. Checks every output was freshly written.

The first build needs internet access (npm packages and pkg's Node base runtime are downloaded once and cached); later builds take about a minute. Run `build.bat -SkipNpmInstall` to reuse the installed packages and build offline. From PowerShell: `powershell -ExecutionPolicy Bypass -File build.ps1`.

The two sections below are the same steps done by hand.

---

## Building the executables

> This is the "build the app" step. Output is a Windows `.exe`, not an `.apk`. `build.bat` does this for you — see [Build everything in one step](#build-everything-in-one-step).

> [!WARNING]
> **Do not install the executable files yet.** After building them, follow the steps in [Building the installers](#building-the-installers) to create the installer packages.

Prerequisites: **Node.js 18+** (pkg downloads the `node22-win-x64` base runtime automatically on first build).

```bash
# Controller → controller/dist/loadpilot-controller.exe
cd controller
npm install
npm run build

# Agent → agent/dist/loadpilot-agent.exe  (then patched to run windowless)
cd ../agent
npm install
npm run build
```

Under the hood:

- `controller`: `npx @yao-pkg/pkg . --output dist/loadpilot-controller.exe`
  (bundles `public/**/*` and `src/**/*.js` per the `pkg` block in `package.json`).
- `agent`: `npx @yao-pkg/pkg . --output dist/loadpilot-agent.exe && node hide-console.js dist/loadpilot-agent.exe`
  (the second step makes it windowless).

**Deploy an update in place** (no installer needed): stop the running controller (make sure no test is running), copy the fresh exe over the deployed one, restart. Example used during development:

```powershell
Invoke-RestMethod -Method Post http://localhost:4000/api/shutdown -ContentType application/json -Body '{}'
Start-Sleep -Seconds 2   # Windows keeps the exe locked for a moment after it exits
Copy-Item controller\dist\loadpilot-controller.exe D:\LoadPilot\loadpilot-controller.exe -Force
Start-Process D:\LoadPilot\loadpilot-controller.exe -WorkingDirectory D:\LoadPilot
```

User data in `data/` is never touched by swapping the exe. Browsers need **Ctrl+F5** once to load the new UI. To update agents see [Updating agents](#updating-agents).

---

## Building the installers

For polished first-time installs, the exes are wrapped in [Inno Setup](https://jrsoftware.org/isinfo.php) wizards (`build.bat` does this for you too). By hand: **build the exes first** (above), then compile:

```powershell
# Requires Inno Setup 6 (provides ISCC.exe)
$iscc = "C:\Users\<you>\AppData\Local\Programs\Inno Setup 6\ISCC.exe"   # or your install path

# Controller installer → installer/dist/LoadPilot-Setup.exe
& $iscc installer\loadpilot.iss

# Agent installer → installer/dist/LoadPilot-Agent-Setup.exe
& $iscc installer\agent.iss
```

- `loadpilot.iss` bundles `loadpilot-controller.exe`, `bundles/jmeter.zip`, `bundles/jre.zip`, the agent exe, and README into a wizard (per-user install, no admin required; user can pick any drive/folder).
- `agent.iss` installs the agent on a worker PC, asks for the controller URL + agent name + how many agents to run on that PC, and sets up auto-start at logon.

> **Important:** the installer packages are only current if you recompile them **after** rebuilding the exes. Reinstalling from a stale installer will roll the app back to that older build.

---

## Deploying / installing

**Controller PC (one machine, kept on):**
- Run `LoadPilot-Setup.exe` (or just drop `loadpilot-controller.exe` in a folder and run it).
- Give the PC a **static IP** so agents always find it. The console prints `Agents connect to: http://<ip>:4000`.
- Open the dashboard from any PC's browser at `http://<controller-ip>:4000`.

**Each worker PC (agent):** pick either method —
- **Self-installing exe (recommended for the portable-controller features):**
  ```
  loadpilot-agent.exe --install http://<controller-ip>:4000
  ```
  Opens firewall port `4101`, registers a boot startup task, starts immediately. Remove with `--uninstall`.
- **Wizard:** run `LoadPilot-Agent-Setup.exe`, enter the controller URL, choose auto-start.

Within seconds the PC appears under **Agents & teams**.

---

## Stopping the controller

- **From the web UI:** **Settings → General → Stop controller…**. If a test is running it asks again; stopping anyway tells the agents to stop JMeter first, and the run is kept as stopped/interrupted. Open pages show a "controller has stopped" banner and reconnect by themselves when it starts again.
- **From a script:** `POST /api/shutdown` with body `{}` (answers `409` while a test runs; send `{"force":true}` to stop anyway).
- **Started in a window:** close the window or press **Ctrl+C**.
- **Last resort:** end `loadpilot-controller.exe` in Task Manager, or `taskkill /IM loadpilot-controller.exe /F`. A run that was in progress is closed as *interrupted* on the next start, keeping whatever results arrived.

Agents stay installed and reconnect automatically when the controller is back.

---

## Updating agents

Agents don't update themselves yet. After building a new `loadpilot-agent.exe`, give each worker PC a folder with:

```
loadpilot-agent.exe
update-agent.bat
update-agent.ps1
```

and double-click **`update-agent.bat`** on the PC (it asks for administrator rights). It stops the running agents, replaces the exe, and re-registers the start-with-Windows tasks — keeping that PC's agent names, how many agents it runs, and its controller address. Nothing else needs doing on the PC.

---

## Upgrading JMeter

JMeter ships as **`controller/bundles/jmeter.zip`**. Agents and the controller each cache an extracted copy in their `runtime/` folder. LoadPilot **auto-upgrades** that cache: the controller exposes a bundle *fingerprint* (`GET /bundle/meta`, = zip size + mtime), each agent remembers the fingerprint it extracted (`runtime/.jmeter-bundle-version`), and when the fingerprint changes it re-downloads and replaces its JMeter automatically on the next run.

**To upgrade to a new JMeter version:**

1. **Build the new zip** — its root must contain `apache-jmeter-X.Y.Z/`. ⚠️ If your plans use plugins (bzm, etc.), zip **your team's JMeter folder that already has the plugin jars** in `lib/ext`, not vanilla Apache JMeter.
2. **Replace** `controller/bundles/jmeter.zip` (and the deployed copy, e.g. `D:\LoadPilot\bundles\jmeter.zip`).
3. **Restart the controller.** It re-extracts its own runtime automatically (fingerprint changed).
4. **That's it for agents** — each one detects the new fingerprint and re-downloads on its next job. No per-PC cache clearing.
5. **Rebuild `LoadPilot-Setup.exe`** so fresh installs ship the new JMeter.

Notes:
- Agents that are **offline** keep using their cached JMeter and upgrade whenever they next reach the controller — nothing breaks.
- Existing agents from before this feature **adopt** their current JMeter as the baseline (no needless ~90 MB re-download); they only re-download once you actually change the bundle.
- To upgrade the bundled **JRE** the same way, replace `bundles/jre.zip` (agents use system Java when present, so this is rarely needed).

---

## Managing agents (portable controller)

Because agents expose a control endpoint on port **4101**, no single controller PC has to be permanent:

- **Agents & teams → Controller & network** lets you **discover agents on the LAN**, list each worker PC, **tick which agents this controller owns**, and click **"Point ticked agents here."** The agents switch to whichever controller is running, and remember it after a reboot.
- Two controllers can run at once by ticking **disjoint** sets of agents — each drives its own agents in parallel.
- Redirect is **per-PC**: all agents on a PC follow together (they watch the shared `config.json`).

---

## Data & configuration locations

The controller keeps everything under its **data directory** (default `data/` next to the exe; shown read-only in **Settings**):

| Path | Contents |
|---|---|
| `data/plans/` | uploaded JMX plans + parsed structure |
| `data/runs/<id>/` | one folder per run: `meta.json`, `run.log`, each agent's `results-<agent>.jtl` + `errors-<agent>.xml` (captured failures), the merged `merged.jtl`, `summary.json`, and the JMeter `report/` |
| `data/library/` | reusable CSV data files (`files.json` is the index) |
| `data/reports/` | Excel-style reports |
| `data/jmeter-edit/` | temporary working copies for "Open in JMeter" |
| `data/schedules.json` | scheduled runs |
| `data/teams.json` | saved agent teams |
| `data/sheets.json` | Google Sheets sync config |
| `data/sla.json` | SLA thresholds |
| `data/agent-directory.json` | saved agent IPs + enable/redirect state |
| `config.json` (next to exe) | port, data/runtime/bundle dir overrides |

Agents keep their own `config.json`, downloaded `runtime/` (JMeter/JRE), `work/` (the last 5 runs' scratch folders), and `agent.log` next to the agent exe.

> **Don't commit `data/`, `runtime/` or any `config.json`.** They hold run results, captured server responses and uploaded CSVs (often real accounts). The repository's `.gitignore` excludes them.

---

## Key features

- Distributed load across many PCs, **even-split** or **per-agent profiles**.
- Full support for **bzm Arrivals/Concurrency** (rate/concurrency) thread groups, split as fractional rates so no agent stalls at rate 0.
- **Four-step New run wizard** (Plan → Workload → Agents → Review) with **pre-flight checks** that block a start that can't work.
- **Request tree** — every request with its CSV data, extractors, assertions and pre/post processors; tick requests and controllers on or off per run.
- **CSV test data per run**: the same file for every agent, rows split across agents, or a different file per agent — with a warning when agents would share accounts.
- **Live monitor**: virtual users, throughput, response times and errors per request, agent CPU/RAM with saturation and slow-network warnings, filter by thread group.
- **Results**: aggregate/summary reports, per-agent numbers, charts over time, every request, **agent** and **thread-group** filters, JMeter HTML dashboard, `.jtl` download, print.
- **Errors explorer** — failures grouped with true counts, every captured example with request + response, assertions explained in plain words, `NOT_FOUND` / unset-variable / shared-account plan problems flagged, Copy as cURL.
- **SLA verdict** (error rate, p90, throughput) on every run; **compare** any two runs.
- **Schedules** (daily, weekly, once), **teams** of agents, Excel-style **reports** exportable to `.xlsx`/CSV, optional **Google Sheets** auto-sync (Apps Script webhook).
- **Open in JMeter** — edit a copy of a plan in the bundled JMeter GUI, then re-import as a new plan.
- **No-preinstall agents** — JMeter/JRE bootstrapped on demand; agents run windowless and auto-start; one-click `update-agent.bat`.
- **Resilient**: agents get 30 s to reconnect after a network blip, runs interrupted by a controller restart are closed with the results that arrived, crash-safe settings files, results merged by streaming (no size limit).
- **Stop the controller from the UI**, light/dark theme.

---

## Known limitations

One test at a time per controller · no login/roles yet (anyone on the LAN can use the UI) · Windows only · JMeter `.jmx` plans with the plugins in the bundle · requests can be switched on/off but not edited in the UI · only CSV Data Set files are distributed to agents · agents don't self-update yet. The full list, with what to do about each, is in the user guide: **[What LoadPilot can't do](docs/USER-GUIDE.md#what-it-cant-do)**.

---

*LoadPilot is an internal tool. Build the exes, (optionally) compile the installers, run one controller, point agents at it, and load-test.*
