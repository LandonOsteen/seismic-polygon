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
    limitOffsetCents: 2,
    profitTargets: [
      { targetCents: 1, percentToClose: 30 },
      { targetCents: 2, percentToClose: 30 },
      { targetCents: 3, percentToClose: 30 },
      { targetCents: 4, percentToClose: 30 },
      { targetCents: 5, percentToClose: 30 },
      { targetCents: 6, percentToClose: 30 },
      { targetCents: 7, percentToClose: 30 },
      { targetCents: 8, percentToClose: 30 },
      { targetCents: 9, percentToClose: 30 },
      { targetCents: 10, percentToClose: 100 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -5 },
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 2, stopCents: 1 },
      { profitTargetsHit: 3, stopCents: 2 },
      { profitTargetsHit: 4, stopCents: 3 },
      { profitTargetsHit: 5, stopCents: 4 },
      { profitTargetsHit: 6, stopCents: 5 },
      { profitTargetsHit: 7, stopCents: 6 },
      { profitTargetsHit: 8, stopCents: 7 },
      { profitTargetsHit: 9, stopCents: 8 },
      { profitTargetsHit: 10, stopCents: 9 },
    ],
    pyramidLevels: [{ addInCents: 15, percentToAdd: 20, offsetCents: 3 }],
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every second
    positionRefresh: 1500, // Refresh positions every 2 seconds
  },
  logging: {
    level: 'info', // Logging level: 'debug', 'info', 'warn', 'error'
    file: 'logger.js', // Log file name
    excludedMessages: [], // Add any messages to exclude from dashboard logs
  },
  timeZone: 'America/New_York', // Set your time zone for accurate time calculations
};
