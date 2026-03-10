// src/backtester.js — v5.0 Outcome Tracker & Backtester
// Checks resolved markets, marks WIN/LOSS, calculates component accuracy
import Logger from './logger.js';
import config from './config.js';

const log = new Logger(config.logLevel);

/**
 * Backtester — the missing feedback loop.
 * Checks resolved bets, marks outcomes, and tracks per-component accuracy
 * so the AI engine can dynamically adjust weights.
 */
export class Backtester {
    constructor(api, db) {
        this.api = api;
        this.db = db;
        this._lastCheck = 0;
        this._checkIntervalMs = 60_000; // check every 60s
    }

    /**
     * Run resolution check — call this every main loop cycle
     * Returns updated stats for dashboard
     */
    async checkResolutions() {
        // Rate limit: don't check more than once per minute
        if (Date.now() - this._lastCheck < this._checkIntervalMs) return null;
        this._lastCheck = Date.now();

        try {
            // Get our recent bets from API
            const betsData = await this.api.getBets({ limit: 50 });
            const bets = betsData?.bets || betsData || [];
            if (!Array.isArray(bets) || bets.length === 0) return null;

            let resolved = 0;
            let wins = 0;
            let losses = 0;

            for (const bet of bets) {
                // Skip non-resolved bets
                if (!bet.resolved && bet.status !== 'RESOLVED' && bet.status !== 'WON' && bet.status !== 'LOST') continue;

                const isWin = bet.status === 'WON' || bet.won === true || bet.payout > bet.amount;
                const pnl = isWin
                    ? parseFloat(bet.payout || 0) - parseFloat(bet.amount || 0)
                    : -parseFloat(bet.amount || 0);

                // Mark in DB
                this.db.markResolved(
                    bet.marketId,
                    isWin ? 'WIN' : 'LOSS',
                    pnl,
                    bet.resolutionPrice || null
                );

                resolved++;
                if (isWin) wins++;
                else losses++;
            }

            if (resolved > 0) {
                log.info(`📊 Backtester: resolved ${resolved} bets (${wins}W / ${losses}L)`);
            }

            return { resolved, wins, losses };
        } catch (err) {
            log.error('Backtester error:', err.message);
            return null;
        }
    }

    /**
     * Get component accuracy for dynamic weight adjustment
     * Returns accuracy of each AI component over the last N resolved trades
     */
    getComponentAccuracy(windowSize = 50) {
        return this.db.getComponentAccuracy(windowSize);
    }

    /**
     * Get current losing streak from DB (persistent across restarts)
     */
    getLosingStreak() {
        return this.db.getLosingStreak();
    }

    /**
     * Get session stats
     */
    getSessionStats() {
        const stats = this.db.getStats();
        const accuracy = this.db.getComponentAccuracy(50);

        return {
            ...stats,
            componentAccuracy: accuracy,
        };
    }
}

export default Backtester;
