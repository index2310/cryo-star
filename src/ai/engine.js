// src/ai/engine.js — Combined AI Analysis Engine
// Aggregates Technical Analysis, Statistical Model, and LLM outputs
import TechnicalAnalysis from './technicalAnalysis.js';
import StatisticalModel from './statisticalModel.js';
import LLMReasoning from './llmReasoning.js';
import Logger from '../logger.js';
import config from '../config.js';

const log = new Logger(config.logLevel);

/**
 * Combined AI Engine.
 * Weights: Technical 40%, Statistical 35%, LLM 25%
 */
export class AIEngine {
  constructor() {
    this.ta = new TechnicalAnalysis();
    this.stats = new StatisticalModel();
    this.llm = new LLMReasoning();

    // Weights for combining signals
    this.weights = {
      technical: 0.40,
      statistical: 0.35,
      llm: 0.25,
    };
  }

  /**
   * Full analysis pipeline for a market
   * @param {object} market - Market data from scanner
   * @param {number[]} priceHistory - Recent close prices
   * @param {number} intervalMinutes - Interval between price data points
   * @returns {object} Combined analysis with final prediction
   */
  async analyze(market, priceHistory, intervalMinutes = 1) {
    log.info(`🧠 Analyzing: "${market.title}"`);

    const results = {};

    // 1. Technical Analysis
    const taResult = this.ta.analyze(priceHistory);
    results.technical = taResult;
    log.debug('Technical:', taResult.signal, `(${taResult.confidence}%)`);

    // 2. Statistical Model
    const volatility = this.stats.estimateVolatility(priceHistory, intervalMinutes);
    const statResult = this.stats.predictProbability(
      market.currentPrice,
      market.targetPrice,
      market.timeLeftMinutes,
      volatility
    );
    results.statistical = { ...statResult, volatility };
    log.debug('Statistical probAbove:', (statResult.probAbove * 100).toFixed(1) + '%');

    // 3. LLM Reasoning (with enriched data)
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
    log.debug('LLM:', llmResult.prediction, `(${llmResult.confidence}%)`);

    // 4. Combine signals
    const combined = this._combineSignals(taResult, statResult, llmResult, market);
    results.combined = combined;

    // 5. Calculate edge vs market odds
    const marketYesProb = (market.yesPercent || 50) / 100;
    const edge = this.stats.calculateEdge(
      combined.prediction === 'YES' ? combined.probability : 1 - combined.probability,
      combined.prediction === 'YES' ? marketYesProb : 1 - marketYesProb
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
      components: {
        technical: { signal: taResult.signal, confidence: taResult.confidence },
        statistical: { probAbove: statResult.probAbove, confidence: statResult.confidence },
        llm: { prediction: llmResult.prediction, confidence: llmResult.confidence },
      },
    };

    log.info(
      `📊 Result: ${summary.prediction} (${summary.confidence}% confidence, ${summary.edge}% edge) → ${summary.recommendation}`
    );

    return summary;
  }

  _combineSignals(ta, stats, llm, market) {
    // Convert each signal to a "YES probability"

    // Technical: BULLISH → high prob above
    let taProbYes = 0.5;
    if (ta.signal === 'BULLISH') taProbYes = 0.5 + (ta.confidence - 50) / 100;
    if (ta.signal === 'BEARISH') taProbYes = 0.5 - (ta.confidence - 50) / 100;

    // Determine if the market question is "above target?"
    // YES = price above target. So probAbove is directly probYes.
    const statProbYes = stats.probAbove;

    // LLM
    let llmProbYes = 0.5;
    if (llm.prediction === 'YES') llmProbYes = llm.confidence / 100;
    if (llm.prediction === 'NO') llmProbYes = 1 - llm.confidence / 100;

    // Weighted average
    const combinedProbYes =
      this.weights.technical * taProbYes +
      this.weights.statistical * statProbYes +
      this.weights.llm * llmProbYes;

    const prediction = combinedProbYes >= 0.5 ? 'YES' : 'NO';
    const probability = prediction === 'YES' ? combinedProbYes : 1 - combinedProbYes;
    const confidence = Math.round(probability * 100);

    const reasoning = [
      `TA: ${ta.signal} (${ta.confidence}%)`,
      `Stats: P(above)=${(stats.probAbove * 100).toFixed(1)}%`,
      `LLM: ${llm.prediction} (${llm.confidence}%) — ${llm.reasoning}`,
    ].join(' | ');

    return { prediction, probability, confidence, reasoning };
  }
}

export default AIEngine;
