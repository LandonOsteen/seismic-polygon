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
    gapPercentageRequirement: 30,
    priceRange: { min: 1, max: 15 },
    startTime: '06:45',
    endTime: '18:00',
    useSecondsTrailingStop: true,
    initialShareSize: 1000,
    volumeRequirementsInterval1: 800000,
    volumeRequirementsInterval2: 2000000,
    volumeRequirementsInterval3: 3000000,
    volumeRequirementsInterval4: 4000000,
    minOneMinuteRange: 0.05,
  },

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
  ],

  orderSettings: {
    limitOffsetCents: 10,
    profitTargets: [
      { targetCents: 10, percentToClose: 20 },
      { targetCents: 15, percentToClose: 20 },
      { targetCents: 20, percentToClose: 20 },
    ],
    dynamicStops: [
      { profitTargetsHit: 1, stopCents: 0 },
      { profitTargetsHit: 3, stopCents: 10 },
    ],
    pyramidLevels: [
      { priceIncreaseCents: 3, percentToAdd: 40, offsetCents: 15 },
      { priceIncreaseCents: 6, percentToAdd: 40, offsetCents: 15 },
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
  overrideAddSymbols: [],
  overrideRemoveSymbols: [],
};
