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
      { targetCents: 5, percentToClose: 20 }, // Target 1
      { targetCents: 10, percentToClose: 30 }, // Target 2
      { targetCents: 15, percentToClose: 20 }, // Target 3
      { targetCents: 20, percentToClose: 30 }, // Target 4
      { targetCents: 30, percentToClose: 20 }, // Target 5
      { targetCents: 40, percentToClose: 20 }, // Target 6
      { targetCents: 50, percentToClose: 50 }, // Target 7
      { targetCents: 60, percentToClose: 20 }, // Target 8
      { targetCents: 70, percentToClose: 20 }, // Target 9
      { targetCents: 80, percentToClose: 20 }, // Target 10
      { targetCents: 90, percentToClose: 20 }, // Target 11
      { targetCents: 100, percentToClose: 100 }, // Target 12
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 },
      { profitTargetsHit: 1, stopCents: -15 },
      { profitTargetsHit: 2, stopCents: -10 },
      { profitTargetsHit: 3, stopCents: 5 },
      { profitTargetsHit: 4, stopCents: 10 },
      { profitTargetsHit: 5, stopCents: 15 },
      { profitTargetsHit: 6, stopCents: 20 },
      { profitTargetsHit: 7, stopCents: 25 },
      { profitTargetsHit: 8, stopCents: 40 },
      { profitTargetsHit: 9, stopCents: 50 },
      { profitTargetsHit: 10, stopCents: 60 },
      { profitTargetsHit: 11, stopCents: 70 },
    ],
    pyramidLevels: [{ addInCents: 10, percentToAdd: 30, offsetCents: 3 }],
  },

  orderSettingsOver10: {
    limitOffsetCents: 3,
    profitTargets: [
      { targetCents: 6, percentToClose: 20 }, // Target 1
      { targetCents: 12, percentToClose: 30 }, // Target 2
      { targetCents: 18, percentToClose: 20 }, // Target 3
      { targetCents: 24, percentToClose: 30 }, // Target 4
      { targetCents: 36, percentToClose: 20 }, // Target 5
      { targetCents: 48, percentToClose: 20 }, // Target 6
      { targetCents: 60, percentToClose: 50 }, // Target 7
      { targetCents: 72, percentToClose: 20 }, // Target 8
      { targetCents: 84, percentToClose: 20 }, // Target 9
      { targetCents: 96, percentToClose: 20 }, // Target 10
      { targetCents: 108, percentToClose: 20 }, // Target 11
      { targetCents: 120, percentToClose: 100 }, // Target 12
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -25 },
      { profitTargetsHit: 2, stopCents: -15 },
      { profitTargetsHit: 3, stopCents: 5 },
      { profitTargetsHit: 4, stopCents: 10 },
      { profitTargetsHit: 5, stopCents: 15 },
      { profitTargetsHit: 6, stopCents: 20 },
      { profitTargetsHit: 7, stopCents: 30 },
      { profitTargetsHit: 8, stopCents: 40 },
      { profitTargetsHit: 9, stopCents: 50 },
      { profitTargetsHit: 10, stopCents: 60 },
      { profitTargetsHit: 11, stopCents: 70 },
    ],
    pyramidLevels: [{ addInCents: 12, percentToAdd: 30, offsetCents: 4 }],
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
