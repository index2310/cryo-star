// src/scanner.js — Market Scanner: scrapes active markets from Unhedged.gg
import { chromium } from 'playwright';
import config from './config.js';
import Logger from './logger.js';

const log = new Logger(config.logLevel);

/**
 * Market object shape:
 * {
 *   id: string,
 *   title: string,
 *   url: string,
 *   category: string,        // 'CRYPTO', 'SPORTS', etc.
 *   status: string,          // 'ACTIVE', 'ENDED'
 *   targetPrice: number,
 *   currentPrice: number,
 *   yesOdds: number,
 *   noOdds: number,
 *   yesPercent: number,
 *   noPercent: number,
 *   totalPool: number,
 *   totalBets: number,
 *   timeLeftMinutes: number,
 *   endTime: string,
 *   resolutionTime: string,
 * }
 */

export class MarketScanner {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    log.info('Launching browser for market scanning...');
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
    });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await this.context.newPage();
  }

  async scanMarkets() {
    if (!this.page) await this.init();

    log.info('Scanning markets at', `${config.unhedged.baseUrl}/markets`);
    await this.page.goto(`${config.unhedged.baseUrl}/markets`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for the market cards to render
    await this.page.waitForTimeout(3000);

    // Extract market data from the page
    const markets = await this.page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="market"], [class*="card"], a[href*="/markets/"]');
      const results = [];

      cards.forEach((card) => {
        try {
          const link = card.closest('a') || card.querySelector('a');
          const href = link?.getAttribute('href') || '';
          if (!href.includes('/markets/')) return;

          const title = card.querySelector('h2, h3, [class*="title"]')?.textContent?.trim() || '';
          const category = card.querySelector('[class*="badge"], [class*="tag"], [class*="category"]')?.textContent?.trim() || '';

          // Try to extract odds/percentage info
          const percentages = [...card.querySelectorAll('[class*="percent"], [class*="odds"]')]
            .map(el => el.textContent?.trim());

          results.push({
            url: href.startsWith('http') ? href : `https://unhedged.gg${href}`,
            title,
            category,
            rawPercentages: percentages,
          });
        } catch (e) {
          // skip malformed cards
        }
      });

      return results;
    });

    log.info(`Found ${markets.length} markets`);
    return markets;
  }

  async getMarketDetails(marketUrl) {
    if (!this.page) await this.init();

    log.info('Fetching market details:', marketUrl);
    await this.page.goto(marketUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    await this.page.waitForTimeout(3000);

    const details = await this.page.evaluate(() => {
      const getText = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return el.textContent?.trim();
        }
        return null;
      };

      const getByText = (text) => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.children.length === 0 && el.textContent?.trim() === text) {
            return el;
          }
        }
        return null;
      };

      const getValueAfterLabel = (label) => {
        const labelEl = getByText(label);
        if (labelEl) {
          const parent = labelEl.parentElement;
          const sibling = parent?.querySelector(':last-child');
          return sibling?.textContent?.trim();
        }
        return null;
      };

      // Extract title
      const title = document.querySelector('h1, h2, [class*="title"]')?.textContent?.trim() || '';

      // Extract target & current price from chart area
      const allText = document.body.innerText;

      const targetMatch = allText.match(/Target\s*\$?([\d.]+)/i);
      const currentMatch = allText.match(/Current\s*\$?([\d.]+)/i);

      const targetPrice = targetMatch ? parseFloat(targetMatch[1]) : null;
      const currentPrice = currentMatch ? parseFloat(currentMatch[1]) : null;

      // Extract Yes/No percentages
      const yesMatch = allText.match(/Yes[\s\S]*?([\d.]+)%/i);
      const noMatch = allText.match(/No[\s\S]*?([\d.]+)%/i);
      const yesPercent = yesMatch ? parseFloat(yesMatch[1]) : null;
      const noPercent = noMatch ? parseFloat(noMatch[1]) : null;

      // Extract multipliers
      const yesMultMatch = allText.match(/Yes[\s\S]*?([\d.]+)x/i);
      const noMultMatch = allText.match(/No[\s\S]*?([\d.]+)x/i);
      const yesMultiplier = yesMultMatch ? parseFloat(yesMultMatch[1]) : null;
      const noMultiplier = noMultMatch ? parseFloat(noMultMatch[1]) : null;

      // Extract pool and bet info
      const poolMatch = allText.match(/Total Pool[\s\S]*?([\d.]+)\s*CC/i);
      const betsMatch = allText.match(/Total Bets[\s\S]*?(\d+)/i);
      const totalPool = poolMatch ? parseFloat(poolMatch[1]) : null;
      const totalBets = betsMatch ? parseInt(betsMatch[1]) : null;

      // Extract time info
      const timeLeftMatch = allText.match(/Time Left[\s\S]*?([\d]+m\s*[\d]+s|[\d]+h\s*[\d]+m)/i);
      const endTimeMatch = allText.match(/End Time[\s\S]*?([\w,\s:]+(?:AM|PM))/i);

      const timeLeft = timeLeftMatch ? timeLeftMatch[1] : null;
      const endTime = endTimeMatch ? endTimeMatch[1].trim() : null;

      // Parse time left to minutes
      let timeLeftMinutes = null;
      if (timeLeft) {
        const hMatch = timeLeft.match(/(\d+)h/);
        const mMatch = timeLeft.match(/(\d+)m/);
        const sMatch = timeLeft.match(/(\d+)s/);
        timeLeftMinutes =
          (hMatch ? parseInt(hMatch[1]) * 60 : 0) +
          (mMatch ? parseInt(mMatch[1]) : 0) +
          (sMatch ? parseInt(sMatch[1]) / 60 : 0);
      }

      // Category
      const categoryEl = document.querySelector('[class*="badge"], [class*="tag"]');
      const category = categoryEl?.textContent?.trim() || 'CRYPTO';

      return {
        title,
        category,
        targetPrice,
        currentPrice,
        yesPercent,
        noPercent,
        yesMultiplier,
        noMultiplier,
        totalPool,
        totalBets,
        timeLeft,
        timeLeftMinutes,
        endTime,
      };
    });

    return { url: marketUrl, ...details };
  }

  async interceptApiCalls(marketUrl) {
    if (!this.page) await this.init();

    const apiCalls = [];

    // Intercept network requests to discover API endpoints
    this.page.on('request', (request) => {
      const url = request.url();
      if (
        url.includes('/api/') ||
        url.includes('/graphql') ||
        url.includes('market') ||
        (url.includes('unhedged') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png'))
      ) {
        apiCalls.push({
          method: request.method(),
          url: url,
          headers: request.headers(),
          postData: request.postData(),
        });
      }
    });

    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/') || url.includes('/graphql')) {
        try {
          const body = await response.json();
          const existing = apiCalls.find(c => c.url === url);
          if (existing) existing.responseBody = body;
        } catch {
          // not JSON
        }
      }
    });

    await this.page.goto(marketUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(5000);

    log.info(`Intercepted ${apiCalls.length} API calls`);
    return apiCalls;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

// CLI mode — run standalone
if (process.argv[1] && process.argv[1].includes('scanner')) {
  const scanner = new MarketScanner();
  try {
    const markets = await scanner.scanMarkets();
    console.log('\n📊 Active Markets:');
    markets.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.title || m.url}`);
      console.log(`     Category: ${m.category}`);
      console.log(`     URL: ${m.url}`);
    });

    if (markets.length > 0) {
      console.log('\n🔍 Fetching details for first market...');
      const details = await scanner.getMarketDetails(markets[0].url);
      console.log(JSON.stringify(details, null, 2));
    }
  } catch (err) {
    console.error('Scanner error:', err.message);
  } finally {
    await scanner.close();
  }
}

export default MarketScanner;
