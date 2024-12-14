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
    baseVolumeRequirement: 1000000,
    morningVolumeRequirement: 1500000,
    gapPercentageRequirement: 20,
    priceRange: { min: 2, max: 10 },
    initialEntryOffsetCents: 0, // For initial breakout entries
    entryLimitOffsetCents: 20, // Additional limit offset for entry orders
    initialShareSize: 5000,
    trailingStopIncrementCents: 2,
    initialTrailingStopOffsetCents: 12,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,
  },
  orderSettings: {
    limitOffsetCents: 5, // Offset for placing LIMIT orders
    profitTargets: [
      { targetCents: 5, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 40 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -4 },
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
    ],
    pyramidLevels: [
      { priceIncreaseCents: 3, percentToAdd: 40, offsetCents: 5 },
      { priceIncreaseCents: 12, percentToAdd: 20, offsetCents: 5 },
    ],
  },
  watchlistFilters: {
    maxSpreadCents: 6, // maximum spread
    minCandleRangeCents: 5, // minimum 1-minute candle range
  },
  orderTimeouts: {
    limit: 5000,
    pyramid: 5000,
    close: 5000,
    entry: 5000,
  },
  pollingIntervals: {
    orderStatus: 3000,
    positionRefresh: 5000,
    watchlistRefresh: 15000,
  },
  statePersistence: {
    saveInterval: 60000,
    stateFilePath: 'systemState.json',
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
