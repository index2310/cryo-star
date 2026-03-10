// src/db.js — v5.0 Trade Logger with Outcome Tracking
// Adds: resolution tracking, component accuracy, losing streak persistence
import initSqlJs from 'sql.js';
import config from './config.js';
import fs from 'fs';
import path from 'path';

/**
 * Trade database — v5.0
 * Now tracks: resolutions, per-component accuracy, persistent losing streak
 */
export class TradeDB {
  constructor(dbPath = config.dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this._initPromise = this._init();
  }

  async _init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this._initTables();
    this._migrate(); // v5.0 migration
  }

  _initTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        market_id TEXT,
        market_title TEXT NOT NULL,
        market_url TEXT,
        category TEXT,
        asset TEXT,
        target_price REAL,
        current_price REAL,
        prediction TEXT,
        confidence REAL,
        edge REAL,
        kelly_fraction REAL,
        recommendation TEXT,
        agreement_score INTEGER,
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
        resolution_price REAL,
        resolved_at TEXT,
        pnl_cc REAL,
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS bankroll_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        balance REAL,
        locked REAL,
        session_pnl REAL
      )
    `);
  }

  /**
   * v5.0 migration: add new columns to existing databases
   */
  _migrate() {
    const addColumnIfMissing = (table, column, type) => {
      try {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // column already exists — ignore
      }
    };

    addColumnIfMissing('trades', 'market_id', 'TEXT');
    addColumnIfMissing('trades', 'asset', 'TEXT');
    addColumnIfMissing('trades', 'agreement_score', 'INTEGER');
    addColumnIfMissing('trades', 'resolution_price', 'REAL');
    addColumnIfMissing('trades', 'resolved_at', 'TEXT');
    addColumnIfMissing('trades', 'pnl_cc', 'REAL');
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
        market_id, market_title, market_url, category, asset,
        target_price, current_price,
        prediction, confidence, edge, kelly_fraction, recommendation,
        agreement_score,
        bet_direction, bet_amount, bet_placed, dry_run,
        ta_signal, ta_confidence, stat_prob_above, stat_prob_below,
        llm_prediction, llm_confidence, llm_reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.marketId || '',
        data.market || '',
        data.marketUrl || '',
        data.category || '',
        data.asset || '',
        data.targetPrice || null,
        data.currentPrice || null,
        data.prediction || '',
        data.confidence || 0,
        data.edge || 0,
        data.kellyFraction || 0,
        data.recommendation || '',
        data.agreementScore || null,
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

  /**
   * v5.0: Mark a trade as resolved with outcome
   */
  markResolved(marketId, outcome, pnl, resolutionPrice = null) {
    this.db.run(
      `UPDATE trades SET
        outcome = ?, pnl_cc = ?, profit_loss = ?, resolution_price = ?,
        resolved = 1, resolved_at = datetime('now')
      WHERE market_id = ? AND resolved = 0`,
      [outcome, pnl, pnl, resolutionPrice, marketId]
    );
    this._save();
  }

  /**
   * v5.0: Get per-component accuracy over last N resolved trades
   * Returns: { ta_accuracy, stat_accuracy, llm_accuracy, total }
   */
  getComponentAccuracy(windowSize = 50) {
    try {
      const stmt = this.db.prepare(
        `SELECT prediction, outcome, ta_signal, stat_prob_above, llm_prediction, target_price, resolution_price
         FROM trades WHERE resolved = 1 AND outcome IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      );
      stmt.bind([windowSize]);

      let taCorrect = 0, statCorrect = 0, llmCorrect = 0, total = 0;

      while (stmt.step()) {
        const row = stmt.getAsObject();
        const wasYes = row.outcome === 'WIN' ? row.prediction === 'YES' || row.prediction === 'NO' : false;
        const actualAbove = row.resolution_price > row.target_price;

        // TA accuracy: was the signal direction correct?
        const taBullish = row.ta_signal === 'BULLISH';
        if ((taBullish && actualAbove) || (!taBullish && !actualAbove)) taCorrect++;

        // Stats accuracy: was prob_above > 0.5 when price went above?
        const statPredAbove = row.stat_prob_above > 0.5;
        if ((statPredAbove && actualAbove) || (!statPredAbove && !actualAbove)) statCorrect++;

        // LLM accuracy
        const llmYes = row.llm_prediction === 'YES';
        if ((llmYes && actualAbove) || (!llmYes && !actualAbove)) llmCorrect++;

        total++;
      }
      stmt.free();

      if (total === 0) return { ta_accuracy: 0.5, stat_accuracy: 0.5, llm_accuracy: 0.5, total: 0 };

      return {
        ta_accuracy: taCorrect / total,
        stat_accuracy: statCorrect / total,
        llm_accuracy: llmCorrect / total,
        total,
      };
    } catch {
      return { ta_accuracy: 0.5, stat_accuracy: 0.5, llm_accuracy: 0.5, total: 0 };
    }
  }

  /**
   * v5.0: Get current losing streak (persistent across restarts)
   */
  getLosingStreak() {
    try {
      const stmt = this.db.prepare(
        `SELECT outcome FROM trades
         WHERE bet_placed = 1 AND resolved = 1 AND outcome IS NOT NULL
         ORDER BY timestamp DESC LIMIT 20`
      );

      let streak = 0;
      while (stmt.step()) {
        const row = stmt.getAsObject();
        if (row.outcome === 'LOSS') streak++;
        else break; // streak broken
      }
      stmt.free();
      return streak;
    } catch {
      return 0;
    }
  }

  /**
   * v5.0: Save bankroll snapshot
   */
  saveBankrollSnapshot(balance, locked, sessionPnl) {
    this.db.run(
      `INSERT INTO bankroll_snapshots (balance, locked, session_pnl) VALUES (?, ?, ?)`,
      [balance, locked, sessionPnl]
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
      losingStreak: this.getLosingStreak(),
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
