// src/index.js — Main Bot Orchestrator v4.0 (Multi-Outcome + Cooldown + Smart Betting)
import config from './config.js';
import Logger from './logger.js';
import UnhedgedAPI from './apiClient.js';
import WSPriceClient from './wsPriceClient.js';
import PriceCollector from './priceCollector.js';
import AIEngine from './ai/engine.js';
import TradeDB from './db.js';
import DashboardServer from './dashboard/server.js';

const log = new Logger(config.logLevel);
const isDryRun = process.argv.includes('--dry-run') || config.botMode === 'signal';

// ─── Banner ────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════╗
║       🤖 UNHEDGED AI PREDICTION BOT v4.0.0          ║
║       ⚡ Multi-Outcome + Cooldown + Smart Betting     ║
╠══════════════════════════════════════════════════════╣
║  Mode:   ${isDryRun ? '🔵 SIGNAL ONLY (Dry Run)      ' : '🟢 AUTO BET (Live)              '}          ║
║  Filter: CRYPTO only                                ║
║  Max Bet: ${String(config.risk.maxBetCC).padEnd(10)} CC                        ║
║  Min Edge: ${String(config.risk.minEdgePercent).padEnd(9)}%                         ║
╚══════════════════════════════════════════════════════╝
`);

// ─── Initialize ───────────────────────────────────────────────────
const api = new UnhedgedAPI();
const wsPrice = new WSPriceClient();
const priceCollector = new PriceCollector();
const aiEngine = new AIEngine();
const db = new TradeDB();
const dashboard = new DashboardServer();

let losingStreak = 0;
let isRunning = false;

// ─── Bet Tracker (1 bet per market, reset on new round) ──────────
const betsPlaced = new Map(); // marketId → { roundEnd, timestamp }

function alreadyBet(marketId) {
  return betsPlaced.has(marketId);
}

function recordBet(marketId, roundEnd) {
  betsPlaced.set(marketId, { roundEnd, timestamp: Date.now() });
}

// Clean up expired rounds (markets that have resolved)
function cleanupExpiredBets() {
  const now = new Date();
  for (const [id, info] of betsPlaced) {
    if (info.roundEnd && new Date(info.roundEnd) < now) {
      betsPlaced.delete(id);
    }
  }
}

// ─── Price cache (avoid CoinGecko rate limits) ────────────────────
const priceCache = new Map(); // coinId → { data, timestamp }
const CACHE_TTL = 120_000; // 2 min

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

// ─── Market Analysis ──────────────────────────────────────────────
const COIN_MAP = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', CC: 'bitcoin' }; // CC uses BTC as proxy since canton-coin not on CoinGecko

function isCryptoMarket(m) {
  return (m.category || '').toLowerCase() === 'crypto';
}

/**
 * Parse market into structured analysis-ready format
 * Handles both 2-outcome (Yes/No) and 3-outcome (range) markets
 */
function parseMarket(market) {
  const ar = market.autoResolution?.resolverConfig;
  const asset = ar?.asset || 'BTC';
  const coinId = COIN_MAP[asset] || 'bitcoin';
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

  if (isRange && ar.ranges) {
    // 3-outcome: extract price ranges
    const ranges = ar.ranges.sort((a, b) => a.index - b.index);
    parsed.ranges = ranges; // [{ min, max, index }]
    parsed.lowerBound = ranges[0]?.max;  // upper edge of "below" range
    parsed.upperBound = ranges[2]?.min;  // lower edge of "above" range
    parsed.targetLow = parsed.lowerBound;
    parsed.targetHigh = parsed.upperBound;
  } else if (outcomes.length === 2) {
    // 2-outcome: Yes/No — parse target from label
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
 * Returns: best outcome index, confidence, edge, reasoning
 */
function analyzeRangeMarket(market, closes, currentPrice) {
  if (closes.length < 5) return null;

  const { lowerBound, upperBound, outcomes, timeLeftMinutes } = market;
  const n = closes.length;
  const returns = [];
  for (let i = 1; i < n; i++) returns.push(Math.log(closes[i] / closes[i - 1]));

  const mu = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mu) ** 2, 0) / (returns.length - 1);
  const sigma = Math.sqrt(variance);

  // GBM parameters scaled to time remaining
  const T = Math.max(timeLeftMinutes / (24 * 60), 0.001); // in days
  const drift = (mu - 0.5 * sigma * sigma) * T;
  const diffusion = sigma * Math.sqrt(T);

  // Monte Carlo simulation (fast, 5000 paths)
  const N = 5000;
  let countBelow = 0, countInRange = 0, countAbove = 0;

  for (let i = 0; i < N; i++) {
    // Box-Muller for normal random
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const futurePrice = currentPrice * Math.exp(drift + diffusion * z);

    if (futurePrice < lowerBound) countBelow++;
    else if (futurePrice > upperBound) countAbove++;
    else countInRange++;
  }

  const probs = [countBelow / N, countInRange / N, countAbove / N];

  // Calculate pool-based implied odds
  const totalPool = outcomes.reduce((s, o) => s + o.totalAmount, 0) || 1;
  const impliedProbs = outcomes.map(o => {
    const share = o.totalAmount / totalPool;
    return share > 0 ? share : 1 / outcomes.length; // default to equal if no bets
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

  let recommendation = 'SKIP';
  if (bestEdge >= 15) recommendation = 'STRONG_BET';
  else if (bestEdge >= 10) recommendation = 'BET';
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
    reasoning: `Monte Carlo ${N} paths: ${labels.map((l, i) => `${l}=${(probs[i]*100).toFixed(1)}%`).join(', ')}. Best: ${labels[bestIdx]} (edge ${bestEdge.toFixed(1)}%)`,
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

    for (const raw of cryptoMarkets) {
      try {
        // Skip already-bet markets
        if (alreadyBet(raw.id)) {
          log.debug(`⏭️ Already bet on "${raw.question}" — skipping`);
          continue;
        }

        const market = parseMarket(raw);

        // Skip expired
        if (market.timeLeftMinutes !== undefined && market.timeLeftMinutes < config.risk.minTimeLeftMinutes) {
          continue;
        }

        // Get price data
        wsPrice.subscribeMarket(market.id);
        let closes = wsPrice.getCloses(market.asset);

        if (closes.length < 20) {
          const history = await getCachedPrices(market.coinId);
          closes = history.map(p => p.price);
        }

        const currentPrice = closes.length > 0 ? closes[closes.length - 1] : null;
        if (!currentPrice) continue;

        // Pad if needed
        while (closes.length < 25) closes.unshift(currentPrice);

        log.info(`🧠 [${market.asset}] "${market.title}" (${market.outcomeCount} outcomes, ${market.timeLeftMinutes?.toFixed(0)}m left)`);

        let analysis;

        if (market.isRange) {
          // ── 3-outcome range market ──
          analysis = analyzeRangeMarket(market, closes, currentPrice);
          if (!analysis) continue;

          log.info(`📊 Range: ${analysis.probabilities.map((p, i) => `${market.outcomes[i].label}=${p}%`).join(' | ')}`);
          log.info(`📊 Best: ${analysis.prediction} (${analysis.confidence}% conf, ${analysis.edge}% edge) → ${analysis.recommendation}`);
        } else {
          // ── 2-outcome Yes/No market ──
          analysis = await aiEngine.analyze({
            ...market,
            currentPrice,
            targetPrice: market.targetPrice,
            yesPercent: 50, noPercent: 50,
          }, closes, 1);

          log.info(`📊 Result: ${analysis.prediction} (${analysis.confidence}% conf, ${analysis.edge}% edge) → ${analysis.recommendation}`);
        }

        // Broadcast to dashboard
        dashboard.broadcastSignal({ ...analysis, marketTitle: market.title, asset: market.asset });

        // ── Decision ──
        const shouldBet = analysis.edge >= config.risk.minEdgePercent
          && ['BET', 'STRONG_BET'].includes(analysis.recommendation)
          && losingStreak < config.risk.maxLosingStreak;

        if (shouldBet) {
          const betAmount = calcBetAmount(analysis, bankroll);
          const outcomeIdx = market.isRange ? analysis.outcomeIndex : (analysis.prediction === 'YES' ? 0 : 1);

          log.signal(analysis.prediction, market.title, analysis.confidence, analysis.reasoning);

          const result = await api.placeBet(market.id, outcomeIdx, betAmount, isDryRun);

          if (result.success) {
            log.trade(analysis.prediction, market.title, betAmount, 'placed');
            recordBet(market.id, market.resolutionTime || market.endTime);
          }

          db.logTrade({
            ...analysis, marketUrl: market.url, asset: market.asset,
            betDirection: analysis.prediction, betAmount,
            betPlaced: result.success && !isDryRun, dryRun: isDryRun,
          });
        } else {
          db.logTrade({
            ...analysis, marketUrl: market.url, asset: market.asset,
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

function calcBetAmount(analysis, bankroll) {
  const kelly = (analysis.kellyFraction || 0) / 100;
  const kellyAmt = kelly * bankroll * 0.5;
  const maxAmt = Math.min(config.risk.maxBetCC, bankroll * (config.risk.maxBetPercent / 100));
  const amount = Math.min(Math.max(5, kellyAmt), maxAmt); // Min 5 CC per API requirement
  return Math.round(amount * 10000) / 10000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ────────────────────────────────────────────────────────
async function start() {
  await db.ensureReady();
  dashboard.start();
  dashboard.broadcastMode(isDryRun ? 'SIGNAL ONLY' : 'AUTO BET');

  log.info('🔌 API health check...');
  const health = await api.healthCheck();
  if (!health.connected) log.error('❌ API check failed');

  await wsPrice.connect();

  log.info('🚀 Bot started! Scanning every 30s...');
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
