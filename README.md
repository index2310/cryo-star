# 🤖 Unhedged AI Prediction Bot

AI-powered bot for [Unhedged.gg](https://unhedged.gg) prediction markets. Analyzes crypto markets using technical analysis, statistical modeling, and LLM reasoning to generate trade signals and optionally auto-place bets.

## Features

- **REST API Integration** — Direct API calls, no browser needed
- **Triple AI Analysis** — Technical Analysis (40%) + Statistical Model (35%) + LLM GPT-4o-mini (25%)
- **Kelly Criterion** — Optimal position sizing with half-Kelly safety
- **Risk Management** — Max bet limits, minimum edge, losing streak protection
- **Real-time Dashboard** — Dark-themed monitoring UI at `localhost:3000`
- **Trade Logger** — SQLite database for audit trail
- **Dry Run Mode** — Test signals without placing real bets

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure (API key only — no login needed!)
cp .env.example .env
# Edit .env: set UNHEDGED_API_KEY and OPENAI_API_KEY

# 3. Run in signal mode (recommended first)
npm run dry-run

# 4. Open dashboard → http://localhost:3000
```

## Architecture

```
API Client (/api/v1/markets) → Price Collector → AI Engine → Decision → API Bet (/api/v1/bets)
     ~100ms per market          CoinGecko        TA+Stats+LLM   Kelly       Bearer Token
```

## Configuration (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `UNHEDGED_API_KEY` | ✅ | API key from Unhedged.gg |
| `OPENAI_API_KEY` | ✅ | For LLM analysis |
| `BOT_MODE` | - | `signal` (default) or `auto` |
| `MAX_BET_CC` | - | Max bet per market (default: 10) |
| `MIN_EDGE_PERCENT` | - | Min edge to place bet (default: 10%) |

## Project Structure
```
src/
├── index.js                  # Main orchestrator (30s loop)
├── apiClient.js              # Unhedged REST API client
├── config.js                 # .env configuration
├── logger.js                 # Colored console logger
├── priceCollector.js         # CoinGecko/Binance price data
├── db.js                     # SQLite trade logger
├── ai/
│   ├── engine.js             # Combined AI scoring
│   ├── technicalAnalysis.js  # RSI, MACD, Bollinger, SMA
│   ├── statisticalModel.js   # GBM probability calculator
│   └── llmReasoning.js       # GPT-4o-mini analysis
└── dashboard/
    ├── server.js             # HTTP + WebSocket server
    └── index.html            # Monitoring UI
```

## ⚠️ Risk Warning

This bot involves real money (Canton Coin). Always start with `BOT_MODE=signal` and validate predictions before going live.
