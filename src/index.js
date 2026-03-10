// src/index.js — Main Bot Orchestrator v5.0 (Accuracy-Focused)
// Fixes: price feed, pool-aware odds, thin market filter, backtester loop, dynamic Kelly
import config from './config.js';
import Logger from './logger.js';
import UnhedgedAPI from './apiClient.js';
import WSPriceClient from './wsPriceClient.js';
import PriceCollector from './priceCollector.js';
import AIEngine from './ai/engine.js';
import TradeDB from './db.js';
import DashboardServer from './dashboard/server.js';
import Backtester from './backtester.js';

const log = new Logger(config.logLevel);
const isDryRun = process.argv.includes('--dry-run') || config.botMode === 'signal';

// ─── Banner ────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════╗
║       🤖 UNHEDGED AI PREDICTION BOT v5.0.0          ║
║       🎯 Accuracy-Focused + Jump-Diffusion          ║
╠══════════════════════════════════════════════════════╣
║  Mode:   ${isDryRun ? '🔵 SIGNAL ONLY (Dry Run)      ' : '🟢 AUTO BET (Live)              '}          ║
║  Filter: CRYPTO                                     ║
║  Max Bet: ${String(config.risk.maxBetCC).padEnd(10)} CC                        ║
║  Min Edge: ${String(config.risk.minEdgePercent).padEnd(9)}%                         ║
║  Min Pool: ${String(config.risk.minPoolCC || 20).padEnd(9)} CC                       ║
╚══════════════════════════════════════════════════════╝
`);

// ─── Initialize ───────────────────────────────────────────────────
const api = new UnhedgedAPI();
const wsPrice = new WSPriceClient();
const priceCollector = new PriceCollector();
const aiEngine = new AIEngine();
const db = new TradeDB();
const dashboard = new DashboardServer();
const backtester = new Backtester(api, db);

let losingStreak = 0;
let isRunning = false;
let sessionStartBalance = null;

// ─── Bet Tracker (1 bet per market, reset on new round) ──────────
const betsPlaced = new Map(); // marketId → { roundEnd, timestamp }

function alreadyBet(marketId) {
  return betsPlaced.has(marketId);
}

function recordBet(marketId, roundEnd) {
  betsPlaced.set(marketId, { roundEnd, timestamp: Date.now() });
}

function cleanupExpiredBets() {
  const now = new Date();
  for (const [id, info] of betsPlaced) {
    if (info.roundEnd && new Date(info.roundEnd) < now) {
      betsPlaced.delete(id);
    }
  }
}

// ─── Price cache (reduced TTL from 2min → 30s for accuracy) ──────
const priceCache = new Map();
const CACHE_TTL = 30_000; // 30 seconds (was 120s)

async function getCachedPrices(coinId) {
  const cached = priceCache.get(coinId);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.data;
  try {
    const data = await priceCollector.getHistoricalPrices(coinId, 1);
    priceCache.set(coinId, { data, timestamp: Date.now() });
    return data;
  } catch {
    return cached?.data || [];
  }
}

// ─── Coin mapping (v5.0: expanded + uses actual settlement source) ──
const COIN_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  LINK: 'chainlink',
  MATIC: 'matic-network',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  CC: 'bitcoin', // Canton Coin — still uses BTC proxy (no CoinGecko listing)
};

function isCryptoMarket(m) {
  return (m.category || '').toLowerCase() === 'crypto';
}

/**
 * Parse market into structured analysis-ready format
 * v5.0: better asset detection, pool-based implied odds
 */
function parseMarket(market) {
  const ar = market.autoResolution?.resolverConfig;
  const asset = ar?.asset || 'BTC';
  const coinId = COIN_MAP[asset.toUpperCase()] || 'bitcoin';
  const outcomes = market.outcomes || [];
  const stats = market.outcomeStats || [];
  const isRange = ar?.type === 'range' && outcomes.length === 3;

  let parsed = {
    id: market.id,
    title: market.question || '',
    url: `https://unhedged.gg/markets/${market.id}`,
    asset,
    coinId,
    category: 'CRYPTO',
    endTime: market.endTime,
    resolutionTime: market.scheduledResolutionTime,
    totalPool: parseFloat(market.totalPool || '0'),
    betCount: market.betCount || 0,
    isRange,
    outcomeCount: outcomes.length,
    outcomes: outcomes.map((o, i) => ({
      index: o.index,
      label: o.label,
      totalBets: stats[i]?.totalBets || 0,
      totalAmount: parseFloat(stats[i]?.totalAmount || '0'),
    })),
  };

  // Time left
  if (market.endTime) {
    const diff = new Date(market.endTime) - new Date();
    parsed.timeLeftMinutes = diff > 0 ? diff / 60000 : 0;
  }

  // v5.0: Calculate implied odds from pool data
  const totalPoolAmount = parsed.outcomes.reduce((s, o) => s + o.totalAmount, 0);
  if (totalPoolAmount > 0 && parsed.outcomes.length >= 2) {
    parsed.yesPercent = Math.round((parsed.outcomes[0].totalAmount / totalPoolAmount) * 100);
    parsed.noPercent = 100 - parsed.yesPercent;
  } else {
    parsed.yesPercent = 50;
    parsed.noPercent = 50;
  }

  if (isRange && ar.ranges) {
    const ranges = ar.ranges.sort((a, b) => a.index - b.index);
    parsed.ranges = ranges;
    parsed.lowerBound = ranges[0]?.max;
    parsed.upperBound = ranges[2]?.min;
    parsed.targetLow = parsed.lowerBound;
    parsed.targetHigh = parsed.upperBound;
  } else if (outcomes.length === 2) {
    const label = outcomes[0]?.label || '';
    const priceMatch = label.match(/[\$]?([\d,]+\.?\d*)/);
    if (priceMatch) {
      parsed.targetPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
    }
  }

  return parsed;
}

