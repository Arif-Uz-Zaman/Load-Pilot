# LoadPilot

**Self-hosted distributed JMeter load testing** — upload a `.jmx`, spread the load across as many office/lab PCs as you want, and watch a live dashboard. No JMeter, Java, or install needed on the worker PCs: they bootstrap everything themselves from the controller.

> **Platform note:** LoadPilot is a **Windows** application built with Node.js and packaged into standalone `.exe` files (there is no Android `.apk` — "build the app" here means **building the `.exe` + installer**, covered below).

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Tech stack — how it was built](#tech-stack--how-it-was-built)
- [Running from source (development)](#running-from-source-development)
- [Building the executables](#building-the-executables)
- [Building the installers](#building-the-installers)
- [Deploying / installing](#deploying--installing)
- [Managing agents (portable controller)](#managing-agents-portable-controller)
- [Data & configuration locations](#data--configuration-locations)
- [Key features](#key-features)

---

## What it does

1. **Upload a JMeter test plan** (`.jmx`) in the web UI.
2. **Pick the worker PCs (agents)** that should generate load, and choose how to split the work:
   - **Even split** — the controller divides threads/rate evenly across agents.
   - **Per-agent profiles** — give each agent its own workload (different samplers, threads, rate).
3. **Start the run.** The controller prepares each agent's copy of the plan, dispatches jobs, and streams live results.
4. **Watch the live dashboard** (virtual users, throughput, response times, errors — per sampler and per thread group) and get a full **post-run report** you can export to Excel or auto-append to a **Google Sheet**.

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

- **Web UI** is plain HTML/CSS/vanilla JS in `controller/public/` — bundled **into** the exe as pkg assets, so a UI change requires a rebuild.
- **Frontend ↔ backend**: REST (`/api/*`) + two WebSockets (`/ws/agent` for agents, `/ws/ui` for live browser updates).
- **Default port `4000`** (configurable in `config.json`).

### Agent (`agent/`)

A single, **windowless** Node.js exe (`src/agent.js`) that runs in the background on each worker PC.

- Connects **outbound** to the controller (`ws://<controller>:4000/ws/agent`); auto-reconnects if the controller restarts.
- **Self-bootstrapping**: downloads and extracts JMeter (and a JRE if Java is missing) from the controller on first use.
- **Control endpoint on TCP `4101`** (`/lp-agent/ping`, `/lp-agent/set-controller`): lets a controller *discover* the agent on the LAN and *redirect* it to a different controller. See [Managing agents](#managing-agents-portable-controller).
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
│   ├── uninstall-agent.bat
│   ├── package.json
│   └── dist/                 # build output: loadpilot-agent.exe
├── installer/
│   ├── loadpilot.iss         # Inno Setup script → LoadPilot-Setup.exe (controller)
│   ├── agent.iss             # Inno Setup script → LoadPilot-Agent-Setup.exe (agent)
│   └── dist/                 # build output: the Setup .exe installers
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

## Building the executables

> This is the "build the app" step. Output is a Windows `.exe`, not an `.apk`.

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

**Deploy an update in place** (no installer needed): stop the running controller, copy the fresh exe over the deployed one, restart. Example used during development:

```powershell
Stop-Process -Name loadpilot-controller -Force
Copy-Item controller\dist\loadpilot-controller.exe D:\LoadPilot\loadpilot-controller.exe -Force
Start-Process D:\LoadPilot\loadpilot-controller.exe -WorkingDirectory D:\LoadPilot
```

To update agents, replace their `loadpilot-agent.exe` (or reinstall) — user data in `data/` is never touched by swapping the exe.

---

## Building the installers

For polished first-time installs, the exes are wrapped in [Inno Setup](https://jrsoftware.org/isinfo.php) wizards. **Build the exes first** (above), then compile:

```powershell
# Requires Inno Setup 6 (provides ISCC.exe)
$iscc = "C:\Users\<you>\AppData\Local\Programs\Inno Setup 6\ISCC.exe"   # or your install path

# Controller installer → installer/dist/LoadPilot-Setup.exe
& $iscc installer\loadpilot.iss

# Agent installer → installer/dist/LoadPilot-Agent-Setup.exe
& $iscc installer\agent.iss
```

- `loadpilot.iss` bundles `loadpilot-controller.exe`, `bundles/jmeter.zip`, the agent exe, and README into a wizard (per-user install, no admin required; user can pick any drive/folder).
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

Within seconds the PC appears under the **Agents** tab.

---

## Managing agents (portable controller)

Because agents expose a control endpoint on port **4101**, no single controller PC has to be permanent:

- **Settings → Portable controller** lets you **discover agents on the LAN**, list each worker PC, **tick which agents this controller owns**, and click **"Point ticked agents here."** The agents switch to whichever controller is running.
- Two controllers can run at once by ticking **disjoint** sets of agents — each drives its own agents in parallel.
- Redirect is **per-PC**: all agents on a PC follow together (they watch the shared `config.json`).

---

## Data & configuration locations

The controller keeps everything under its **data directory** (default `data/` next to the exe; shown read-only in **Settings**):

| Path | Contents |
|---|---|
| `data/plans/` | uploaded JMX plans + parsed structure |
| `data/runs/` | per-run results (`run.log`, `merged.jtl`, `report/`) |
| `data/library/` | reusable CSV data files |
| `data/reports/` | Excel-style reports |
| `data/jmeter-edit/` | temporary working copies for "Open in JMeter" |
| `data/sheets.json` | Google Sheets sync config |
| `data/sla.json` | SLA thresholds |
| `data/agent-directory.json` | saved agent IPs + enable/redirect state |
| `config.json` (next to exe) | port, data/runtime/bundle dir overrides |

Agents keep their own `config.json`, downloaded `runtime/` (JMeter/JRE), `work/` (per-run scratch), and `agent.log` next to the agent exe.

---

## Key features

- Distributed load across many PCs, **even-split** or **per-agent profiles**.
- Full support for **bzm Arrivals/Concurrency** (rate/concurrency) thread groups, split as fractional rates so no agent stalls at rate 0.
- **Live dashboard**: virtual users, throughput (overall + per sampler), response-time percentiles, errors — with **agent** and **thread-group** filters.
- **Plan tree** shows thread groups, samplers, controllers, **CSV Data Set Config**, and **pre/post processors**.
- **Open in JMeter** — edit a copy of a plan in the bundled JMeter GUI, then re-import as a new plan.
- **Reports** exportable to `.xlsx`, plus optional **Google Sheets** auto-sync (Apps Script webhook).
- **Scheduling** of recurring runs.
- **No-preinstall agents** — JMeter/JRE bootstrapped on demand; agents run windowless and auto-start.

---

*LoadPilot is an internal tool. Build the exes, (optionally) compile the installers, run one controller, point agents at it, and load-test.*
