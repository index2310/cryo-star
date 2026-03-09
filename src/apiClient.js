// src/apiClient.js — Unhedged.gg REST API Client (from official OpenAPI spec)
// Base: https://api.unhedged.gg
// Auth: Bearer ak_... token
// Docs: https://api.unhedged.gg/docs

import axios from 'axios';
import config from './config.js';
import Logger from './logger.js';

const log = new Logger(config.logLevel);

/**
 * Unhedged.gg API Client — built from the official Swagger/OpenAPI spec.
 *
 * Endpoints:
 *   GET  /api/v1/markets/           — List markets (status, category, tag, search, limit, offset, orderBy)
 *   GET  /api/v1/markets/:id        — Market details
 *   GET  /api/v1/markets/:id/stats  — Market stats & odds
 *   GET  /api/v1/markets/categories — Category list
 *   GET  /api/v1/markets/tags       — Tag cloud
 *   POST /api/v1/bets/              — Place bet { marketId, outcomeIndex, amount }
 *   GET  /api/v1/bets/              — List user bets
 *   GET  /api/v1/bets/:id           — Bet details
 *   GET  /api/v1/balance/           — User balance
 *   GET  /api/v1/portfolio/me       — Portfolio summary
 *   GET  /api/v1/health             — Health check
 *
 * WebSocket: wss://api.unhedged.gg/ws
 *   Rooms: "global", "market:{id}"
 *   Events: crypto_price_update { asset, price, bid, ask, timestamp }
 */
