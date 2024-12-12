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
    baseVolumeRequirement: 60000,
    morningVolumeRequirement: 80000,
    gapPercentageRequirement: 20,
    priceRange: { min: 2, max: 10 },
    initialEntryOffsetCents: 0, // HOD breakout offset
    entryLimitOffsetCents: 35, // Additional limit offset for entry orders
    initialShareSize: 5000,
    trailingStopIncrementCents: 2,
    initialTrailingStopOffsetCents: 12,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,

    // Added Settings for Dynamic Initial Stop Based on HOD
    initialStopOffsetCents: 2, // Number of cents below HOD for initial stop
    dynamicStopThresholdCents: 1, // Minimum profit targets hit before dynamic stop adjustment
  },
  orderSettings: {
    limitOffsetCents: 10, // Offset for placing LIMIT orders
    profitTargets: [
      { targetCents: 5, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 40 },
    ],
    dynamicStops: [
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
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
    orderStatus: 3000, // Increased to 3 seconds
    positionRefresh: 5000, // Increased to 5 seconds
    watchlistRefresh: 15000, // 15 seconds
  },
  statePersistence: {
    saveInterval: 60000, // Save state every 60 seconds
    stateFilePath: 'systemState.json', // Path to the state file
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
