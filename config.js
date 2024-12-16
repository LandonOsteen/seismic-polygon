require('dotenv').config(); // Load environment variables from .env

const paperTrading = process.env.PAPER_TRADING === 'true'; // true for paper trading, false for live trading

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
    entryQty: 100, // Quantity for opening entry orders
    entryOrderOffsetCents: 15,
    limitOffsetCents: 25, // Offset for limit orders to ensure fill
    profitTargets: [
      { targetCents: 10, percentToClose: 3 },
      { targetCents: 20, percentToClose: 3 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -35 },
      { profitTargetsHit: 1, stopCents: -15 },
      { profitTargetsHit: 2, stopCents: -0 },
    ],
    pyramidLevels: [{ addInCents: 25, percentToAdd: 1, offsetCents: 4 }],
    entryOffsetCents: 2, // Offset for triggering entry above HOD / below LOD
    trailingStopOffsetCents: 10, // Initial trailing stop offset once all targets are hit
    entryCooldownSeconds: 5, // Cooldown after placing an entry order
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every 1 second
    positionRefresh: 2000, // Refresh positions every 2 seconds
    watchlistRefresh: 5000, // Check for updated watchlist every 5 seconds
    hodLodRefresh: 30000, // Refresh HOD/LOD every 30 seconds
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',

  // Path to the watchlist JSON file
  watchlistFile: './watchlist.json',
};