export class UnhedgedAPI {
  constructor() {
    this.apiBase = 'https://api.unhedged.gg';
    this.apiKey = config.unhedged.apiKey;

    this.http = axios.create({
      baseURL: this.apiBase,
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    this.http.interceptors.response.use(
      (res) => {
        log.debug(`← ${res.status} ${res.config.url}`);
        return res;
      },
      (err) => {
        log.error(`← ${err.response?.status || 'ERR'} ${err.config?.url}: ${err.response?.data?.error || err.message}`);
        throw err;
      }
    );
  }

  // ─── Markets ──────────────────────────────────────────────────────

  /**
   * List prediction markets
   * @param {object} params
   * @param {string} [params.status] - ACTIVE | ENDED | RESOLVED | VOIDED
   * @param {string} [params.category] - Filter by category
   * @param {string} [params.tag] - Filter by tag
   * @param {string} [params.search] - Search query
   * @param {number} [params.limit=20] - Results per page (1-100)
   * @param {number} [params.offset=0] - Pagination offset
   * @param {string} [params.orderBy] - createdAt | endTime | totalPool | betCount | payoutPool
   * @param {string} [params.orderDirection] - asc | desc
   */
  async getMarkets(params = {}) {
    try {
      const resp = await this.http.get('/api/v1/markets/', { params });
      return resp.data;
    } catch (err) {
      log.error('Failed to fetch markets:', err.message);
      return { markets: [], total: 0 };
    }
  }

  /**
   * Get active markets (convenience method)
   */
  async getActiveMarkets(limit = 100) {
    return this.getMarkets({ status: 'ACTIVE', limit, orderBy: 'endTime', orderDirection: 'asc' });
  }

  /**
   * Get market details by ID
   */
  async getMarketById(marketId) {
    try {
      const resp = await this.http.get(`/api/v1/markets/${marketId}`);
      return resp.data;
    } catch (err) {
      log.error(`Failed to fetch market ${marketId}:`, err.message);
      return null;
    }
  }

  /**
   * Get market statistics and odds
   */
  async getMarketStats(marketId) {
    try {
      const resp = await this.http.get(`/api/v1/markets/${marketId}/stats`);
      return resp.data;
    } catch (err) {
      log.error(`Failed to fetch market stats ${marketId}:`, err.message);
      return null;
    }
  }

  /**
   * Get available categories
   */
  async getCategories(status) {
    try {
      const resp = await this.http.get('/api/v1/markets/categories', { params: { status } });
      return resp.data?.categories || [];
    } catch (err) {
      log.error('Failed to fetch categories:', err.message);
      return [];
    }
  }

  // ─── Bets ─────────────────────────────────────────────────────────

  /**
   * Place a bet on a market
   * @param {string} marketId - Market ID
   * @param {number} outcomeIndex - 0 = Yes, 1 = No
   * @param {number} amount - Amount in CC (min 0.0001)
   * @param {boolean} dryRun - If true, don't place the bet
   */
  async placeBet(marketId, outcomeIndex, amount, dryRun = false) {
    const direction = outcomeIndex === 0 ? 'YES' : 'NO';

    if (dryRun) {
      log.info(`🔵 [DRY RUN] Would bet ${direction} ${amount} CC on market ${marketId}`);
      return {
        success: true,
        dryRun: true,
        data: { marketId, outcomeIndex, amount, timestamp: new Date().toISOString() },
      };
    }

    try {
      const resp = await this.http.post('/api/v1/bets/', {
        marketId,
        outcomeIndex,
        amount,
      });

      const bet = resp.data?.bet;
      const balanceAfter = resp.data?.balanceAfter;
      log.info(`✅ Bet placed! ${direction} ${amount} CC → balance: ${balanceAfter} CC`);

      return {
        success: true,
        dryRun: false,
        data: resp.data,
      };
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.response?.data?.message || err.message;
      log.error(`❌ Bet failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * List user's bets
   * @param {object} params - { status, marketId, limit, offset }
   */
  async getBets(params = {}) {
    try {
      const resp = await this.http.get('/api/v1/bets/', { params });
      return resp.data;
    } catch (err) {
      log.error('Failed to fetch bets:', err.message);
      return [];
    }
  }

  // ─── Balance ──────────────────────────────────────────────────────

  /**
   * Get user balance
   * Returns: { balance: { available, lockedBets, total, ... }, ccPriceUsd, bettingFee }
   */
  async getBalance() {
    try {
      const resp = await this.http.get('/api/v1/balance/');
      return resp.data;
    } catch (err) {
      log.error('Failed to fetch balance:', err.message);
      return null;
    }
  }

  // ─── Portfolio ────────────────────────────────────────────────────

  /**
   * Get portfolio with positions and performance
   */
  async getPortfolio() {
    try {
      const resp = await this.http.get('/api/v1/portfolio/me');
      return resp.data;
    } catch (err) {
      log.error('Failed to fetch portfolio:', err.message);
      return null;
    }
  }

  /**
   * Get portfolio equity snapshot
   */
  async getEquity() {
    try {
      const resp = await this.http.get('/api/v1/portfolio/me/equity');
      return resp.data;
    } catch (err) {
      log.error('Failed to fetch equity:', err.message);
      return null;
    }
  }

  // ─── Health ───────────────────────────────────────────────────────

  async healthCheck() {
    try {
      const resp = await this.http.get('/api/v1/health');
      const balanceData = await this.getBalance();
      const marketsData = await this.getActiveMarkets(5);

      log.info('🟢 API Health Check:');
      log.info(`   Status: ${resp.data?.status || 'ok'}`);
      log.info(`   Markets available: ${marketsData?.total || marketsData?.markets?.length || 0}`);
      log.info(`   Balance: ${balanceData?.balance?.available || 'unknown'} CC`);
      log.info(`   CC Price: $${balanceData?.ccPriceUsd || 'unknown'}`);

      return {
        connected: true,
        status: resp.data?.status,
        marketsCount: marketsData?.total || 0,
        balance: balanceData?.balance,
        ccPriceUsd: balanceData?.ccPriceUsd,
      };
    } catch (err) {
      log.error('🔴 API Health Check failed:', err.message);
      return { connected: false, error: err.message };
    }
  }
}

export default UnhedgedAPI;
