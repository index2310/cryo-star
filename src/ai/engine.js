// src/ai/engine.js — v5.0 Combined AI Analysis Engine
// Dynamic weights, confidence gating, agreement bonus, minimum consensus
import TechnicalAnalysis from './technicalAnalysis.js';
import StatisticalModel from './statisticalModel.js';
import LLMReasoning from './llmReasoning.js';
import Logger from '../logger.js';
import config from '../config.js';

const log = new Logger(config.logLevel);

/**
 * Combined AI Engine — v5.0
 *
 * Key improvements:
 * 1. Dynamic weights based on rolling component accuracy
 * 2. Confidence gating — low-confidence signals contribute less
 * 3. Agreement bonus/penalty — consensus boosts confidence
 * 4. Minimum consensus — require 2/3 agreement for BET recommendation
 */
export class AIEngine {
  constructor() {
    this.ta = new TechnicalAnalysis();
    this.stats = new StatisticalModel();
    this.llm = new LLMReasoning();

    // Default weights (will be overridden by dynamic weights)
    this.weights = {
      technical: 0.30,   // reduced from 40% — TA is weakest for short-term crypto
      statistical: 0.45, // increased from 35% — stats model is most rigorous
      llm: 0.25,
    };

    // Component accuracy (updated by backtester)
    this.componentAccuracy = null;
  }

  /**
   * Update weights based on backtester accuracy data
   */
  updateWeights(accuracyData) {
    if (!accuracyData || accuracyData.total < 10) return; // need 10+ data points

    this.componentAccuracy = accuracyData;

    const taAcc = accuracyData.ta_accuracy ?? 0.5;
    const stAcc = accuracyData.stat_accuracy ?? 0.5;
    const llmAcc = accuracyData.llm_accuracy ?? 0.5;
    const total = taAcc + stAcc + llmAcc;

    if (total > 0) {
      // Proportional weighting: better accuracy → more weight
      // But floor at 0.10 so no component is completely ignored
      const rawTa = Math.max(0.10, taAcc / total);
      const rawSt = Math.max(0.10, stAcc / total);
      const rawLlm = Math.max(0.10, llmAcc / total);
      const rawTotal = rawTa + rawSt + rawLlm;

      this.weights.technical = rawTa / rawTotal;
      this.weights.statistical = rawSt / rawTotal;
      this.weights.llm = rawLlm / rawTotal;

      log.info(`📊 Dynamic weights: TA=${(this.weights.technical * 100).toFixed(0)}% ST=${(this.weights.statistical * 100).toFixed(0)}% LLM=${(this.weights.llm * 100).toFixed(0)}% (based on ${accuracyData.total} trades)`);
    }
  }

