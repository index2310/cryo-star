// src/ai/statisticalModel.js — Statistical probability calculator
// Uses historical volatility to estimate probability of price reaching target

/**
 * Statistical probability model for binary prediction markets.
 * Estimates the probability of an asset's price reaching a target
 * within a given time window, using log-normal price distribution.
 */
export class StatisticalModel {
  /**
   * Calculate probability that price will be above/below target at resolution time.
   *
   * Uses Geometric Brownian Motion assumption:
   *   ln(S_T / S_0) ~ N(mu * T, sigma^2 * T)
   *
   * @param {number} currentPrice - Current asset price
   * @param {number} targetPrice  - Target price for the market
   * @param {number} timeLeftMinutes - Minutes until resolution
   * @param {number} volatility - Annualized volatility (stddev of log returns)
   * @param {number} drift - Expected drift (annualized, default 0)
   * @returns {{ probAbove: number, probBelow: number, zScore: number, confidence: number }}
   */
  predictProbability(currentPrice, targetPrice, timeLeftMinutes, volatility, drift = 0) {
    if (currentPrice <= 0 || targetPrice <= 0 || timeLeftMinutes <= 0) {
      return { probAbove: 0.5, probBelow: 0.5, zScore: 0, confidence: 50 };
    }

    // Convert minutes to fraction of year (approx)
    const T = timeLeftMinutes / (365.25 * 24 * 60);

    // Log return needed to reach target
    const logReturn = Math.log(targetPrice / currentPrice);

    // Expected log return over time T
    const mu = (drift - 0.5 * volatility ** 2) * T;

    // Standard deviation of log return over time T
    const sigma = volatility * Math.sqrt(T);

    if (sigma === 0) {
      // No volatility — deterministic
      return {
        probAbove: currentPrice >= targetPrice ? 1 : 0,
        probBelow: currentPrice < targetPrice ? 1 : 0,
        zScore: 0,
        confidence: 100,
      };
    }

    // Z-score: how many std devs away is the target?
    const zScore = (logReturn - mu) / sigma;

    // P(price > target) = P(Z > zScore) = 1 - Φ(zScore)
    const probAbove = 1 - this._normalCDF(zScore);
    const probBelow = 1 - probAbove;

    // Confidence: how far from 50/50 the prediction is
    const confidence = Math.round(Math.max(probAbove, probBelow) * 100);

    return { probAbove, probBelow, zScore, confidence };
  }

  /**
   * Estimate volatility from recent price data
   * @param {number[]} prices - Array of recent prices
   * @param {number} intervalMinutes - Time interval between price points
   * @returns {number} Annualized volatility
   */
  estimateVolatility(prices, intervalMinutes = 1) {
    if (prices.length < 3) return 0.5; // default moderate volatility

    // Calculate log returns
    const logReturns = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > 0 && prices[i - 1] > 0) {
        logReturns.push(Math.log(prices[i] / prices[i - 1]));
      }
    }

    if (logReturns.length < 2) return 0.5;

    // Standard deviation of log returns
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    // Annualize: multiply by sqrt(number of intervals per year)
    const intervalsPerYear = (365.25 * 24 * 60) / intervalMinutes;
    const annualizedVol = stdDev * Math.sqrt(intervalsPerYear);

    return annualizedVol;
  }

  /**
   * Calculate edge vs market odds
   * @param {number} aiProbability - Our estimated probability (0-1)
   * @param {number} marketProbability - Market implied probability (0-1)
   * @returns {{ edge: number, kellyFraction: number, recommendation: string }}
   */
  calculateEdge(aiProbability, marketProbability) {
    // Edge is the difference between our probability and market's
    const edge = aiProbability - marketProbability;

    // Kelly Criterion: f* = (bp - q) / b
    // Where b = (1/marketProbability - 1) is the odds
    const b = (1 / marketProbability) - 1;
    const p = aiProbability;
    const q = 1 - p;
    const kellyFraction = b > 0 ? Math.max(0, (b * p - q) / b) : 0;

    let recommendation = 'SKIP';
    if (edge > 0.10) recommendation = 'STRONG_BET';
    else if (edge > 0.05) recommendation = 'BET';
    else if (edge > 0.02) recommendation = 'LEAN';

    return {
      edge,
      edgePercent: Math.round(edge * 100),
      kellyFraction,
      kellyPercent: Math.round(kellyFraction * 100),
      recommendation,
    };
  }

  // Standard normal CDF using Abramowitz & Stegun approximation
  _normalCDF(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }
}

export default StatisticalModel;