/**
 * Analyze a 3-outcome range market
 * v5.0: Uses jump-diffusion Monte Carlo from StatisticalModel (20K paths)
 */
function analyzeRangeMarket(market, closes, currentPrice) {
  if (closes.length < 5) return null;

  const { lowerBound, upperBound, outcomes, timeLeftMinutes } = market;

  // v5.0: Use StatisticalModel's jump-diffusion Monte Carlo
  const statsModel = aiEngine.stats;
  const volatility = statsModel.estimateVolatility(closes, 1);

  // Estimate drift from recent data
  const n = closes.length;
  const returns = [];
  for (let i = 1; i < n; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const mu = returns.reduce((s, r) => s + r, 0) / returns.length;

  const mcResult = statsModel.monteCarloRange(
    currentPrice, lowerBound, upperBound, timeLeftMinutes, volatility, mu
  );
  const probs = mcResult.probs;

  // Pool-based implied odds
  const totalPool = outcomes.reduce((s, o) => s + o.totalAmount, 0) || 1;
  const impliedProbs = outcomes.map(o => {
    const share = o.totalAmount / totalPool;
    return share > 0 ? share : 1 / outcomes.length;
  });

  // Find best edge
  let bestIdx = 0, bestEdge = -999;
  for (let i = 0; i < 3; i++) {
    const edge = (probs[i] - impliedProbs[i]) * 100;
    if (edge > bestEdge) {
      bestEdge = edge;
      bestIdx = i;
    }
  }

  const confidence = Math.round(probs[bestIdx] * 100);
  const labels = outcomes.map(o => o.label);

  // Kelly fraction
  const p = probs[bestIdx];
  const q = 1 - p;
  const b = (1 / impliedProbs[bestIdx]) - 1;
  const kelly = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

  // v5.0: Stricter thresholds
  let recommendation = 'SKIP';
  if (bestEdge >= 15) recommendation = 'STRONG_BET';
  else if (bestEdge >= config.risk.minEdgePercent) recommendation = 'BET';
  else if (bestEdge >= 5) recommendation = 'LEAN';

  return {
    prediction: labels[bestIdx],
    outcomeIndex: bestIdx,
    confidence,
    edge: Math.round(bestEdge * 10) / 10,
    recommendation,
    kellyFraction: Math.round(kelly * 10000) / 100,
    probabilities: probs.map(p => Math.round(p * 1000) / 10),
    impliedProbs: impliedProbs.map(p => Math.round(p * 1000) / 10),
    reasoning: `JumpDiff MC ${mcResult.numPaths} paths: ${labels.map((l, i) => `${l}=${(probs[i] * 100).toFixed(1)}%`).join(', ')}. Best: ${labels[bestIdx]} (edge ${bestEdge.toFixed(1)}%)`,
    marketTitle: market.title,
    isRange: true,
  };
}

// ─── Main loop ────────────────────────────────────────────────────
async function mainLoop() {
  if (isRunning) return;
  isRunning = true;

  try {
    cleanupExpiredBets();

    // v5.0: Run backtester first — check resolved markets & update weights
    const resolveResult = await backtester.checkResolutions();
    if (resolveResult?.resolved > 0) {
      const accuracy = backtester.getComponentAccuracy();
      aiEngine.updateWeights(accuracy);
      losingStreak = backtester.getLosingStreak();
      log.info(`📊 Losing streak: ${losingStreak} | Component accuracy: TA=${(accuracy.ta_accuracy * 100).toFixed(0)}% ST=${(accuracy.stat_accuracy * 100).toFixed(0)}% LLM=${(accuracy.llm_accuracy * 100).toFixed(0)}%`);
    }

    log.info('🔍 Fetching active crypto markets...');

    const data = await api.getActiveMarkets(100);
    const allMarkets = data?.markets || [];
    const cryptoMarkets = allMarkets.filter(isCryptoMarket);

    log.info(`📊 ${cryptoMarkets.length} crypto markets (${allMarkets.length} total, ${betsPlaced.size} already bet)`);

    if (cryptoMarkets.length === 0) { log.warn('No crypto markets active.'); return; }

    // Get balance once per cycle
    const balanceData = await api.getBalance();
    const bankroll = parseFloat(balanceData?.balance?.available || '0');
    if (bankroll > 0) log.info(`💰 Balance: ${bankroll.toFixed(4)} CC`);

    // v5.0: Track session start balance for drawdown protection
    if (sessionStartBalance === null) {
      sessionStartBalance = bankroll;
      log.info(`📊 Session start balance: ${sessionStartBalance.toFixed(4)} CC`);
    }

    // v5.0: Drawdown circuit breaker
    if (sessionStartBalance > 0) {
      const drawdown = (sessionStartBalance - bankroll) / sessionStartBalance;
      if (drawdown > (config.risk.maxDrawdownPercent || 20) / 100) {
        log.warn(`🛑 CIRCUIT BREAKER: Drawdown ${(drawdown * 100).toFixed(1)}% exceeds ${config.risk.maxDrawdownPercent || 20}% limit — pausing bets`);
        dashboard.broadcastSignal({ prediction: 'PAUSED', reasoning: `Circuit breaker: ${(drawdown * 100).toFixed(1)}% drawdown`, confidence: 0 });
        return;
      }
    }

    // v5.0: Save bankroll snapshot periodically
    db.saveBankrollSnapshot(bankroll, parseFloat(balanceData?.balance?.lockedBets || '0'), bankroll - (sessionStartBalance || bankroll));

    for (const raw of cryptoMarkets) {
      try {
        if (alreadyBet(raw.id)) {
          log.debug(`⏭️ Already bet on "${raw.question}" — skipping`);
          continue;
        }

        const market = parseMarket(raw);

        // Skip expired
        if (market.timeLeftMinutes !== undefined && market.timeLeftMinutes < config.risk.minTimeLeftMinutes) {
          continue;
        }

        // v5.0: Skip thin markets (unreliable odds)
        if (market.totalPool < (config.risk.minPoolCC || 20)) {
          log.debug(`⏭️ Thin market "${market.title}" (pool: ${market.totalPool} CC) — skipping`);
          continue;
        }

        // ── Get price data ──
        // v5.0: Prioritize WebSocket price (it's the settlement source!)
        wsPrice.subscribeMarket(market.id);
        const wsData = wsPrice.getPrice(market.asset);
        let closes = wsPrice.getCloses(market.asset);

        if (closes.length < 20) {
          const history = await getCachedPrices(market.coinId);
          closes = history.map(p => p.price);
        }

        // v5.0: Use WS price as primary (settlement source), CoinGecko as fallback
        let currentPrice = wsData?.price || (closes.length > 0 ? closes[closes.length - 1] : null);
        if (!currentPrice) continue;

        // v5.0: Cross-validate prices — log warning if sources diverge
        if (wsData?.price && closes.length > 0) {
          const cgPrice = closes[closes.length - 1];
          const priceDiff = Math.abs(wsData.price - cgPrice) / cgPrice;
          if (priceDiff > 0.003) { // 0.3% threshold
            log.warn(`⚠️ Price divergence: WS=$${wsData.price.toFixed(4)} vs CG=$${cgPrice.toFixed(4)} (${(priceDiff * 100).toFixed(2)}%)`);
          }
        }

        // Pad if needed
        while (closes.length < 25) closes.unshift(currentPrice);
        // Ensure latest close matches current price
        closes[closes.length - 1] = currentPrice;

        log.info(`🧠 [${market.asset}] "${market.title}" (${market.outcomeCount} outcomes, ${market.timeLeftMinutes?.toFixed(0)}m left, pool: ${market.totalPool.toFixed(0)} CC)`);

        let analysis;

        if (market.isRange) {
          // ── 3-outcome range market (v5.0: 20K jump-diffusion MC) ──
          analysis = analyzeRangeMarket(market, closes, currentPrice);
          if (!analysis) continue;

          log.info(`📊 Range: ${analysis.probabilities.map((p, i) => `${market.outcomes[i].label}=${p}%`).join(' | ')}`);
          log.info(`📊 Best: ${analysis.prediction} (${analysis.confidence}% conf, ${analysis.edge}% edge) → ${analysis.recommendation}`);
        } else {
          // ── 2-outcome Yes/No market (v5.0: full accuracy upgrade) ──
          analysis = await aiEngine.analyze({
            ...market,
            currentPrice,
            targetPrice: market.targetPrice,
          }, closes, 1);

          log.info(`📊 Result: ${analysis.prediction} (${analysis.confidence}% conf, ${analysis.edge}% edge, ${analysis.agreementScore || '?'}/3 agree) → ${analysis.recommendation}`);
        }

        // Broadcast to dashboard
        dashboard.broadcastSignal({ ...analysis, marketTitle: market.title, asset: market.asset });

        // ── Decision (v5.0: stricter criteria) ──
        const edgeOk = !isNaN(analysis.edge) && analysis.edge >= config.risk.minEdgePercent;
        const consensusOk = analysis.consensusMet !== false; // range markets don't have this
        const shouldBet = edgeOk
          && consensusOk
          && ['BET', 'STRONG_BET'].includes(analysis.recommendation)
          && losingStreak < config.risk.maxLosingStreak;

        if (shouldBet) {
          const betAmount = calcBetAmount(analysis, bankroll);
          if (betAmount < 5) {
            log.warn(`⚠️ Bet amount ${betAmount} CC < 5 CC minimum — skipping`);
            continue;
          }
          const outcomeIdx = market.isRange ? analysis.outcomeIndex : (analysis.prediction === 'YES' ? 0 : 1);

          log.signal(analysis.prediction, market.title, analysis.confidence, analysis.reasoning);

          const result = await api.placeBet(market.id, outcomeIdx, betAmount, isDryRun);

          if (result.success) {
            log.trade(analysis.prediction, market.title, betAmount, 'placed');
            recordBet(market.id, market.resolutionTime || market.endTime);
          }

          db.logTrade({
            ...analysis, marketId: market.id, marketUrl: market.url, asset: market.asset,
            betDirection: analysis.prediction, betAmount,
            betPlaced: result.success && !isDryRun, dryRun: isDryRun,
          });
        } else {
          const reason = !edgeOk ? 'low edge' : !consensusOk ? 'no consensus' : 'losing streak';
          log.debug(`⏭️ Skipping bet: ${reason}`);

          db.logTrade({
            ...analysis, marketId: market.id, marketUrl: market.url, asset: market.asset,
            betDirection: null, betAmount: 0, betPlaced: false, dryRun: isDryRun,
          });
        }

        dashboard.broadcastStats(db.getStats());
        dashboard.broadcastTrades(db.getRecentTrades(20));
        await sleep(300);
      } catch (err) {
        log.error(`Error on "${raw.question}":`, err.message);
      }
    }
  } catch (err) {
    log.error('Main loop error:', err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * v5.0: Dynamic Kelly sizing with losing streak reduction
 */
function calcBetAmount(analysis, bankroll) {
  const MIN_BET = 5; // API minimum
  if (bankroll < MIN_BET) return 0;

  const kelly = (analysis.kellyFraction || 0) / 100;

  // v5.0: Dynamic Kelly reduction on losing streaks
  let kellyMultiplier = 0.5; // base: half-Kelly
  if (losingStreak >= 3) kellyMultiplier = 0.15;       // quarter-Kelly after 3 losses
  else if (losingStreak >= 2) kellyMultiplier = 0.25;   // reduce after 2 losses
  else if (losingStreak >= 1) kellyMultiplier = 0.35;   // slight reduction after 1 loss

  const kellyAmt = kelly * bankroll * kellyMultiplier;
  const maxAmt = config.risk.maxBetCC;

  const amount = Math.min(Math.max(MIN_BET, kellyAmt), maxAmt);
  return Math.round(Math.min(amount, bankroll) * 10000) / 10000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ────────────────────────────────────────────────────────
async function start() {
  await db.ensureReady();

  // v5.0: Load persistent state from DB
  losingStreak = db.getLosingStreak();
  if (losingStreak > 0) log.warn(`⚠️ Resuming with losing streak: ${losingStreak}`);

  // v5.0: Load component accuracy and set dynamic weights
  const accuracy = db.getComponentAccuracy(50);
  if (accuracy.total > 0) {
    aiEngine.updateWeights(accuracy);
    log.info(`📊 Loaded accuracy from ${accuracy.total} resolved trades: TA=${(accuracy.ta_accuracy * 100).toFixed(0)}% ST=${(accuracy.stat_accuracy * 100).toFixed(0)}% LLM=${(accuracy.llm_accuracy * 100).toFixed(0)}%`);
  }

  dashboard.start();
  dashboard.broadcastMode(isDryRun ? 'SIGNAL ONLY' : 'AUTO BET');

  log.info('🔌 API health check...');
  const health = await api.healthCheck();
  if (!health.connected) log.error('❌ API check failed');

  await wsPrice.connect();

  // v5.0: Subscribe to global room for all crypto prices
  wsPrice.subscribeGlobal();

  log.info('🚀 Bot v5.0 started! Scanning every 30s...');
  log.info(`📊 Dashboard: http://localhost:${config.dashboardPort}`);

  await mainLoop();
  setInterval(mainLoop, 30_000);
}

process.on('SIGINT', () => {
  log.info('🛑 Shutting down...');
  wsPrice.close(); db.close(); dashboard.stop();
  process.exit(0);
});
process.on('unhandledRejection', (err) => log.error('Unhandled:', err));
start().catch(err => { log.error('Fatal:', err); process.exit(1); });
