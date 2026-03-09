// src/ai/technicalAnalysis.js — Technical indicators for short-term price prediction
import { RSI, MACD, BollingerBands, SMA, EMA, Stochastic, ATR } from 'technicalindicators';

/**
 * Technical Analysis module
 * Analyzes recent price data using standard indicators and produces
 * a directional signal (bullish/bearish) with confidence score.
 */
export class TechnicalAnalysis {
  /**
   * Run full technical analysis on price data
   * @param {number[]} closes - Array of closing prices (oldest first)
   * @param {number[]} highs - Array of high prices (optional, same length as closes)
   * @param {number[]} lows - Array of low prices (optional, same length as closes)
   * @returns {{ signal: 'BULLISH'|'BEARISH'|'NEUTRAL', confidence: number, indicators: object }}
   */
  analyze(closes, highs = null, lows = null) {
    if (closes.length < 20) {
      return { signal: 'NEUTRAL', confidence: 50, indicators: {}, reason: 'Insufficient data (<20 points)' };
    }

    const indicators = {};
    const signals = [];

    // 1. RSI (14)
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1];
    indicators.rsi = rsi;

    if (rsi < 30) {
      signals.push({ name: 'RSI', direction: 'BULLISH', strength: (30 - rsi) / 30 });
    } else if (rsi > 70) {
      signals.push({ name: 'RSI', direction: 'BEARISH', strength: (rsi - 70) / 30 });
    } else {
      signals.push({ name: 'RSI', direction: 'NEUTRAL', strength: 0 });
    }

    // 2. MACD (12, 26, 9)
    const macdValues = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    if (macdValues.length >= 2) {
      const latest = macdValues[macdValues.length - 1];
      const prev = macdValues[macdValues.length - 2];
      indicators.macd = {
        value: latest.MACD,
        signal: latest.signal,
        histogram: latest.histogram,
      };

      if (latest.histogram > 0 && prev.histogram <= 0) {
        signals.push({ name: 'MACD', direction: 'BULLISH', strength: 0.8 });
      } else if (latest.histogram < 0 && prev.histogram >= 0) {
        signals.push({ name: 'MACD', direction: 'BEARISH', strength: 0.8 });
      } else if (latest.histogram > 0) {
        signals.push({ name: 'MACD', direction: 'BULLISH', strength: 0.4 });
      } else {
        signals.push({ name: 'MACD', direction: 'BEARISH', strength: 0.4 });
      }
    }

    // 3. Bollinger Bands (20, 2)
    const bbValues = BollingerBands.calculate({
      period: 20,
      values: closes,
      stdDev: 2,
    });

    if (bbValues.length > 0) {
      const bb = bbValues[bbValues.length - 1];
      const currentPrice = closes[closes.length - 1];
      indicators.bollingerBands = bb;

      const bbPosition = (currentPrice - bb.lower) / (bb.upper - bb.lower);
      indicators.bbPosition = bbPosition;

      if (bbPosition < 0.2) {
        signals.push({ name: 'BB', direction: 'BULLISH', strength: 0.6 });
      } else if (bbPosition > 0.8) {
        signals.push({ name: 'BB', direction: 'BEARISH', strength: 0.6 });
      } else {
        signals.push({ name: 'BB', direction: 'NEUTRAL', strength: 0 });
      }
    }

    // 4. SMA Cross (short 5, long 20)
    const sma5 = SMA.calculate({ period: 5, values: closes });
    const sma20 = SMA.calculate({ period: 20, values: closes });

    if (sma5.length > 0 && sma20.length > 0) {
      const latestSma5 = sma5[sma5.length - 1];
      const latestSma20 = sma20[sma20.length - 1];
      indicators.sma5 = latestSma5;
      indicators.sma20 = latestSma20;

      if (latestSma5 > latestSma20) {
        signals.push({ name: 'SMA_CROSS', direction: 'BULLISH', strength: 0.5 });
      } else {
        signals.push({ name: 'SMA_CROSS', direction: 'BEARISH', strength: 0.5 });
      }
    }

    // 5. Price momentum (% change over last 5 candles)
    const momentum = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];
    indicators.momentum = momentum;

    if (momentum > 0.005) {
      signals.push({ name: 'MOMENTUM', direction: 'BULLISH', strength: Math.min(momentum * 50, 1) });
    } else if (momentum < -0.005) {
      signals.push({ name: 'MOMENTUM', direction: 'BEARISH', strength: Math.min(Math.abs(momentum) * 50, 1) });
    } else {
      signals.push({ name: 'MOMENTUM', direction: 'NEUTRAL', strength: 0 });
    }

    // Aggregate signals
    let bullishScore = 0;
    let bearishScore = 0;
    let totalWeight = 0;

    for (const sig of signals) {
      const weight = sig.strength + 0.1; // minimum weight
      totalWeight += weight;
      if (sig.direction === 'BULLISH') bullishScore += weight;
      if (sig.direction === 'BEARISH') bearishScore += weight;
    }

    const bullishRatio = totalWeight > 0 ? bullishScore / totalWeight : 0.5;
    const confidence = Math.round(Math.max(bullishRatio, 1 - bullishRatio) * 100);
    const signal = bullishRatio > 0.55 ? 'BULLISH' : bullishRatio < 0.45 ? 'BEARISH' : 'NEUTRAL';

    const reasons = signals
      .filter((s) => s.direction !== 'NEUTRAL')
      .map((s) => `${s.name}: ${s.direction}`)
      .join(', ');

    return {
      signal,
      confidence,
      bullishRatio,
      indicators,
      signals,
      reason: reasons || 'No clear directional signals',
    };
  }
}

export default TechnicalAnalysis;
