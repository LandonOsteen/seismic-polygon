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
    morningVolumeRequirement: 3000000,
    gapPercentageRequirement: 10,
    priceRange: { min: 1.5, max: 10 },
    initialEntryOffsetCents: 2, // Offset above HOD to trigger entry
    entryLimitOffsetCents: 15, // Additional offset for entry orders
    initialShareSize: 3000,
    rollingStopWindowSeconds: 3, // Rolling window duration in seconds for trailing stop
    rollingStopCheckIntervalMs: 1000, // Check trailing stop every 1 second
    initialTrailingStopOffsetCents: 5, // Offset from the rolling low
    fallbackStopCents: 15, // Fallback stop: x cents below avg entry
    openingOrderCooldownSeconds: 5,
    tradeProximityCents: 15,
    initialStopOffsetCents: 4, // Initial offset below HOD for initial stop
    enableHodVerification: true,
    hodVerificationIntervalMs: 120000, // Verify HOD every 2 minutes
    initialAggBarTimeframe: {
      unit: 'second',
      amount: 30, // Use 30-second bars to determine initial intraday high
    },
  },
  orderSettings: {
    limitOffsetCents: 8,
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
    // pyramid included in the general scheme; add if needed:
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
