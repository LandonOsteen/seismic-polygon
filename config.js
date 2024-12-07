require('dotenv').config();

const paperTrading = process.env.PAPER_TRADING === 'true';

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
  strategySettings: {
    volumeRequirement: 800000, // Min required volume
    gapPercentageRequirement: 20, // Min gap percentage
    priceRange: { min: 3, max: 20 }, // Price range filter
    initialEntryOffsetCents: -2, // Offset from HOD for initial entry (-2 means 2¢ below HOD)
    initialShareSize: 1000, // Initial position size
    trailingStopIncrementCents: 5, // Trailing stop increments in cents
  },
  orderSettings: {
    limitOffsetCents: 25,
    profitTargets: [
      { targetCents: 10, percentToClose: 3 },
      { targetCents: 20, percentToClose: 3 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -35 },
      { profitTargetsHit: 1, stopCents: -15 },
      { profitTargetsHit: 2, stopCents: 0 },
    ],
    pyramidLevels: [{ addInCents: 25, percentToAdd: 1, offsetCents: 4 }],
  },
  trailingStopSettings: {
    // Additional trailing stop parameters can be added here if needed
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every second
    positionRefresh: 2000, // Refresh positions every 2 seconds
    watchlistRefresh: 60000, // Refresh watchlist every 1 minute
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',
};
