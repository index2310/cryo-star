// src/config.js — Central configuration loaded from .env
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  // LLM Provider (groq, deepseek, openai, gemini, local)
  llm: {
    provider: (process.env.LLM_PROVIDER || 'groq').toLowerCase(),
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
  },

  // Unhedged credentials
  unhedged: {
    apiKey: process.env.UNHEDGED_API_KEY || '',
    baseUrl: 'https://unhedged.gg',
  },

  // Risk management
  risk: {
    maxBetCC: parseFloat(process.env.MAX_BET_CC || '10'),
    maxBetPercent: parseFloat(process.env.MAX_BET_PERCENT || '5'),
    minEdgePercent: parseFloat(process.env.MIN_EDGE_PERCENT || '10'),
    minTimeLeftMinutes: parseFloat(process.env.MIN_TIME_LEFT_MINUTES || '5'),
    maxLosingStreak: parseInt(process.env.MAX_LOSING_STREAK || '3'),
  },

  // Bot mode
  botMode: process.env.BOT_MODE || 'signal', // 'signal' or 'auto'

  // Market filter — comma-separated categories (empty = all)
  // Examples: CRYPTO, SPORTS, ESPORTS, ECONOMICS
  marketCategories: process.env.MARKET_CATEGORIES
    ? process.env.MARKET_CATEGORIES.split(',').map(c => c.trim().toUpperCase())
    : [],

  // Price API
  priceApi: process.env.PRICE_API || 'coingecko',

  // Dashboard
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000'),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Paths
  dbPath: path.resolve(__dirname, '..', 'data', 'trades.db'),
  screenshotDir: path.resolve(__dirname, '..', 'screenshots'),
};

export default config;
