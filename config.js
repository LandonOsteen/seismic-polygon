// config.js

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
    baseVolumeRequirement: 50000,
    morningVolumeRequirement: 80000,
    gapPercentageRequirement: 30,
    priceRange: { min: 2, max: 10 },
    initialEntryOffsetCents: 0, // HOD breakout offset
    entryLimitOffsetCents: 35, // Additional limit offset for entry orders
    initialShareSize: 5000,
    trailingStopIncrementCents: 2,
    initialTrailingStopOffsetCents: 12,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,
  },
  orderSettings: {
    limitOffsetCents: 10, // Offset for placing LIMIT orders
    profitTargets: [
      { targetCents: 5, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 40 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: 6 },
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
      { profitTargetsHit: 4, stopCents: 20 },
      { profitTargetsHit: 5, stopCents: 30 },
    ],
    pyramidLevels: [
      { priceIncreaseCents: 3, percentToAdd: 40, offsetCents: 2 },
      { priceIncreaseCents: 12, percentToAdd: 20, offsetCents: 2 },
      // Add more levels as needed
    ],
  },
  orderTimeouts: {
    limit: 4000, // Timeout for LIMIT orders in milliseconds
    pyramid: 4000,
    close: 4000,
    entry: 4000,
  },
  pollingIntervals: {
    orderStatus: 1000, // 1 second
    positionRefresh: 2000, // 2 seconds
    watchlistRefresh: 15000, // 15 seconds
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',

  overrideAddSymbols: [],

  overrideRemoveSymbols: [],
};
