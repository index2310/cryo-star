// src/executor.js — Bet Executor: places bets on Unhedged.gg via browser automation
import { chromium } from 'playwright';
import config from './config.js';
import Logger from './logger.js';
import path from 'path';
import fs from 'fs';

const log = new Logger(config.logLevel);

/**
 * Bet Executor — handles login and bet placement on Unhedged.gg
 */
export class BetExecutor {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  async init() {
    log.info('Launching browser for bet execution...');

    // Ensure screenshot dir exists
    if (!fs.existsSync(config.screenshotDir)) {
      fs.mkdirSync(config.screenshotDir, { recursive: true });
    }

    this.browser = await chromium.launch({
      headless: false, // Run headed for debugging & visibility
      args: ['--no-sandbox'],
      slowMo: 100,
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    this.page = await this.context.newPage();
  }

  /**
   * Login to Unhedged.gg
   * Note: Login flow depends on the actual auth method (wallet, email, etc.)
   * This is a template that should be adapted to the actual login flow.
   */
  async login() {
    if (!this.page) await this.init();

    log.info('Navigating to Unhedged.gg for login...');
    await this.page.goto(config.unhedged.baseUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    await this.page.waitForTimeout(2000);

    // Try to find and click login/connect button
    // Adapt this based on actual login flow (wallet connect, email, etc.)
    const loginSelectors = [
      'button:has-text("Connect")',
      'button:has-text("Login")',
      'button:has-text("Sign In")',
      'button:has-text("Connect Wallet")',
      '[class*="connect"]',
      '[class*="login"]',
    ];

    for (const selector of loginSelectors) {
      const btn = await this.page.$(selector);
      if (btn) {
        log.info(`Found login button: ${selector}`);
        await btn.click();
        await this.page.waitForTimeout(3000);
        break;
      }
    }

    // Take screenshot of login state
    await this.page.screenshot({
      path: path.join(config.screenshotDir, 'login_state.png'),
    });

    // TODO: Implement actual auth flow based on Unhedged's login method
    // Common options:
    // 1. Wallet Connect → need to handle modal
    // 2. Email/Password → fill in form
    // 3. Social login → handle OAuth redirect

    log.warn('⚠️  Login automation needs to be configured for your auth method.');
    log.warn('Please login manually in the browser window, then the bot will continue.');

    // Wait for user to be logged in (check for profile/balance indicator)
    try {
      await this.page.waitForSelector('[class*="balance"], [class*="profile"], [class*="wallet"]', {
        timeout: 120_000, // 2 minutes for manual login
      });
      this.isLoggedIn = true;
      log.info('✅ Login successful!');
    } catch {
      log.error('Login timed out. Please try again.');
    }

    return this.isLoggedIn;
  }

  /**
   * Place a bet on a market
   * @param {string} marketUrl - URL of the market
   * @param {'YES'|'NO'} direction - Bet direction
   * @param {number} amount - Amount in CC
   * @param {boolean} dryRun - If true, don't actually place the bet
   * @returns {{ success: boolean, details: object }}
   */
  async placeBet(marketUrl, direction, amount, dryRun = false) {
    if (!this.page) await this.init();

    log.info(`${dryRun ? '🔵 [DRY RUN]' : '🟢'} Placing ${direction} bet of ${amount} CC on ${marketUrl}`);

    try {
      // Navigate to market
      await this.page.goto(marketUrl, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await this.page.waitForTimeout(2000);

      // Screenshot before bet
      await this.page.screenshot({
        path: path.join(config.screenshotDir, `pre_bet_${Date.now()}.png`),
      });

      if (dryRun) {
        log.info('🔵 [DRY RUN] Would place bet — skipping actual execution');
        return {
          success: true,
          dryRun: true,
          details: { marketUrl, direction, amount, timestamp: new Date().toISOString() },
        };
      }

      // Click Yes or No button
      const btnSelector = direction === 'YES'
        ? 'button:has-text("Yes"), [class*="yes"]'
        : 'button:has-text("No"), [class*="no"]';

      const betBtn = await this.page.$(btnSelector);
      if (!betBtn) {
        log.error(`Could not find ${direction} button on the page`);
        return { success: false, error: 'Button not found' };
      }

      await betBtn.click();
      await this.page.waitForTimeout(1000);

      // Try to find amount input and set value
      const amountInput = await this.page.$('input[type="number"], input[class*="amount"], input[placeholder*="amount"]');
      if (amountInput) {
        await amountInput.fill(String(amount));
        await this.page.waitForTimeout(500);
      }

      // Find and click confirm/submit button
      const confirmSelectors = [
        'button:has-text("Place Bet")',
        'button:has-text("Confirm")',
        'button:has-text("Submit")',
        'button:has-text("Bet")',
        'button[type="submit"]',
      ];

      for (const sel of confirmSelectors) {
        const confirmBtn = await this.page.$(sel);
        if (confirmBtn) {
          await confirmBtn.click();
          await this.page.waitForTimeout(3000);
          break;
        }
      }

      // Screenshot after bet
      await this.page.screenshot({
        path: path.join(config.screenshotDir, `post_bet_${Date.now()}.png`),
      });

      log.trade(direction, marketUrl, amount, 'N/A');
      return {
        success: true,
        dryRun: false,
        details: { marketUrl, direction, amount, timestamp: new Date().toISOString() },
      };
    } catch (err) {
      log.error('Bet execution failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isLoggedIn = false;
    }
  }
}

export default BetExecutor;
