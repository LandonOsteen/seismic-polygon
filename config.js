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
    limitOffsetCents: 3,
    profitTargets: [
      { targetCents: 8, percentToClose: 30 },
      { targetCents: 10, percentToClose: 70 },
      { targetCents: 15, percentToClose: 50 },
      { targetCents: 20, percentToClose: 100 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -25 },
      { profitTargetsHit: 1, stopCents: -10 },
      { profitTargetsHit: 2, stopCents: 0 },
    ],
    pyramidLevels: [
      { addInCents: 3, percentToAdd: 50, offsetCents: 3 },
      { addInCents: 12, percentToAdd: 20, offsetCents: 3 },
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
