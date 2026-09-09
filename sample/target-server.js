'use strict';
// Tiny HTTP target for trying LoadPilot locally: node sample/target-server.js
// Serves /, /search and /login on port 9091 with realistic small delays.

const http = require('http');

const delay = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    await delay(10, 80);
    res.end('<h1>UMS demo home</h1>');
  } else if (url.pathname === '/search') {
    await delay(30, 200);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ q: url.searchParams.get('q'), results: 12 }));
  } else if (url.pathname === '/login' && req.method === 'POST') {
    await delay(20, 150);
    // 2% simulated failures so error stats have something to show
    if (Math.random() < 0.02) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'DB connection pool exhausted', requestId: 'demo-' + Date.now() }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token: 'demo-token' }));
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(9091, () => console.log('target server on http://localhost:9091'));