  /**
   * Full analysis pipeline
   */
  async analyze(market, priceHistory, intervalMinutes = 1) {
    log.info(`🧠 Analyzing: "${market.title}"`);

    const results = {};

    // 1. Technical Analysis
    const taResult = this.ta.analyze(priceHistory);
    results.technical = taResult;
    log.debug('Technical:', taResult.signal, `(${taResult.confidence}%)`);

    // 2. Statistical Model (v5.0: Jump-Diffusion)
    const volatility = this.stats.estimateVolatility(priceHistory, intervalMinutes);
    const statResult = this.stats.predictProbability(
      market.currentPrice,
      market.targetPrice,
      market.timeLeftMinutes,
      volatility
    );
    results.statistical = { ...statResult, volatility };
    log.debug(`Statistical probAbove: ${(statResult.probAbove * 100).toFixed(1)}% (MC: ${(statResult.mcProbAbove * 100).toFixed(1)}%, GBM: ${(statResult.gbmProbAbove * 100).toFixed(1)}%)`);

    // 3. LLM Reasoning (v5.0: self-consistency, calibrated probability)
    const llmInput = {
      ...market,
      priceGap: market.targetPrice
        ? (market.targetPrice - market.currentPrice) / market.currentPrice
        : null,
      technicalSignal: taResult.signal,
      rsi: taResult.indicators.rsi,
      macdHistogram: taResult.indicators.macd?.histogram,
      bbPosition: taResult.indicators.bbPosition,
      momentum: taResult.indicators.momentum,
      probAbove: statResult.probAbove,
      probBelow: statResult.probBelow,
      volatility,
    };

    const llmResult = await this.llm.analyze(llmInput);
    results.llm = llmResult;
    log.debug(`LLM: ${llmResult.prediction} (${llmResult.confidence}%) [consistent: ${llmResult.selfConsistent}]`);

    // 4. Combine signals (v5.0: confidence gating + agreement bonus)
    const combined = this._combineSignals(taResult, statResult, llmResult, market);
    results.combined = combined;

    // 5. Calculate edge vs market odds (v5.0: pool-based implied odds)
    const impliedProbYes = this._calcImpliedProbability(market);
    const edge = this.stats.calculateEdge(
      combined.prediction === 'YES' ? combined.probability : 1 - combined.probability,
      combined.prediction === 'YES' ? impliedProbYes : 1 - impliedProbYes
    );
    results.edge = edge;

    // Final summary
    const summary = {
      market: market.title,
      prediction: combined.prediction,
      confidence: combined.confidence,
      probability: combined.probability,
      edge: edge.edgePercent,
      kellyFraction: edge.kellyPercent,
      recommendation: edge.recommendation,
      reasoning: combined.reasoning,
      agreementScore: combined.agreementScore,
      consensusMet: combined.consensusMet,
      components: {
        technical: { signal: taResult.signal, confidence: taResult.confidence },
        statistical: { probAbove: statResult.probAbove, confidence: statResult.confidence },
        llm: { prediction: llmResult.prediction, confidence: llmResult.confidence, selfConsistent: llmResult.selfConsistent },
      },
      weights: { ...this.weights },
      confidenceInterval: statResult.confidenceInterval,
    };

    // v5.0: Override recommendation if consensus not met
    if (!combined.consensusMet && summary.recommendation === 'BET') {
      summary.recommendation = 'LEAN';
      log.info(`⚠️ Downgraded to LEAN — consensus not met (agreement: ${combined.agreementScore}/3)`);
    }

    log.info(
      `📊 Result: ${summary.prediction} (${summary.confidence}% conf, ${summary.edge}% edge, ${combined.agreementScore}/3 agree) → ${summary.recommendation}`
    );

    return summary;
  }

  /**
   * Calculate implied probability from market pool data
   * Much more accurate than hardcoded 50/50
   */
  _calcImpliedProbability(market) {
    const outcomes = market.outcomes || [];

    if (outcomes.length >= 2) {
      const totalAmount = outcomes.reduce((s, o) => s + (o.totalAmount || 0), 0);
      if (totalAmount > 0) {
        const yesAmount = outcomes[0].totalAmount || 0;
        const impliedProb = yesAmount / totalAmount;
        // Add vig adjustment (5% — typical for prediction markets)
        return Math.max(0.05, Math.min(0.95, impliedProb));
      }
    }

    // Fallback to platform-reported odds
    return (market.yesPercent || 50) / 100;
  }

