'use strict';
/**
 * AgentHub — tracks connected agent PCs over WebSocket.
 * Agents connect OUTBOUND to the controller (ws://controller:port/ws/agent),
 * so worker PCs need no inbound firewall rules.
 */

const AGENT_STATES = new Set(['idle', 'running', 'preparing']);
/** A finite number within [min, max], else null. */
function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

class AgentHub {
  constructor() {
    this.agents = new Map(); // name -> {ws, info, state, runId, lastSeen}
    this.onChange = () => {};
    this.onResStats = () => {}; // lightweight CPU/RAM update (no full re-render)
    this.onAgentMessage = () => {};
    this.onAgentLost = () => {};
  }

  attach(ws, req) {
    let name = null;

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return; // e.g. the JSON text "null"

      if (msg.type === 'hello') {
        name = String(msg.name || 'agent').replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 64) || 'agent';
        // If a live connection already claims this name, suffix the newcomer.
        const existing = this.agents.get(name);
        if (existing && existing.ws.readyState === existing.ws.OPEN && existing.ws !== ws) {
          let i = 2;
          while (this.agents.has(`${name}-${i}`)) i++;
          name = `${name}-${i}`;
          ws.send(JSON.stringify({ type: 'renamed', name }));
        }
        this.agents.set(name, {
          ws,
          // Anything an agent says about itself is untrusted (no auth on /ws/agent):
          // numbers stay numbers and text stays short plain text.
          info: {
            name,
            platform: String(msg.platform || '').slice(0, 80),
            cpus: num(msg.cpus, 0, 4096),
            memGB: num(msg.memGB, 0, 1e5),
            version: String(msg.agentVersion || '').slice(0, 20),
            jmeterReady: !!msg.jmeterReady,
            stub: !!msg.stub,
            address: req.socket.remoteAddress,
          },
          state: 'idle',
          runId: null,
          lastSeen: Date.now(),
        });
        this.onChange();
        return;
      }

      if (!name) return; // ignore anything before hello
      const a = this.agents.get(name);
      if (a) a.lastSeen = Date.now();

      if (msg.type === 'status' && a) {
        a.state = AGENT_STATES.has(msg.state) ? msg.state : 'idle';
        a.runId = msg.runId ? String(msg.runId).slice(0, 80) : null;
        // an agent that has bootstrapped JMeter re-reports readiness here
        if (msg.jmeterReady !== undefined) a.info.jmeterReady = !!msg.jmeterReady;
        this.onChange();
      }
      if (msg.type === 'resStats' && a) {
        // live CPU/RAM so the UI can flag a saturated (untrustworthy) generator.
        // Sent as a lightweight per-agent update — NOT a full agent-list rebroadcast,
        // which would re-render the whole New Run form every 2s (closing open dropdowns).
        a.info.res = { cpu: num(msg.cpu, 0, 100), mem: num(msg.mem, 0, 100), memUsedGB: num(msg.memUsedGB, 0, 1e5), memTotalGB: num(msg.memTotalGB, 0, 1e5), at: Date.now() };
        this.onResStats(name, a.info.res);
      }
      this.onAgentMessage(name, msg);
    });

    ws.on('close', () => {
      if (!name) return;
      const a = this.agents.get(name);
      if (a && a.ws === ws) {
        this.agents.delete(name);
        this.onChange();
        if (a.runId) this.onAgentLost(name, a.runId);
      }
    });

    ws.on('error', () => { /* close handler does the cleanup */ });
  }

  send(name, msg) {
    const a = this.agents.get(name);
    if (!a || a.ws.readyState !== a.ws.OPEN) return false;
    try { a.ws.send(JSON.stringify(msg)); } catch { return false; }
    // Busy from the moment the job is sent: if the socket turns out to be dead
    // before the agent ever answers, its close still ends the run (onAgentLost).
    if (msg.type === 'job') { a.runId = msg.runId; a.state = 'running'; }
    return true;
  }

  list() {
    return [...this.agents.values()].map((a) => ({
      ...a.info,
      state: a.state,
      runId: a.runId,
      lastSeen: a.lastSeen,
    }));
  }

  /** Drop connections that stopped responding to pings (~2 intervals of tolerance). */
  startHeartbeat(intervalMs = 30000) {
    setInterval(() => {
      for (const [, a] of this.agents) {
        if (a.ws.readyState !== a.ws.OPEN) continue;
        if (a.isAlive === false) { a.ws.terminate(); continue; }
        a.isAlive = false;
        a.ws.ping();
        a.ws.once('pong', () => { a.isAlive = true; a.lastSeen = Date.now(); });
      }
    }, intervalMs).unref();
  }
}

module.exports = { AgentHub };
