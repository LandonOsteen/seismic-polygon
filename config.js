require('dotenv').config(); // Load environment variables from .env

const paperTrading = process.env.PAPER_TRADING === 'true'; // Set to true for paper trading, false for live trading

module.exports = {
  alpaca: {
    keyId: paperTrading
      ? process.env.ALPACA_PAPER_KEY_ID
      : process.env.ALPACA_LIVE_KEY_ID,
    secretKey: paperTrading
      ? process.env.ALPACA_PAPER_SECRET_KEY
      : process.env.ALPACA_LIVE_SECRET_KEY,
    paper: paperTrading, // true for paper trading, false for live trading
  },
  polygon: {
    apiKey: process.env.POLYGON_API_KEY,
  },
  orderSettings: {
    stopLossCents: 15,
    limitOffsetCents: 4,
    profitTargets: [
      { targetCents: 5, percentToClose: 5 },
      { targetCents: 8, percentToClose: 5 },
      { targetCents: 10, percentToClose: 10 },
      { targetCents: 12, percentToClose: 10 },
      { targetCents: 15, percentToClose: 10 },
      { targetCents: 20, percentToClose: 10 },
      { targetCents: 27, percentToClose: 20 },
      { targetCents: 32, percentToClose: 30 },
      { targetCents: 40, percentToClose: 40 },
      { targetCents: 50, percentToClose: 100 },
    ],
    // Removed 'stopBreakevenLevel' in favor of 'dynamicStops'
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -20 }, // Initial stop: 20 cents below avg price
      { profitTargetsHit: 1, stopCents: -15 }, // 1st stop move: 15 cents below avg price
      { profitTargetsHit: 2, stopCents: 0 }, // After 2 targets hit, stop at breakeven
      { profitTargetsHit: 4, stopCents: 2 }, // After 4 targets hit, stop 2 cents above avg price
      { profitTargetsHit: 7, stopCents: 12 }, // After 6 targets hit, stop 15 cents above avg price
      { profitTargetsHit: 8, stopCents: 20 }, // After 6 targets hit, stop 15 cents above avg price
      // Add more levels as needed
    ],
    pyramidLevels: [
      // { addInCents: 25, percentToAdd: 50, offsetCents: 4 },
      // Define pyramiding levels if needed
    ],
  },
  pollingIntervals: {
    orderStatus: 1000, // Poll order statuses every second
    positionRefresh: 2000, // Refresh positions every 2 seconds
  },
  logging: {
    level: 'info', // Logging level: 'debug', 'info', 'warn', 'error'
    file: 'logger.js', // Log file name
    excludedMessages: [], // Add any messages to exclude from dashboard logs
  },
  timeZone: 'America/New_York', // Set your time zone for accurate time calculations
};
