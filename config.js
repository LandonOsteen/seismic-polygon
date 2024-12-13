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
    baseVolumeRequirement: 800000,
    morningVolumeRequirement: 1000000,
    gapPercentageRequirement: 25,
    priceRange: { min: 3, max: 12 },
    initialEntryOffsetCents: 0, // HOD breakout offset
    entryLimitOffsetCents: 10, // Additional limit offset for entry orders
    initialShareSize: 3000,
    trailingStopIncrementCents: 1,
    initialTrailingStopOffsetCents: 25,
    openingOrderCooldownSeconds: 5,
  },
  orderSettings: {
    limitOffsetCents: 10,
    profitTargets: [
      { targetCents: 8, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 40 },
      { targetCents: 30, percentToClose: 50 },
      { targetCents: 50, percentToClose: 50 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -6 },
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
    ],
    pyramidLevels: [
      { addInCents: 3, percentToAdd: 40, offsetCents: 10 },
      { addInCents: 12, percentToAdd: 20, offsetCents: 6 },
    ],
  },
  orderTimeouts: {
    pyramid: 3000,
    close: 3000,
    ioc: 3000,
    entry: 3000, // New timeout for entry orders
  },
  pollingIntervals: {
    orderStatus: 1000,
    positionRefresh: 2000,
    watchlistRefresh: 10000,
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
