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
    priceRange: { min: 2, max: 10 }, // Extended to 20 to allow >$10 stocks
    initialEntryOffsetCents: 1,
    entryLimitOffsetCents: 30,
    initialShareSize: 5000,
    trailingStopIncrementCents: 1,
    initialTrailingStopOffsetCents: 12,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,
    initialStopOffsetCents: 5,
    dynamicStopThresholdCents: 1,
    // Additional parameters for volatility adjustments
    highPriceVolatilityThreshold: 0.2, // min 5-min range for >$10 stock
    lowPriceVolatilityThreshold: 0.05, // min 5-min range for small caps
    allowedAfterHaltCooldownSeconds: 2, // Wait after halt resume before new entry
  },
  orderSettings: {
    limitOffsetCents: 10,
    // More granular profit targets for small increments capturing
    profitTargets: [
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 15, percentToClose: 20 },
      { targetCents: 20, percentToClose: 20 },
      { targetCents: 30, percentToClose: 20 },
    ],
    dynamicStops: [
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 4, stopCents: 10 },
    ],
    pyramidLevels: [
      { priceIncreaseCents: 3, percentToAdd: 40, offsetCents: 15 },
      { priceIncreaseCents: 6, percentToAdd: 40, offsetCents: 15 },
      { priceIncreaseCents: 10, percentToAdd: 20, offsetCents: 15 },
    ],
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

  // You can dynamically override symbols at runtime via dynamicConfig.json
  overrideAddSymbols: [],
  overrideRemoveSymbols: [],
};
