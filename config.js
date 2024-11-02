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

  // Separate configurations for stocks under $10 and over $10
  orderSettingsUnder10: {
    limitOffsetCents: 2,
    profitTargets: [
      { targetCents: 4, percentToClose: 40 }, // Target 1
      { targetCents: 8, percentToClose: 70 }, // Target 2
      { targetCents: 15, percentToClose: 100 }, // Target 3
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 },
      { profitTargetsHit: 1, stopCents: -10 },
      { profitTargetsHit: 2, stopCents: 0 },
    ],
    pyramidLevels: [
      { addInCents: 5, percentToAdd: 100, offsetCents: 3 },
      { addInCents: 10, percentToAdd: 50, offsetCents: 3 },
    ],
  },

  orderSettingsOver10: {
    limitOffsetCents: 2,
    profitTargets: [
      { targetCents: 4, percentToClose: 40 }, // Target 1
      { targetCents: 8, percentToClose: 70 }, // Target 2
      { targetCents: 15, percentToClose: 100 }, // Target 3
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -25 },
      { profitTargetsHit: 1, stopCents: -10 },
      { profitTargetsHit: 2, stopCents: 0 },
    ],
    pyramidLevels: [
      { addInCents: 5, percentToAdd: 100, offsetCents: 3 },
      { addInCents: 10, percentToAdd: 50, offsetCents: 3 },
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
