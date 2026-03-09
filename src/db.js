// src/db.js — Trade Logger using sql.js (pure JavaScript SQLite)
import initSqlJs from 'sql.js';
import config from './config.js';
import fs from 'fs';
import path from 'path';

/**
 * Trade database for logging all analysis results, bets, and outcomes.
 * Uses sql.js (Emscripten-compiled SQLite) for zero native dependencies.
 */
export class TradeDB {
  constructor(dbPath = config.dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this._initPromise = this._init();
  }

  async _init() {
    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const SQL = await initSqlJs();

    // Load existing database if it exists
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this._initTables();
  }

  _initTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        market_title TEXT NOT NULL,
        market_url TEXT,
        category TEXT,
        target_price REAL,
        current_price REAL,
        prediction TEXT,
        confidence REAL,
        edge REAL,
        kelly_fraction REAL,
        recommendation TEXT,
        bet_direction TEXT,
        bet_amount REAL,
        bet_placed INTEGER DEFAULT 0,
        dry_run INTEGER DEFAULT 0,
        ta_signal TEXT,
        ta_confidence REAL,
        stat_prob_above REAL,
        stat_prob_below REAL,
        llm_prediction TEXT,
        llm_confidence REAL,
        llm_reasoning TEXT,
        outcome TEXT,
        profit_loss REAL,
        resolved INTEGER DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        total_trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        total_profit REAL DEFAULT 0,
        bankroll REAL DEFAULT 0,
        losing_streak INTEGER DEFAULT 0
      )
    `);
  }

  async ensureReady() {
    await this._initPromise;
  }

  _save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  logTrade(data) {
    this.db.run(
      `INSERT INTO trades (
        market_title, market_url, category, target_price, current_price,
        prediction, confidence, edge, kelly_fraction, recommendation,
        bet_direction, bet_amount, bet_placed, dry_run,
        ta_signal, ta_confidence, stat_prob_above, stat_prob_below,
        llm_prediction, llm_confidence, llm_reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.market || '',
        data.marketUrl || '',
        data.category || '',
        data.targetPrice || null,
        data.currentPrice || null,
        data.prediction || '',
        data.confidence || 0,
        data.edge || 0,
        data.kellyFraction || 0,
        data.recommendation || '',
        data.betDirection || '',
        data.betAmount || 0,
        data.betPlaced ? 1 : 0,
        data.dryRun ? 1 : 0,
        data.components?.technical?.signal || '',
        data.components?.technical?.confidence || 0,
        data.components?.statistical?.probAbove || 0,
        1 - (data.components?.statistical?.probAbove || 0.5),
        data.components?.llm?.prediction || '',
        data.components?.llm?.confidence || 0,
        data.reasoning || '',
      ]
    );
    this._save();
  }

  getRecentTrades(limit = 50) {
    const stmt = this.db.prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`);
    stmt.bind([limit]);

    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  getStats() {
    const getCount = (query) => {
      const stmt = this.db.prepare(query);
      stmt.step();
      const result = stmt.getAsObject();
      stmt.free();
      return result;
    };

    const total = getCount('SELECT COUNT(*) as count FROM trades WHERE bet_placed = 1');
    const wins = getCount('SELECT COUNT(*) as count FROM trades WHERE outcome = "WIN"');
    const losses = getCount('SELECT COUNT(*) as count FROM trades WHERE outcome = "LOSS"');
    const profit = getCount('SELECT COALESCE(SUM(profit_loss), 0) as total FROM trades WHERE resolved = 1');
    const signals = getCount('SELECT COUNT(*) as count FROM trades');

    return {
      totalSignals: signals.count,
      totalTrades: total.count,
      wins: wins.count,
      losses: losses.count,
      winRate: total.count > 0 ? ((wins.count / total.count) * 100).toFixed(1) + '%' : 'N/A',
      totalProfit: profit.total || 0,
    };
  }

  close() {
    if (this.db) {
      this._save();
      this.db.close();
    }
  }
}

export default TradeDB;
