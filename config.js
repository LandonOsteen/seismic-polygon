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
    limitOffsetCents: 4, // Adjusted limit offset for limit orders
    profitTargets: [
      { targetCents: 5, percentToClose: 10 }, // 1
      { targetCents: 10, percentToClose: 40 }, // 2
      { targetCents: 15, percentToClose: 20 }, // 3
      { targetCents: 20, percentToClose: 50 }, // 4
      { targetCents: 30, percentToClose: 20 }, // 5
      { targetCents: 40, percentToClose: 20 }, // 6
      { targetCents: 50, percentToClose: 50 }, // 7
      { targetCents: 60, percentToClose: 20 }, // 8
      { targetCents: 70, percentToClose: 20 }, // 9
      { targetCents: 80, percentToClose: 20 }, // 10
      { targetCents: 90, percentToClose: 20 }, // 11
      { targetCents: 100, percentToClose: 100 }, // 12
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 },
      { profitTargetsHit: 1, stopCents: -15 },
      { profitTargetsHit: 2, stopCents: 0 },
      { profitTargetsHit: 4, stopCents: 5 },
      { profitTargetsHit: 5, stopCents: 10 },
      { profitTargetsHit: 6, stopCents: 15 },
      { profitTargetsHit: 7, stopCents: 20 },
      { profitTargetsHit: 8, stopCents: 30 },
      { profitTargetsHit: 9, stopCents: 40 },
      { profitTargetsHit: 10, stopCents: 50 },
      { profitTargetsHit: 11, stopCents: 60 },
    ],
    pyramidLevels: [
      { addInCents: 6, percentToAdd: 50, offsetCents: 4 },
      { addInCents: 12, percentToAdd: 50, offsetCents: 4 },
      { addInCents: 24, percentToAdd: 50, offsetCents: 4 },
      { addInCents: 34, percentToAdd: 50, offsetCents: 4 },
      { addInCents: 54, percentToAdd: 50, offsetCents: 4 },
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
