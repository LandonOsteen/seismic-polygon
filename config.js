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
      { targetCents: 5, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 30 },
      { targetCents: 30, percentToClose: 20 },
      { targetCents: 40, percentToClose: 20 },
      { targetCents: 50, percentToClose: 20 },
      { targetCents: 60, percentToClose: 20 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 }, // initial stop
      { profitTargetsHit: 1, stopCents: -10 }, // 10 cent stop at 5 cent profit
      { profitTargetsHit: 2, stopCents: 0 }, // breakeven stop at 10 cents profit
      // Switch to trailing stop after hitting 3 profit targets
    ],
    trailingStop: {
      activateAfterTargetsHit: 3, // Activate trailing stop after this many profit targets are hit
      trailCents: 20, // Trailing stop distance in cents
    },
    pyramidLevels: [
      // Define pyramiding levels if needed
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
