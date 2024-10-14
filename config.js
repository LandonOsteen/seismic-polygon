require('dotenv').config(); // Load environment variables from .env

const paperTrading = process.env.PAPER_TRADING === 'true'; // Set to true for paper trading, false for live trading

module.exports = {
  alpaca: {
    keyId: paperTrading
      ? process.env.ALPACA_PAPER_KEY_ID
      : process.env.ALPACA_LIVE_KEY_ID,
    secretKey: paperTrading
      ? process.env.ALPACA_PAPER_SECRET_KEY
      : process.env.ALPACA_LIVE_SECRET_KEY,
    paper: paperTrading, // true for paper trading, false for live trading
  },
  polygon: {
    apiKey: process.env.POLYGON_API_KEY,
  },
  orderSettings: {
    stopLossCents: -30, // Slightly wider stop to handle small-cap volatility
    limitOffsetCents: 3, // Keep this tight for momentum trades
    profitTargets: [
      { targetCents: 10, percentToClose: 10 }, // Early scaling out to pad profit in case of a false breakout
      { targetCents: 20, percentToClose: 50 },
      { targetCents: 30, percentToClose: 30 },
      { targetCents: 50, percentToClose: 50 },
      { targetCents: 70, percentToClose: 30 },
      { targetCents: 90, percentToClose: 100 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 }, // Initial stop: 20 cents below entry
      { profitTargetsHit: 1, stopCents: -15 }, // After first target, tighten stop to 10 cents
      { profitTargetsHit: 2, stopCents: 0 }, // Breakeven stop at 20 cents of profit
      { profitTargetsHit: 4, stopCents: 20 },
      { profitTargetsHit: 5, stopCents: 40 },
    ],
    pyramidLevels: [
      { addInCents: 25, percentToAdd: 20, offsetCents: 3 },
      { addInCents: 35, percentToAdd: 10, offsetCents: 3 },
    ],
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every second
    positionRefresh: 2000, // Refresh positions every 2 seconds
  },
  logging: {
    level: 'info', // Logging level: 'debug', 'info', 'warn', 'error'
    file: 'logger.js', // Log file name
    excludedMessages: [], // Add any messages to exclude from dashboard logs
  },
  timeZone: 'America/New_York', // Set your time zone for accurate time calculations
};
