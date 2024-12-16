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
    baseVolumeRequirement: 3000000,
    morningVolumeRequirement: 3000000,
    gapPercentageRequirement: 15,
    priceRange: { min: 1.5, max: 10 },
    initialEntryOffsetCents: 2,
    entryLimitOffsetCents: 15,
    initialShareSize: 3000,
    // Removed rolling stop parameters
    fallbackStopCents: 15,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,
    profitTargetOffsetCents: 4,
    initialStopOffsetCents: 10,
    enableHodVerification: true,
    hodVerificationIntervalMs: 60000,
    initialAggBarTimeframe: { unit: 'second', amount: 30 },

    // Trailing stop offset used AFTER all profit targets hit
    trailingStopOffsetCents: 15,

    // Profit targets and dynamic stops
    profitTargets: [
      { targetCents: 6, percentToClose: 10 },
      { targetCents: 10, percentToClose: 30 },
      { targetCents: 20, percentToClose: 30 },
    ],
    dynamicStops: [
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
    ],
  },
  orderSettings: {
    limitOffsetCents: 8,
    pyramidLevels: [
      { priceIncreaseCents: 6, percentToAdd: 50, offsetCents: 5 },
      { priceIncreaseCents: 10, percentToAdd: 30, offsetCents: 5 },
    ],
  },
  watchlistFilters: {
    maxSpreadCents: 4,
    minCandleRangeCents: 3,
  },
  orderTimeouts: {
    limit: 4000,
    close: 4000,
    entry: 4000,
    pyramid: 4000,
  },
  pollingIntervals: {
    orderStatus: 3000,
    positionRefresh: 5000,
    watchlistRefresh: 10000,
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
