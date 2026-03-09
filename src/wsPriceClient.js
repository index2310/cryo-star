// src/wsPriceClient.js — WebSocket client for real-time price feed
// Connects to wss://api.unhedged.gg/ws for live crypto prices
import WebSocket from 'ws';
import Logger from './logger.js';
import config from './config.js';

const log = new Logger(config.logLevel);

/**
 * Real-time price feed from Unhedged.gg WebSocket.
 * Subscribes to market rooms and receives crypto_price_update events.
 */
export class WSPriceClient {
  constructor() {
    this.ws = null;
    this.url = 'wss://api.unhedged.gg/ws';
    this.prices = new Map(); // asset -> { price, bid, ask, timestamp }
    this.priceHistory = new Map(); // asset -> [{ price, timestamp }]
    this.maxHistory = 500;
    this.listeners = new Map(); // event -> [callback]
    this.reconnectTimer = null;
    this.subscribedRooms = new Set();
  }

  connect() {
    return new Promise((resolve) => {
      log.info('🔌 Connecting to price WebSocket...');
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        log.info('🟢 WebSocket connected');
        // Re-subscribe to rooms
        for (const room of this.subscribedRooms) {
          this._send({ type: 'subscribe', room });
        }
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
        log.warn('🔴 WebSocket disconnected — reconnecting in 5s');
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      });

      this.ws.on('error', (err) => {
        log.error('WebSocket error:', err.message);
      });

      // Resolve after timeout if connection hangs
      setTimeout(() => resolve(false), 10000);
    });
  }

  /**
   * Subscribe to a market's price feed
   * @param {string} marketId - Market ID
   */
  subscribeMarket(marketId) {
    const room = `market:${marketId}`;
    this.subscribedRooms.add(room);
    this._send({ type: 'subscribe', room });
    log.debug(`Subscribed to ${room}`);
  }

  /**
   * Get latest price for an asset
   * @param {string} asset - e.g. "BTC", "ETH", "SOL"
   */
  getPrice(asset) {
    return this.prices.get(asset.toUpperCase()) || null;
  }

  /**
   * Get price history for an asset
   * @param {string} asset
   * @returns {Array<{price: number, timestamp: number}>}
   */
  getHistory(asset) {
    return this.priceHistory.get(asset.toUpperCase()) || [];
  }

  /**
   * Get closing prices array for technical analysis
   * @param {string} asset
   * @returns {number[]}
   */
  getCloses(asset) {
    return this.getHistory(asset).map(h => h.price);
  }

  /**
   * Register event listener
   * @param {'price'|'connected'|'subscribed'} event
   * @param {function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  _handleMessage(msg) {
    if (msg.type === 'crypto_price_update' && msg.data) {
      const { asset, price, bid, ask, timestamp } = msg.data;
      const key = asset.toUpperCase();

      // Update latest price
      this.prices.set(key, { price, bid, ask, timestamp });

      // Add to history
      if (!this.priceHistory.has(key)) this.priceHistory.set(key, []);
      const history = this.priceHistory.get(key);
      history.push({ price, timestamp });
      if (history.length > this.maxHistory) history.shift();

      // Emit to listeners
      this._emit('price', { asset: key, price, bid, ask, timestamp });
    }

    if (msg.type === 'connected') {
      log.debug(`WS: ${msg.message}`);
      this._emit('connected', msg);
    }

    if (msg.type === 'subscribed') {
      log.debug(`WS: Subscribed to ${msg.room}`);
      this._emit('subscribed', msg);
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

  close() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default WSPriceClient;
