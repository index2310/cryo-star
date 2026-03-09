// src/ai/llmReasoning.js — Multi-provider LLM reasoning
// Supports: Groq (free), DeepSeek, OpenAI, Gemini, any OpenAI-compatible API
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

export class LLMReasoning {
  constructor() {
    this.client = null;
    this.provider = null;
    this._rateLimitedUntil = 0;

    const apiKey = config.llm.apiKey;
    const providerName = config.llm.provider;

    if (!apiKey) {
      log.warn('⚠️ No LLM API key set — running with TA + Stats only (LLM weight redistributed)');
      return;
    }

    this.provider = PROVIDERS[providerName] || PROVIDERS.groq;

    this.client = new OpenAI({
      apiKey,
      baseURL: this.provider.baseURL,
    });

    log.info(`🤖 LLM: ${this.provider.name} (${this.provider.model})`);
  }

  async analyze(marketData) {
    if (!this.client) {
      return { prediction: 'NEUTRAL', confidence: 50, reasoning: 'LLM not configured' };
    }

    if (Date.now() < this._rateLimitedUntil) {
      return { prediction: 'NEUTRAL', confidence: 50, reasoning: 'LLM rate limited' };
    }

    const prompt = this._buildPrompt(marketData);

    try {
      const response = await this.client.chat.completions.create({
        model: this.provider.model,
        messages: [
          {
            role: 'system',
            content: `You are a quantitative analyst specializing in short-term crypto price prediction markets. 
You analyze market data, technical indicators, and statistical models to make probabilistic predictions.
You must respond in valid JSON only, with no markdown or extra text.
Your response format: {"prediction": "YES" or "NO", "confidence": 0-100, "reasoning": "brief explanation"}`,
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content?.trim();
      // Strip markdown code fences if present
      const json = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(json);

      return {
        prediction: parsed.prediction || 'NEUTRAL',
        confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
        reasoning: parsed.reasoning || 'No reasoning provided',
      };
    } catch (err) {
      if (err.status === 429 || err.message?.includes('429')) {
        this._rateLimitedUntil = Date.now() + 300_000;
        log.warn(`⚠️ ${this.provider.name} rate limited — LLM paused 5 min`);
      } else {
        log.error(`LLM error (${this.provider.name}):`, err.message);
      }
      return { prediction: 'NEUTRAL', confidence: 50, reasoning: 'LLM unavailable' };
    }
  }

  _buildPrompt(data) {
    return `Analyze this prediction market and predict the outcome:

**Market Question:** ${data.title}

**Price Data:**
- Current Price: $${data.currentPrice}
- Target Price: $${data.targetPrice}
- Price Gap: ${data.priceGap != null ? (data.priceGap * 100).toFixed(3) + '%' : 'N/A'}
- Direction needed: ${data.currentPrice < data.targetPrice ? 'UP ↑' : 'DOWN ↓'}

**Time:**
- Time Left: ${data.timeLeftMinutes?.toFixed(1)} minutes

**Market Odds:**
- Yes: ${data.yesPercent}% | No: ${data.noPercent}%
- Pool: ${data.totalPool} CC | Bets: ${data.totalBets}

**Technical Analysis:**
- Signal: ${data.technicalSignal || 'N/A'}
- RSI: ${data.rsi?.toFixed(1) || 'N/A'}
- MACD: ${data.macdHistogram?.toFixed(6) || 'N/A'}
- Bollinger Position: ${data.bbPosition?.toFixed(2) || 'N/A'}

**Stats Model:**
- P(Above): ${data.probAbove != null ? (data.probAbove * 100).toFixed(1) + '%' : 'N/A'}
- Volatility: ${data.volatility?.toFixed(4) || 'N/A'}

Respond ONLY with JSON: {"prediction": "YES" or "NO", "confidence": 0-100, "reasoning": "your reasoning"}`;
  }
}

export default LLMReasoning;
