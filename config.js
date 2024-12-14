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
    baseVolumeRequirement: 2000000,
    morningVolumeRequirement: 2000000,
    gapPercentageRequirement: 20,
    priceRange: { min: 2, max: 12 },
    initialEntryOffsetCents: 0, // HOD breakout offset
    entryLimitOffsetCents: 15, // Additional limit offset for entry orders
    initialShareSize: 3000,
    trailingStopIncrementCents: 1,
    initialTrailingStopOffsetCents: 12,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15, // Distance from HOD to start trade-level subscriptions
    initialStopOffsetCents: 2, // Number of cents below HOD for initial stop
    dynamicStopThresholdCents: 1, // Minimum profit targets hit before dynamic stop adjustment
  },
  orderSettings: {
    limitOffsetCents: 6, // Offset for placing LIMIT orders
    profitTargets: [
      { targetCents: 5, percentToClose: 20 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 30 },
    ],
    dynamicStops: [
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
    ],
    pyramidLevels: [
      { priceIncreaseCents: 3, percentToAdd: 30, offsetCents: 5 },
      { priceIncreaseCents: 7, percentToAdd: 30, offsetCents: 5 },
      { priceIncreaseCents: 12, percentToAdd: 20, offsetCents: 5 },
    ],
  },
  watchlistFilters: {
    maxSpreadCents: 6, // Maximum allowed spread in cents
    minCandleRangeCents: 5, // Minimum required candle range in cents
  },
  orderTimeouts: {
    limit: 4000,
    pyramid: 4000,
    close: 4000,
    entry: 4000,
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