  /**
   * v5.0: Combine signals with confidence gating and agreement bonus
   */
  _combineSignals(ta, stats, llm, market) {
    // Helper: ensure we never get NaN in the math pipeline
    const safeNum = (v, fallback = 0.5) => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : fallback;

    // Convert each signal to a "YES probability"

    // ── Technical: BULLISH → prob above target ──
    let taProbYes = 0.5;
    const taConf = safeNum(ta.confidence, 50);
    if (ta.signal === 'BULLISH') taProbYes = 0.5 + (taConf - 50) / 100;
    if (ta.signal === 'BEARISH') taProbYes = 0.5 - (taConf - 50) / 100;

    // ── Statistical ──
    const statProbYes = safeNum(stats.probAbove, 0.5);

    // ── LLM (v5.0: use calibrated probability) ──
    let llmProbYes = safeNum(llm.calibratedProb, 0.5);
    if (llm.prediction === 'NO' && llmProbYes > 0.5) llmProbYes = 1 - llmProbYes; // fix inversion

    // ── Confidence gating: dampen low-confidence signals ──
    const taWeight = this.weights.technical * this._confidenceGate(safeNum(ta.confidence, 50));
    const statWeight = this.weights.statistical * this._confidenceGate(safeNum(stats.confidence, 50));
    const llmWeight = this.weights.llm * this._confidenceGate(safeNum(llm.confidence, 50));
    const totalWeight = taWeight + statWeight + llmWeight;

    // Weighted average with gated weights
    const combinedProbYes = totalWeight > 0
      ? (taWeight * taProbYes + statWeight * statProbYes + llmWeight * llmProbYes) / totalWeight
      : 0.5;

    // ── Agreement analysis ──
    const taDirection = taProbYes > 0.55 ? 'YES' : taProbYes < 0.45 ? 'NO' : 'NEUTRAL';
    const statDirection = statProbYes > 0.55 ? 'YES' : statProbYes < 0.45 ? 'NO' : 'NEUTRAL';
    const llmDirection = llm.prediction;

    const directions = [taDirection, statDirection, llmDirection].filter(d => d !== 'NEUTRAL');
    const yesVotes = directions.filter(d => d === 'YES').length;
    const noVotes = directions.filter(d => d === 'NO').length;
    const agreementScore = Math.max(yesVotes, noVotes);
    const consensusMet = agreementScore >= 2; // at least 2 of 3 agree

    // Agreement adjustment
    let adjustedProbYes = combinedProbYes;
    if (agreementScore === 3) {
      // All agree — boost confidence 10%
      adjustedProbYes = 0.5 + (combinedProbYes - 0.5) * 1.10;
    } else if (agreementScore <= 1 && directions.length >= 2) {
      // No consensus — dampen toward 50%
      adjustedProbYes = 0.5 + (combinedProbYes - 0.5) * 0.70;
    }

    // Clamp + final NaN guard
    adjustedProbYes = safeNum(adjustedProbYes, 0.5);
    adjustedProbYes = Math.max(0.02, Math.min(0.98, adjustedProbYes));

    const prediction = adjustedProbYes >= 0.5 ? 'YES' : 'NO';
    const probability = prediction === 'YES' ? adjustedProbYes : 1 - adjustedProbYes;
    const confidence = Math.round(probability * 100);

    const reasoning = [
      `TA: ${ta.signal} (${ta.confidence}%, w=${(taWeight / totalWeight * 100).toFixed(0)}%)`,
      `Stats: P(above)=${(stats.probAbove * 100).toFixed(1)}% (w=${(statWeight / totalWeight * 100).toFixed(0)}%)`,
      `LLM: ${llm.prediction} (${llm.confidence}%, w=${(llmWeight / totalWeight * 100).toFixed(0)}%)${llm.selfConsistent === false ? ' ⚠️' : ''}`,
      `Agreement: ${agreementScore}/3`,
    ].join(' | ');

    return { prediction, probability, confidence, reasoning, agreementScore, consensusMet };
  }

  /**
   * Confidence gating function
   * Below 55% confidence → heavily dampen the signal weight
   * Above 75% confidence → slight boost
   */
  _confidenceGate(confidence) {
    if (confidence < 45) return 0.3;  // very low confidence → 30% weight
    if (confidence < 55) return 0.6;  // low confidence → 60% weight
    if (confidence < 65) return 0.85; // moderate → 85% weight
    if (confidence < 75) return 1.0;  // solid → full weight
    return 1.1; // high confidence → 10% boost
  }
}

export default AIEngine;
