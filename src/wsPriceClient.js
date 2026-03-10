// src/wsPriceClient.js — v5.0 WebSocket client for real-time price feed
// v5.0: Global subscription, exponential backoff reconnect, bid/ask spread tracking
import WebSocket from 'ws';
import Logger from './logger.js';
import config from './config.js';

const log = new Logger(config.logLevel);

/**
 * Real-time price feed from Unhedged.gg WebSocket.
 * v5.0: Subscribe to global room, exponential backoff, spread tracking
 */
export class WSPriceClient {
  constructor() {
    this.ws = null;
    this.url = 'wss://api.unhedged.gg/ws';
    this.prices = new Map();       // asset -> { price, bid, ask, spread, timestamp }
    this.priceHistory = new Map(); // asset -> [{ price, timestamp }]
    this.maxHistory = 500;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.subscribedRooms = new Set();

    // v5.0: Exponential backoff
    this._reconnectAttempts = 0;
    this._maxReconnectDelay = 60_000; // 60s cap
    this._baseReconnectDelay = 5_000; // 5s start

    // v5.0: Heartbeat
    this._heartbeatInterval = null;
  }

  connect() {
    return new Promise((resolve) => {
      log.info('🔌 Connecting to price WebSocket...');
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        log.info('🟢 WebSocket connected');
        this._reconnectAttempts = 0; // reset backoff

        // Re-subscribe to rooms
        for (const room of this.subscribedRooms) {
          this._send({ type: 'subscribe', room });
        }

        // v5.0: Start heartbeat
        this._startHeartbeat();

        resolve(true);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch {
          // ignore non-JSON
        }
      });

      this.ws.on('close', () => {
        this._stopHeartbeat();
        // v5.0: Exponential backoff reconnect
        this._reconnectAttempts++;
        const delay = Math.min(
          this._baseReconnectDelay * Math.pow(2, this._reconnectAttempts - 1),
          this._maxReconnectDelay
        );
        log.warn(`🔴 WebSocket disconnected — reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this._reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      });

      this.ws.on('error', (err) => {
        log.error('WebSocket error:', err.message);
      });

      setTimeout(() => resolve(false), 10000);
    });
  }

  /**
   * v5.0: Subscribe to global room for all crypto prices
   */
  subscribeGlobal() {
    this.subscribedRooms.add('global');
    this._send({ type: 'subscribe', room: 'global' });
    log.info('🌐 Subscribed to global price feed');
  }

  /**
   * Subscribe to a market's price feed
   */
  subscribeMarket(marketId) {
    const room = `market:${marketId}`;
    this.subscribedRooms.add(room);
    this._send({ type: 'subscribe', room });
    log.debug(`Subscribed to ${room}`);
  }

  /**
   * Get latest price for an asset
   */
  getPrice(asset) {
    return this.prices.get(asset.toUpperCase()) || null;
  }

  /**
   * v5.0: Get bid/ask spread as a micro-volatility signal
   * Returns: spread as fraction (e.g. 0.001 = 0.1%)
   */
  getSpread(asset) {
    const data = this.prices.get(asset.toUpperCase());
    if (!data || !data.bid || !data.ask) return null;
    return (data.ask - data.bid) / ((data.ask + data.bid) / 2);
  }

  /**
   * Get price history for an asset
   */
  getHistory(asset) {
    return this.priceHistory.get(asset.toUpperCase()) || [];
  }

  /**
   * Get closing prices array for technical analysis
   */
  getCloses(asset) {
    return this.getHistory(asset).map(h => h.price);
  }

  /**
   * Register event listener
   */
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  _handleMessage(msg) {
    if (msg.type === 'crypto_price_update' && msg.data) {
      const { asset, price, bid, ask, timestamp } = msg.data;
      const key = asset.toUpperCase();

      // v5.0: Track spread
      const spread = (bid && ask) ? (ask - bid) / ((ask + bid) / 2) : null;

      // Update latest price
      this.prices.set(key, { price, bid, ask, spread, timestamp });

      // Add to history
      if (!this.priceHistory.has(key)) this.priceHistory.set(key, []);
      const history = this.priceHistory.get(key);
      history.push({ price, timestamp });
      if (history.length > this.maxHistory) history.shift();

      this._emit('price', { asset: key, price, bid, ask, spread, timestamp });
    }

    if (msg.type === 'connected') {
      log.debug(`WS: ${msg.message}`);
      this._emit('connected', msg);
    }

    if (msg.type === 'subscribed') {
      log.debug(`WS: Subscribed to ${msg.room}`);
      this._emit('subscribed', msg);
    }

    // v5.0: Handle pong for heartbeat
    if (msg.type === 'pong') {
      this._lastPong = Date.now();
    }
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event) || [];
    cbs.forEach(cb => cb(data));
  }

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // v5.0: Heartbeat to detect zombie connections
  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastPong = Date.now();
    this._heartbeatInterval = setInterval(() => {
      if (Date.now() - this._lastPong > 90_000) { // 90s without pong
        log.warn('💀 WebSocket zombie detected — forcing reconnect');
        this.ws?.terminate();
        return;
      }
      this._send({ type: 'ping' });
    }, 30_000); // ping every 30s
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  close() {
    this._stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default WSPriceClient;
