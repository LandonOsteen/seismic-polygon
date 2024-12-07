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
    // Volume requirements will be determined dynamically by time, but this is the base for pre-market and post-11 AM
    baseVolumeRequirement: 800000,
    morningVolumeRequirement: 2000000, // From 9:30 AM to 11:00 AM ET
    gapPercentageRequirement: 20,
    priceRange: { min: 3, max: 20 },
    initialEntryOffsetCents: -2, // Offset from HOD for initial entry
    initialShareSize: 1000, // Initial position size
    trailingStopIncrementCents: 5, // Trailing stop increments in cents
    initialTrailingStopOffsetCents: 20, // Initial trailing stop offset from the highest price in cents
  },
  orderSettings: {
    limitOffsetCents: 25,
    profitTargets: [
      { targetCents: 10, percentToClose: 3 },
      { targetCents: 20, percentToClose: 3 },
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -35 },
      { profitTargetsHit: 1, stopCents: -15 },
      { profitTargetsHit: 2, stopCents: 0 },
    ],
    pyramidLevels: [{ addInCents: 25, percentToAdd: 1, offsetCents: 4 }],
  },
  pollingIntervals: {
    orderStatus: 1000,
    positionRefresh: 2000,
    watchlistRefresh: 15000, // Refresh watchlist every 15 seconds
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',
};
