require('dotenv').config();

const paperTrading = process.env.PAPER_TRADING === 'true';

module.exports = {
  alpaca: {
    // Alpaca API keys are chosen based on whether PAPER_TRADING is true or false
    keyId: paperTrading
      ? process.env.ALPACA_PAPER_KEY_ID
      : process.env.ALPACA_LIVE_KEY_ID,
    secretKey: paperTrading
      ? process.env.ALPACA_PAPER_SECRET_KEY
      : process.env.ALPACA_LIVE_SECRET_KEY,
    paper: paperTrading,
  },
  polygon: {
    // Polygon.io API key for data feeds
    apiKey: process.env.POLYGON_API_KEY,
  },
  strategySettings: {
    // Minimum volume requirements to filter watchlist candidates
    baseVolumeRequirement: 40000,
    morningVolumeRequirement: 40000,
    // Minimum gap percentage to consider a ticker for the watchlist
    gapPercentageRequirement: 25,
    // Price range filter for watchlist candidates
    priceRange: { min: 1, max: 15 },
    // Cooldown after placing an opening order to avoid immediate re-entries
    openingOrderCooldownSeconds: 3,
    // Time before allowing entries after a halt resumption
    allowedAfterHaltCooldownSeconds: 1,
    // Trading start and end times (in ET)
    startTime: '06:45',
    endTime: '11:00',
    // Enable seconds-based trailing stop after all profit targets are hit
    useSecondsTrailingStop: true,
  },

  // Price tiers allow different parameters for different stock price ranges
  priceTiers: [
    {
      min: 1,
      max: 2,
      initialShareSize: 8000,
      initialStopOffsetCents: 2,
      hodTriggerOffsetCents: 1,
      entryLimitOffsetCents: 10,
      profitTargets: [
        { targetCents: 6, percentToClose: 20 },
        { targetCents: 10, percentToClose: 20 },
        { targetCents: 15, percentToClose: 40 },
      ],
      pyramidLevels: [
        { priceIncreaseCents: 3, percentToAdd: 40, offsetCents: 10 },
        { priceIncreaseCents: 6, percentToAdd: 40, offsetCents: 10 },
      ],
      secondsTrailingStopInterval: 10,
    },
    {
      min: 2,
      max: 4,
      initialShareSize: 6000,
      initialStopOffsetCents: 3,
      hodTriggerOffsetCents: 1,
      entryLimitOffsetCents: 12,
      profitTargets: [
        { targetCents: 8, percentToClose: 20 },
        { targetCents: 12, percentToClose: 20 },
        { targetCents: 18, percentToClose: 20 },
      ],
      pyramidLevels: [
        { priceIncreaseCents: 4, percentToAdd: 30, offsetCents: 12 },
        { priceIncreaseCents: 10, percentToAdd: 30, offsetCents: 12 },
      ],
      secondsTrailingStopInterval: 10,
    },
    {
      min: 5,
      max: 7,
      initialShareSize: 5000,
      initialStopOffsetCents: 5,
      hodTriggerOffsetCents: 1,
      entryLimitOffsetCents: 20,
      profitTargets: [
        { targetCents: 10, percentToClose: 20 },
        { targetCents: 15, percentToClose: 20 },
        { targetCents: 20, percentToClose: 20 },
      ],
      pyramidLevels: [
        { priceIncreaseCents: 4, percentToAdd: 40, offsetCents: 15 },
        { priceIncreaseCents: 12, percentToAdd: 20, offsetCents: 15 },
      ],
      secondsTrailingStopInterval: 10,
    },
    {
      min: 7,
      max: 10,
      initialShareSize: 4000,
      initialStopOffsetCents: 7,
      hodTriggerOffsetCents: 3,
      entryLimitOffsetCents: 20,
      profitTargets: [
        { targetCents: 12, percentToClose: 20 },
        { targetCents: 18, percentToClose: 20 },
        { targetCents: 25, percentToClose: 20 },
      ],
      pyramidLevels: [
        { priceIncreaseCents: 4, percentToAdd: 25, offsetCents: 15 },
        { priceIncreaseCents: 8, percentToAdd: 25, offsetCents: 15 },
      ],
      secondsTrailingStopInterval: 10,
    },
    {
      min: 10,
      max: 12,
      initialShareSize: 3000,
      initialStopOffsetCents: 10,
      hodTriggerOffsetCents: 6,
      entryLimitOffsetCents: 30,
      profitTargets: [
        { targetCents: 13, percentToClose: 20 },
        { targetCents: 20, percentToClose: 20 },
        { targetCents: 35, percentToClose: 20 },
      ],
      pyramidLevels: [
        { priceIncreaseCents: 5, percentToAdd: 50, offsetCents: 20 },
        { priceIncreaseCents: 16, percentToAdd: 30, offsetCents: 20 },
      ],
      secondsTrailingStopInterval: 10,
    },
    {
      min: 12,
      max: 15,
      initialShareSize: 2000,
      initialStopOffsetCents: 12,
      hodTriggerOffsetCents: 7,
      entryLimitOffsetCents: 30,
      profitTargets: [
        { targetCents: 15, percentToClose: 20 },
        { targetCents: 22, percentToClose: 20 },
        { targetCents: 35, percentToClose: 20 },
      ],
      pyramidLevels: [
        { priceIncreaseCents: 10, percentToAdd: 30, offsetCents: 25 },
        { priceIncreaseCents: 25, percentToAdd: 30, offsetCents: 25 },
      ],
      secondsTrailingStopInterval: 10,
    },
  ],

  orderSettings: {
    // Default limit offset for orders if tier-specific not found
    limitOffsetCents: 10,
    // Baseline profit targets if no tier is applicable
    profitTargets: [
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 15, percentToClose: 20 },
      { targetCents: 20, percentToClose: 20 },
    ],
    // Dynamic stops based on profit targets hit
    dynamicStops: [
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
    ],
    // Fallback pyramid levels if tier doesn't define them
    pyramidLevels: [
      { priceIncreaseCents: 3, percentToAdd: 40, offsetCents: 15 },
      { priceIncreaseCents: 6, percentToAdd: 40, offsetCents: 15 },
    ],
  },
  orderTimeouts: {
    // How long to wait before canceling orders if not filled
    limit: 4000,
    pyramid: 4000,
    close: 4000,
    entry: 4000,
  },
  pollingIntervals: {
    // Frequency of checking order statuses, positions, and watchlists
    orderStatus: 3000,
    positionRefresh: 5000,
    watchlistRefresh: 15000,
  },
  statePersistence: {
    // State saving interval and file
    saveInterval: 60000,
    stateFilePath: 'systemState.json',
  },
  logging: {
    // Logging configuration
    level: 'info',
    file: 'logger.js',
    excludedMessages: [],
  },
  // Time zone used for scheduling and interpretation of times
  timeZone: 'America/New_York',

  // Lists of symbols to forcibly add or remove at runtime
  overrideAddSymbols: [],
  overrideRemoveSymbols: [],
};
