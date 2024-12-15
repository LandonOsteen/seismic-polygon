require('dotenv').config(); // Loads environment variables from a .env file into process.env

// Determine if the system is running in paper trading mode based on the PAPER_TRADING environment variable
const paperTrading = process.env.PAPER_TRADING === 'true';

module.exports = {
  alpaca: {
    // Alpaca API credentials
    keyId: paperTrading
      ? process.env.ALPACA_PAPER_KEY_ID // Use paper trading key if PAPER_TRADING is true
      : process.env.ALPACA_LIVE_KEY_ID, // Otherwise, use live trading key
    secretKey: paperTrading
      ? process.env.ALPACA_PAPER_SECRET_KEY // Use paper trading secret key
      : process.env.ALPACA_LIVE_SECRET_KEY, // Use live trading secret key
    paper: paperTrading, // Boolean indicating whether to use paper trading
  },
  polygon: {
    // Polygon API key for accessing market data
    apiKey: process.env.POLYGON_API_KEY,
  },
  // Configuration settings for long trading strategies
  longStrategy: {
    initialEntryOffsetCents: 2, // Offset in cents above High of Day (HOD) to trigger entry for long positions
    entryLimitOffsetCents: 15, // Additional offset in cents for placing entry limit orders
    initialShareSize: 3000, // Number of shares to buy initially when entering a long position
    rollingStopWindowSeconds: 3, // Duration in seconds for the rolling window to calculate trailing stops
    rollingStopCheckIntervalMs: 1000, // Interval in milliseconds to check and update trailing stops
    initialTrailingStopOffsetCents: 5, // Offset in cents below the rolling low to set the trailing stop
    fallbackStopCents: 15, // Fallback stop in cents below the average entry price if trailing stop conditions aren't met
    openingOrderCooldownSeconds: 5, // Cooldown period in seconds between placing consecutive entry orders
    tradeProximityCents: 15, // Proximity in cents to the HOD at which to subscribe to detailed trade data
    initialStopOffsetCents: 4, // Initial offset in cents below HOD for setting the initial stop loss
    enableHodVerification: true, // Enable periodic verification and updating of HOD
    hodVerificationIntervalMs: 120000, // Interval in milliseconds to verify HOD (e.g., every 2 minutes)
    initialAggBarTimeframe: {
      unit: 'second', // Timeframe unit for aggregation (e.g., 'second', 'minute')
      amount: 30, // Number of units per aggregation bar (e.g., 30 seconds)
    },
    pyramidLevels: [
      { priceIncreaseCents: 6, percentToAdd: 100, offsetCents: 5 }, // First pyramiding level: add 100% of initial shares at +6 cents with a 5 cents offset
      { priceIncreaseCents: 10, percentToAdd: 30, offsetCents: 5 }, // Second pyramiding level: add 30% of initial shares at +10 cents with a 5 cents offset
    ],
    limitOffsetCents: 8, // Offset in cents for placing limit orders to exit positions
  },
  // Configuration settings for short trading strategies
  shortStrategy: {
    initialEntryOffsetCents: 2, // Offset in cents below Low of Day (LOD) to trigger entry for short positions
    entryLimitOffsetCents: 15, // Additional offset in cents for placing entry limit orders
    initialShareSize: 3000, // Number of shares to sell initially when entering a short position
    rollingStopWindowSeconds: 3, // Duration in seconds for the rolling window to calculate trailing stops
    rollingStopCheckIntervalMs: 1000, // Interval in milliseconds to check and update trailing stops
    initialTrailingStopOffsetCents: 5, // Offset in cents above the rolling high to set the trailing stop
    fallbackStopCents: 15, // Fallback stop in cents above the average entry price if trailing stop conditions aren't met
    openingOrderCooldownSeconds: 5, // Cooldown period in seconds between placing consecutive entry orders
    tradeProximityCents: 15, // Proximity in cents to the LOD at which to subscribe to detailed trade data
    initialStopOffsetCents: 4, // Initial offset in cents above LOD for setting the initial stop loss
    enableHodVerification: false, // Typically not needed for shorts; set to true if tracking additional metrics
    hodVerificationIntervalMs: 120000, // Interval in milliseconds to verify HOD (not typically used for shorts)
    initialAggBarTimeframe: {
      unit: 'second', // Timeframe unit for aggregation
      amount: 30, // Number of units per aggregation bar
    },
    pyramidLevels: [
      { priceIncreaseCents: 6, percentToAdd: 100, offsetCents: 5 }, // First pyramiding level: add 100% of initial shares at -6 cents with a 5 cents offset
      { priceIncreaseCents: 10, percentToAdd: 30, offsetCents: 5 }, // Second pyramiding level: add 30% of initial shares at -10 cents with a 5 cents offset
    ],
    limitOffsetCents: 8, // Offset in cents for placing limit orders to exit positions
  },
  orderTimeouts: {
    limit: 4000, // Timeout in milliseconds for limit orders to be filled before cancellation
    close: 4000, // Timeout for close orders
    entry: 4000, // Timeout for entry orders
    pyramid: 4000, // Timeout for pyramid orders
  },
  pollingIntervals: {
    orderStatus: 3000, // Interval in milliseconds to poll and update order statuses
    positionRefresh: 5000, // Interval to refresh and update current positions
    watchlistRefresh: 15000, // Interval to check for updates in manualWatchlist.json (e.g., every 15 seconds)
  },
  statePersistence: {
    saveInterval: 60000, // Interval in milliseconds to save the system state to a file
    stateFilePath: 'systemState.json', // File path for persisting the system state
  },
  logging: {
    level: 'info', // Logging level ('error', 'warn', 'info', 'verbose', 'debug', 'silly')
    file: 'logger.js', // Reference to the logger configuration file
    excludedMessages: [], // Array of message substrings to exclude from logging/displaying
  },
  timeZone: 'America/New_York', // Time zone setting for the system, affecting time-based operations

  overrideAddSymbols: [], // Symbols to forcibly add to the watchlist regardless of other criteria
  overrideRemoveSymbols: [], // Symbols to forcibly remove from the watchlist regardless of other criteria
};
