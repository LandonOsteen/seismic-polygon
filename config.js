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
    // Fallback tier or default tier settings
    hodOffsetCents: 2,
    entryLimitOffsetCents: 5,
    initialEntryQty: 5000,
    stopOffsetCents: 10,
    pyramidOffsetCents: 3,
    // New parameter for stop-triggered limit orders
    stopLimitOffsetCents: 20, // Example: place the limit order 20 cents away from bid/ask for stops
    profitTargets: [
      { targetCents: 5, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 15, percentToClose: 20 },
      { targetCents: 20, percentToClose: 20 },
      { targetCents: 25, percentToClose: 20 },
      { targetCents: 30, percentToClose: 50 },
      { targetCents: 40, percentToClose: 50 },
      { targetCents: 50, percentToClose: 100 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -8 },
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 2, stopCents: 3 },
      { profitTargetsHit: 3, stopCents: 6 },
      { profitTargetsHit: 4, stopCents: 10 },
      { profitTargetsHit: 5, stopCents: 15 },
      { profitTargetsHit: 6, stopCents: 20 },
      { profitTargetsHit: 7, stopCents: 30 },
      { profitTargetsHit: 8, stopCents: 40 },
    ],
    pyramidLevels: [
      { addInCents: 8, percentToAdd: 100 },
      { addInCents: 12, percentToAdd: 30 },
      { addInCents: 22, percentToAdd: 30 },
      { addInCents: 32, percentToAdd: 30 },
    ],
    trailingStopOffsetCents: 10,
    initialEntryOffsetCents: 3,
  },
  pollingIntervals: {
    orderStatus: 1000,
    positionRefresh: 2000,
    watchlistRefresh: 30000,
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',

  autoWatchlist: {
    enabled: true,
    priceRange: { min: 1, max: 10 },
    changePercMin: 10,
    volumeMin: 2000000,
  },
};
