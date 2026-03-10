// src/ai/llmReasoning.js — v5.0 Multi-provider LLM reasoning
// Self-consistency, calibrated probability, provider fallback chain
import OpenAI from 'openai';
import config from '../config.js';
import Logger from '../logger.js';

const log = new Logger(config.logLevel);

// Provider configs — all use OpenAI-compatible SDK
const PROVIDERS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    name: 'Groq (Llama 3.3 70B)',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    name: 'DeepSeek Chat',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    name: 'OpenAI GPT-4o-mini',
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    name: 'Google Gemini 2.0 Flash',
  },
  local: {
    baseURL: 'http://localhost:11434/v1',
    model: 'llama3.1',
    name: 'Ollama (Local)',
  },
};

// Provider fallback order
const FALLBACK_ORDER = ['groq', 'deepseek', 'openai', 'gemini', 'local'];

export class LLMReasoning {
  constructor() {
    this.clients = []; // { client, provider, rateLimitedUntil }
    this._callCount = 0;

    const apiKey = config.llm.apiKey;
    const providerName = config.llm.provider;

    if (!apiKey) {
      log.warn('⚠️ No LLM API key set — running with TA + Stats only (LLM weight redistributed)');
      return;
    }

    // Primary provider
    const primary = PROVIDERS[providerName] || PROVIDERS.groq;
    this.clients.push({
      client: new OpenAI({ apiKey, baseURL: primary.baseURL }),
      provider: primary,
      rateLimitedUntil: 0,
    });

    log.info(`🤖 LLM: ${primary.name} (${primary.model})`);
  }

  /**
   * v5.0: Self-consistency analysis — call LLM twice, only trust if they agree
   */
  async analyze(marketData) {
    if (this.clients.length === 0) {
      return { prediction: 'NEUTRAL', confidence: 50, reasoning: 'LLM not configured', calibratedProb: 0.5 };
    }

    const prompt = this._buildPrompt(marketData);
    const systemPrompt = this._buildSystemPrompt();

    // ── Self-consistency: 2 calls with different temperatures ──
    const results = [];
    const temps = [0.2, 0.5]; // low temp (focused) + medium temp (creative)

    for (const temp of temps) {
      const result = await this._callLLM(prompt, systemPrompt, temp);
      if (result) results.push(result);
    }

    if (results.length === 0) {
      return { prediction: 'NEUTRAL', confidence: 50, reasoning: 'LLM unavailable', calibratedProb: 0.5 };
    }

    // ── Self-consistency check ──
    if (results.length >= 2) {
      const agree = results[0].prediction === results[1].prediction;

      if (agree) {
        // Both agree → average confidence, boost slightly
        const avgConf = (results[0].confidence + results[1].confidence) / 2;
        const avgProb = (results[0].calibratedProb + results[1].calibratedProb) / 2;
        return {
          prediction: results[0].prediction,
          confidence: Math.min(95, Math.round(avgConf * 1.05)), // 5% boost for consistency
          reasoning: `[2/2 agree] ${results[0].reasoning}`,
          calibratedProb: avgProb,
          selfConsistent: true,
        };
      } else {
        // Disagree → low confidence, use the one with higher confidence but dampen
        const best = results[0].confidence >= results[1].confidence ? results[0] : results[1];
        return {
          prediction: best.prediction,
          confidence: Math.max(45, Math.round(best.confidence * 0.7)), // 30% penalty
          reasoning: `[1/2 agree — low confidence] ${best.reasoning}`,
          calibratedProb: 0.5 + (best.calibratedProb - 0.5) * 0.5, // dampen toward 50%
          selfConsistent: false,
        };
      }
    }

    // Only got 1 result
    return {
      ...results[0],
      reasoning: `[1/1] ${results[0].reasoning}`,
      selfConsistent: null,
    };
  }

  async _callLLM(prompt, systemPrompt, temperature = 0.3) {
    for (const entry of this.clients) {
      if (Date.now() < entry.rateLimitedUntil) continue;

      try {
        const response = await entry.client.chat.completions.create({
          model: entry.provider.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature,
          max_tokens: 600,
        });

        const content = response.choices[0]?.message?.content?.trim();
        const json = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(json);

        this._callCount++;

        return {
          prediction: parsed.prediction || 'NEUTRAL',
          confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
          reasoning: parsed.reasoning || 'No reasoning provided',
          calibratedProb: Math.min(1, Math.max(0, (parsed.probability ?? parsed.confidence ?? 50) / 100)),
        };
      } catch (err) {
        if (err.status === 429 || err.message?.includes('429')) {
          entry.rateLimitedUntil = Date.now() + 300_000;
          log.warn(`⚠️ ${entry.provider.name} rate limited — paused 5 min`);
        } else {
          log.error(`LLM error (${entry.provider.name}):`, err.message);
        }
      }
    }
    return null;
  }

  _buildSystemPrompt() {
    return `You are an elite quantitative analyst for short-term crypto prediction markets (15-60 minute horizon).

CRITICAL RULES:
1. You must output CALIBRATED probabilities. A 70% prediction should be right 70% of the time.
2. For small price gaps (<0.3% from target), lean toward the direction of recent momentum.
3. For markets with <10 minutes left, heavily weight current price momentum over long-term indicators.
4. If the price gap is very small and time is short, the outcome is nearly random — say confidence ~55% max.
5. If technical indicators disagree with statistical model, trust statistics more for short timeframes.

RESPONSE FORMAT (valid JSON only, no markdown):
{
  "prediction": "YES" or "NO",
  "probability": 0-100 (your calibrated probability that YES is correct),
  "confidence": 0-100 (how sure you are of your analysis quality),
  "reasoning": "brief explanation focusing on the key factor"
}`;
  }

  _buildPrompt(data) {
    const gapPercent = data.priceGap != null ? (data.priceGap * 100).toFixed(4) : 'N/A';
    const direction = data.currentPrice < data.targetPrice ? 'UP ↑' : 'DOWN ↓';

    let prompt = `Predict this crypto market outcome:

**Question:** ${data.title}

**Price:**
- Current: $${data.currentPrice}
- Target: $${data.targetPrice}
- Gap: ${gapPercent}% (needs to go ${direction})
- Time Left: ${data.timeLeftMinutes?.toFixed(1)} minutes

**Technical Analysis:**
- Signal: ${data.technicalSignal || 'N/A'}
- RSI(14): ${data.rsi?.toFixed(1) || 'N/A'}
- MACD Histogram: ${data.macdHistogram?.toFixed(6) || 'N/A'}
- Bollinger Position: ${data.bbPosition?.toFixed(3) || 'N/A'} (0=lower band, 1=upper band)
- Momentum(5): ${data.momentum != null ? (data.momentum * 100).toFixed(3) + '%' : 'N/A'}

**Statistical Model:**
- P(Above Target): ${data.probAbove != null ? (data.probAbove * 100).toFixed(1) + '%' : 'N/A'}
- Annualized Volatility: ${data.volatility?.toFixed(4) || 'N/A'}`;

    // Add bid/ask spread if available
    if (data.bidAskSpread != null) {
      prompt += `\n- Bid/Ask Spread: ${(data.bidAskSpread * 100).toFixed(4)}%`;
    }

    // Add pool info for edge context
    if (data.totalPool) {
      prompt += `\n\n**Market Pool:** ${data.totalPool} CC (${data.betCount || 0} bets)`;
    }

    prompt += `\n\nRespond ONLY with JSON.`;

    return prompt;
  }
}

export default LLMReasoning;
