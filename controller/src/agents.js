'use strict';
/**
 * AgentHub — tracks connected agent PCs over WebSocket.
 * Agents connect OUTBOUND to the controller (ws://controller:port/ws/agent),
 * so worker PCs need no inbound firewall rules.
 */

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

      if (msg.type === 'hello') {
        name = String(msg.name || 'agent').replace(/[^\w.-]/g, '_');
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
          info: {
            name,
            platform: msg.platform,
            cpus: msg.cpus,
            memGB: msg.memGB,
            version: msg.agentVersion,
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
        a.state = msg.state;
        a.runId = msg.runId || null;
        // an agent that has bootstrapped JMeter re-reports readiness here
        if (msg.jmeterReady !== undefined) a.info.jmeterReady = !!msg.jmeterReady;
        this.onChange();
      }
      if (msg.type === 'resStats' && a) {
        // live CPU/RAM so the UI can flag a saturated (untrustworthy) generator.
        // Sent as a lightweight per-agent update — NOT a full agent-list rebroadcast,
        // which would re-render the whole New Run form every 2s (closing open dropdowns).
        a.info.res = { cpu: msg.cpu, mem: msg.mem, memUsedGB: msg.memUsedGB, memTotalGB: msg.memTotalGB, at: Date.now() };
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
    a.ws.send(JSON.stringify(msg));
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
