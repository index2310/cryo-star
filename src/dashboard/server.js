// src/dashboard/server.js — Dashboard HTTP + WebSocket server
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import config from '../config.js';
import Logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = new Logger(config.logLevel);

export class DashboardServer {
  constructor(port = config.dashboardPort) {
    this.port = port;
    this.clients = new Set();
    this.server = null;
    this.wss = null;
  }

  start() {
    // HTTP server for the dashboard HTML
    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    // WebSocket server
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      log.debug('Dashboard client connected');

      ws.on('close', () => {
        this.clients.delete(ws);
        log.debug('Dashboard client disconnected');
      });
    });

    this.server.listen(this.port, () => {
      log.info(`📊 Dashboard: http://localhost:${this.port}`);
    });
  }

  // Broadcast to all connected dashboard clients
  broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }

  broadcastSignal(signal) {
    this.broadcast('signal', signal);
  }

  broadcastStats(stats) {
    this.broadcast('stats', stats);
  }

  broadcastTrades(trades) {
    this.broadcast('trades', trades);
  }

  broadcastMode(mode) {
    this.broadcast('mode', mode);
  }

  stop() {
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }
}

export default DashboardServer;
