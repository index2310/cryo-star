// src/logger.js — Colored console logger with levels
import chalk from 'chalk';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor(level = 'info') {
    this.level = LEVELS[level] ?? 1;
  }

  #timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  debug(...args) {
    if (this.level <= 0) console.log(chalk.gray(`[${this.#timestamp()}] [DEBUG]`), ...args);
  }

  info(...args) {
    if (this.level <= 1) console.log(chalk.cyan(`[${this.#timestamp()}] [INFO]`), ...args);
  }

  warn(...args) {
    if (this.level <= 2) console.log(chalk.yellow(`[${this.#timestamp()}] [WARN]`), ...args);
  }

  error(...args) {
    if (this.level <= 3) console.log(chalk.red(`[${this.#timestamp()}] [ERROR]`), ...args);
  }

  signal(direction, market, confidence, reason) {
    const icon = direction === 'YES' ? chalk.green('▲ YES') : chalk.red('▼ NO');
    const conf = confidence >= 70 ? chalk.green(`${confidence}%`) : chalk.yellow(`${confidence}%`);
    console.log(
      chalk.magenta(`[${this.#timestamp()}] [SIGNAL]`),
      icon,
      chalk.white(market),
      `| Confidence: ${conf}`,
      `| ${reason}`
    );
  }

  trade(action, market, amount, odds) {
    console.log(
      chalk.bgGreen.black(` TRADE `),
      chalk.white(`${action} on "${market}"`),
      chalk.yellow(`${amount} CC`),
      chalk.gray(`@ ${odds}x`)
    );
  }
}

export default Logger;
