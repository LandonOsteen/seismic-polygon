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
    stopLossCents: -30,
    limitOffsetCents: 3,
    profitTargets: [
      { targetCents: 10, percentToClose: 20 }, // 1
      { targetCents: 20, percentToClose: 50 }, // 2
      { targetCents: 30, percentToClose: 30 }, // 3
      { targetCents: 40, percentToClose: 30 }, // 4
      { targetCents: 50, percentToClose: 50 }, // 5
      { targetCents: 60, percentToClose: 100 }, // 6
    ],
    dynamicStops: [
      { profitTargetsHit: 0, stopCents: -30 },
      { profitTargetsHit: 1, stopCents: -20 },
      { profitTargetsHit: 2, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
      { profitTargetsHit: 5, stopCents: 30 },
      { profitTargetsHit: 6, stopCents: 40 },
    ],
    pyramidLevels: [
      { addInCents: 25, percentToAdd: 35, offsetCents: 3 },
      { addInCents: 35, percentToAdd: 25, offsetCents: 3 },
      { addInCents: 45, percentToAdd: 15, offsetCents: 3 },
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

// require('dotenv').config(); // Load environment variables from .env

// const paperTrading = process.env.PAPER_TRADING === 'true'; // Set to true for paper trading, false for live trading

// module.exports = {
//   alpaca: {
//     keyId: paperTrading
//       ? process.env.ALPACA_PAPER_KEY_ID
//       : process.env.ALPACA_LIVE_KEY_ID,
//     secretKey: paperTrading
//       ? process.env.ALPACA_PAPER_SECRET_KEY
//       : process.env.ALPACA_LIVE_SECRET_KEY,
//     paper: paperTrading, // true for paper trading, false for live trading
//   },
//   polygon: {
//     apiKey: process.env.POLYGON_API_KEY,
//   },
//   orderSettings: {
//     stopLossCents: -10,
//     limitOffsetCents: 3,
//     profitTargets: [
//       { targetCents: 4, percentToClose: 30 },
//       { targetCents: 10, percentToClose: 50 },
//       { targetCents: 20, percentToClose: 30 },
//       { targetCents: 30, percentToClose: 30 },
//       { targetCents: 40, percentToClose: 20 },
//       { targetCents: 50, percentToClose: 20 }, // 6
//       { targetCents: 60, percentToClose: 20 }, // 7
//       { targetCents: 70, percentToClose: 20 }, // 8
//       { targetCents: 90, percentToClose: 20 }, // 9
//       { targetCents: 100, percentToClose: 100 }, // 10
//     ],
//     dynamicStops: [
//       { profitTargetsHit: 0, stopCents: -10 },
//       { profitTargetsHit: 1, stopCents: 0 },
//       { profitTargetsHit: 2, stopCents: 3 },
//       { profitTargetsHit: 3, stopCents: 10 },
//       { profitTargetsHit: 4, stopCents: 20 },
//       { profitTargetsHit: 5, stopCents: 25 },
//       { profitTargetsHit: 6, stopCents: 30 },
//       { profitTargetsHit: 7, stopCents: 40 },
//       { profitTargetsHit: 8, stopCents: 50 },
//       { profitTargetsHit: 9, stopCents: 60 },
//     ],
//     pyramidLevels: [
//       { addInCents: 25, percentToAdd: 35, offsetCents: 3 },
//       { addInCents: 35, percentToAdd: 25, offsetCents: 3 },
//       { addInCents: 45, percentToAdd: 15, offsetCents: 3 },
//     ],
//   },
//   pollingIntervals: {
//     orderStatus: 1000, // Poll order statuses every second
//     positionRefresh: 2000, // Refresh positions every 2 seconds
//   },
//   logging: {
//     level: 'info', // Logging level: 'debug', 'info', 'warn', 'error'
//     file: 'logger.js', // Log file name
//     excludedMessages: [], // Add any messages to exclude from dashboard logs
//   },
//   timeZone: 'America/New_York', // Set your time zone for accurate time calculations
// };
