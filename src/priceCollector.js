// src/priceCollector.js — Real-time price data from CoinGecko & Binance
import axios from 'axios';
import Logger from './logger.js';
import config from './config.js';

const log = new Logger(config.logLevel);

/**
 * Price data collector for Canton Coin and other assets.
 * Supports CoinGecko (free) and Binance APIs.
 */
export class PriceCollector {
  constructor() {
    this.cache = new Map(); // symbol -> { price, timestamp }
    this.cacheTTL = 10_000; // 10 seconds
    this.priceHistory = new Map(); // symbol -> [{ price, timestamp }]
    this.maxHistoryLength = 500;
  }

  /**
   * Get the current price of Canton Coin (CC/USD)
   */
  async getCantonCoinPrice() {
    return this.getPrice('canton-coin', 'canton');
  }

  /**
   * Get current price from the best available source
   */
  async getPrice(coinId, symbol = '') {
    const cacheKey = coinId;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.price;
    }

    let price = null;

    try {
      price = await this._fetchFromCoinGecko(coinId);
    } catch (err) {
      log.warn(`CoinGecko fetch failed for ${coinId}:`, err.message);
    }

    // Fallback: try Binance if applicable
    if (price === null && symbol) {
      try {
        price = await this._fetchFromBinance(`${symbol.toUpperCase()}USDT`);
      } catch (err) {
        log.warn(`Binance fetch failed for ${symbol}:`, err.message);
      }
    }

    if (price !== null) {
      this.cache.set(cacheKey, { price, timestamp: Date.now() });
      this._addToHistory(cacheKey, price);
      log.debug(`Price for ${coinId}: $${price}`);
    }

    return price;
  }

  /**
   * Get price history for technical analysis
   */
  getPriceHistory(coinId) {
    return this.priceHistory.get(coinId) || [];
  }

  /**
   * Get OHLCV candle data from CoinGecko
   * @param {string} coinId - CoinGecko coin ID
   * @param {number} days - Number of days of data
   */
  async getOHLCV(coinId, days = 1) {
    try {
      const resp = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`,
        {
          params: { vs_currency: 'usd', days },
          timeout: 10000,
          headers: { Accept: 'application/json' },
        }
      );

      // CoinGecko returns [[timestamp, open, high, low, close], ...]
      return resp.data.map(([timestamp, open, high, low, close]) => ({
        timestamp,
        open,
        high,
        low,
        close,
        date: new Date(timestamp),
      }));
    } catch (err) {
      log.error(`OHLCV fetch failed for ${coinId}:`, err.message);
      return [];
    }
  }

  /**
   * Get historical prices (close prices array for TA)
   */
  async getHistoricalPrices(coinId, days = 1) {
    try {
      const resp = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`,
        {
          params: { vs_currency: 'usd', days, interval: days <= 1 ? '' : 'daily' },
          timeout: 10000,
          headers: { Accept: 'application/json' },
        }
      );

      return resp.data.prices.map(([timestamp, price]) => ({
        timestamp,
        price,
        date: new Date(timestamp),
      }));
    } catch (err) {
      log.error(`Historical prices failed for ${coinId}:`, err.message);
      return [];
    }
  }

  /**
   * Calculate basic price statistics
   */
  calcStats(prices) {
    if (!prices.length) return null;

    const values = prices.map((p) => (typeof p === 'number' ? p : p.price));
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[n - 1];

    // Returns over intervals
    const returns = [];
    for (let i = 1; i < values.length; i++) {
      returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }

    const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const returnStdDev = returns.length
      ? Math.sqrt(returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / returns.length)
      : 0;

    return {
      count: n,
      mean,
      stdDev,
      min,
      max,
      latest: values[n - 1],
      avgReturn,
      returnStdDev,
      volatility: returnStdDev, // used for probability calculations
    };
  }

  // Private methods

  async _fetchFromCoinGecko(coinId) {
    const resp = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price`,
      {
        params: { ids: coinId, vs_currencies: 'usd' },
        timeout: 10000,
        headers: { Accept: 'application/json' },
      }
    );

    const price = resp.data?.[coinId]?.usd;
    if (price === undefined) throw new Error(`No price data for ${coinId}`);
    return price;
  }

  async _fetchFromBinance(symbol) {
    const resp = await axios.get(
      `https://api.binance.com/api/v3/ticker/price`,
      {
        params: { symbol },
        timeout: 10000,
      }
    );

    return parseFloat(resp.data.price);
  }

  _addToHistory(coinId, price) {
    if (!this.priceHistory.has(coinId)) {
      this.priceHistory.set(coinId, []);
    }

    const history = this.priceHistory.get(coinId);
    history.push({ price, timestamp: Date.now() });

    // Trim
    if (history.length > this.maxHistoryLength) {
      history.splice(0, history.length - this.maxHistoryLength);
    }
  }
}

export default PriceCollector;
