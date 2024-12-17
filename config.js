// config.js

require('dotenv').config(); // Load environment variables from .env

const paperTrading = process.env.PAPER_TRADING === 'true'; // true for paper, false for live

module.exports = {
  alpaca: {
    keyId: paperTrading
      ? process.env.ALPACA_PAPER_KEY_ID
      : process.env.ALPACA_LIVE_KEY_ID,
    secretKey: paperTrading
      ? process.env.ALPACA_PAPER_SECRET_KEY
      : process.env.ALPACA_LIVE_SECRET_KEY,
    paper: paperTrading,
  },
  polygon: {
    apiKey: process.env.POLYGON_API_KEY,
  },
  orderSettings: {
    // Fallback tier [3, 5.9999]
    hodOffsetCents: 4,
    entryLimitOffsetCents: 10,
    initialEntryQty: 4000,
    stopOffsetCents: 15,
    pyramidOffsetCents: 5,
    profitTargets: [
      { targetCents: 6, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 15, percentToClose: 20 },
      { targetCents: 20, percentToClose: 20 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -10 },
      { profitTargetsHit: 1, stopCents: -8 },
      { profitTargetsHit: 2, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 5 },
      { profitTargetsHit: 4, stopCents: 10 },
    ],
    pyramidLevels: [
      { addInCents: 8, percentToAdd: 100 },
      { addInCents: 18, percentToAdd: 30 },
    ],
    trailingStopOffsetCents: 10, // Adjust as needed
    initialEntryOffsetCents: 3, // Adjust as needed
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every second
    positionRefresh: 2000, // Refresh positions every 2 seconds
    watchlistRefresh: 10000, // Refresh watchlist every 10 seconds
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',
};
