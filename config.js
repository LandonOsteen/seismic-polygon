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
    baseVolumeRequirement: 20000,
    morningVolumeRequirement: 20000,
    gapPercentageRequirement: 10,
    priceRange: { min: 1.5, max: 15 },
    initialEntryOffsetCents: 1,
    entryLimitOffsetCents: 10,
    initialShareSize: 5000,
    openingOrderCooldownSeconds: 4,
    initialStopBelowHodCents: 3,
    trailingStopIntervalSeconds: 5,

    minAccumulatedVolume: 1500000, // Minimum accumulated volume requirement
    minOneMinuteRange: 0.03, // Minimum 1-minute range required
    maxSpreadCents: 5, // Maximum allowed spread in cents (e.g., 10 = $0.10)
  },
  orderSettings: {
    limitOffsetCents: 15,
    profitTargets: [
      { targetCents: 6, percentToClose: 10 },
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 20, percentToClose: 40 },
      { targetCents: 30, percentToClose: 50 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -6 },
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
      { profitTargetsHit: 4, stopCents: 20 },
    ],
    pyramidLevels: [
      { addInCents: 3, percentToAdd: 50, offsetCents: 10 },
      { addInCents: 8, percentToAdd: 20, offsetCents: 10 },
      { addInCents: 12, percentToAdd: 20, offsetCents: 10 },
      { addInCents: 25, percentToAdd: 20, offsetCents: 10 },
    ],
  },
  orderTimeouts: {
    pyramid: 3000,
    close: 3000,
    ioc: 3000,
    entry: 3000,
  },
  pollingIntervals: {
    orderStatus: 1000,
    positionRefresh: 2000,
    watchlistRefresh: 5000,
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
