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
    // Volume requirements will be determined dynamically by time, but this is the base for pre-market and post-11 AM
    baseVolumeRequirement: 1500000,
    morningVolumeRequirement: 2000000, // From 9:30 AM to 11:00 AM ET
    gapPercentageRequirement: 20, // Minimum gap percentage
    priceRange: { min: 3, max: 20 }, // Stock price range in USD
    initialEntryOffsetCents: 1, // Offset from HOD for initial entry (-2 = 2¢ below)
    initialShareSize: 3000, // Number of shares for the initial position
    trailingStopIncrementCents: 5, // Trailing stop increments in cents
    initialTrailingStopOffsetCents: 20, // Initial trailing stop offset from the highest price in cents
  },
  orderSettings: {
    limitOffsetCents: 15, // Offset for limit orders in cents
    profitTargets: [
      { targetCents: 5, percentToClose: 20 }, // First profit target
      { targetCents: 10, percentToClose: 30 }, // Second profit target
      { targetCents: 20, percentToClose: 40 }, // Third profit target
      { targetCents: 30, percentToClose: 50 }, // Fourth profit target
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -15 }, // Stop after 0 targets hit
      { profitTargetsHit: 1, stopCents: -10 }, // Stop after 1 target hit
      { profitTargetsHit: 2, stopCents: 0 }, // Stop after 2 targets hit
      { profitTargetsHit: 3, stopCents: 5 }, // Stop after 3 targets hit
      { profitTargetsHit: 4, stopCents: 10 }, // Stop after 4 targets hit
    ],
    pyramidLevels: [
      { addInCents: 1, percentToAdd: 50, offsetCents: 6 }, // Pyramid level 1
      { addInCents: 15, percentToAdd: 50, offsetCents: 6 }, // Pyramid level 2
    ],
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every 1 second
    positionRefresh: 2000, // Refresh positions every 2 seconds
    watchlistRefresh: 15000, // Refresh watchlist every 15 seconds
  },
  logging: {
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  timeZone: 'America/New_York',

  // **Manual Override Symbols**
  // Symbols listed here will be **always added** to the watchlist, regardless of filter criteria.
  overrideAddSymbols: [
    // Example: "AAPL", "TSLA"
    // Add symbols you want to manually include in the watchlist
  ],

  // Symbols listed here will be **always removed** from the watchlist, regardless of filter criteria.
  overrideRemoveSymbols: [
    // Example: "XYZ", "ABC"
    // Add symbols you want to manually exclude from the watchlist
  ],
};
