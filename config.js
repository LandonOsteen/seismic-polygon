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
    morningVolumeRequirement: 50000,
    gapPercentageRequirement: 25,
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
    limitOffsetCents: 10,
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
      { addInCents: 3, percentToAdd: 40, offsetCents: 20 },
      { addInCents: 12, percentToAdd: 20, offsetCents: 20 },
    ],
  },
  orderTimeouts: {
    pyramid: 4000,
    close: 4000,
    ioc: 4000,
    entry: 4000, // New timeout for entry orders
  },
  pollingIntervals: {
    orderStatus: 1000,
    positionRefresh: 2000,
    watchlistRefresh: 15000,
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
