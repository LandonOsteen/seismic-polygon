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
    baseVolumeRequirement: 3000000,
    morningVolumeRequirement: 3000000,
    gapPercentageRequirement: 10,
    priceRange: { min: 1.5, max: 10 },
    initialEntryOffsetCents: 0,
    entryLimitOffsetCents: 15,
    initialShareSize: 3000,
    trailingStopIncrementCents: 1,
    initialTrailingStopOffsetCents: 8,
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,
    initialStopOffsetCents: 2,
  },
  orderSettings: {
    limitOffsetCents: 8,
    // Reintroducing pyramid levels
    pyramidLevels: [
      { priceIncreaseCents: 6, percentToAdd: 100, offsetCents: 5 },
      { priceIncreaseCents: 10, percentToAdd: 30, offsetCents: 5 },
    ],
  },
  watchlistFilters: {
    maxSpreadCents: 6,
    minCandleRangeCents: 5,
  },
  orderTimeouts: {
    limit: 4000,
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
