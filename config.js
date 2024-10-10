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
    stopLossCents: -20, // Slightly wider stop to handle small-cap volatility
    limitOffsetCents: 3, // Keep this tight for momentum trades
    profitTargets: [
      { targetCents: 5, percentToClose: 5 },
      { targetCents: 10, percentToClose: 50 }, // Early scaling out to secure some gains
      { targetCents: 15, percentToClose: 20 },
      { targetCents: 20, percentToClose: 50 },
      { targetCents: 30, percentToClose: 10 },
      { targetCents: 50, percentToClose: 50 },
      { targetCents: 75, percentToClose: 100 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 }, // Initial stop: 20 cents below entry
      { profitTargetsHit: 1, stopCents: -10 }, // After first target, tighten stop to 10 cents
      { profitTargetsHit: 3, stopCents: 0 }, // Breakeven stop after 3 targets hit
      { profitTargetsHit: 6, stopCents: 20 }, // Stop moves 20 cents above entry after 5 targets hit
      { profitTargetsHit: 7, stopCents: 50 }, // Lock in significant profits if price continues running
      { profitTargetsHit: 8, stopCents: 70 }, // Lock in significant profits if price continues running
    ],
    pyramidLevels: [
      { addInCents: 25, percentToAdd: 30, offsetCents: 4 },
      { addInCents: 40, percentToAdd: 20, offsetCents: 4 },
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
