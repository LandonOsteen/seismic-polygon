// index.js

const PolygonClient = require('./polygon');
const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const logger = require('./logger');
const config = require('./config');
const Bottleneck = require('bottleneck');

// Initialize Dashboard
const dashboard = new Dashboard();

// Initialize Polygon WebSocket Client
const polygon = new PolygonClient();

// Initialize Order Manager with Dashboard and Polygon Client
const orderManager = new OrderManager(dashboard, polygon);

// Setup Rate Limiter (if needed elsewhere)
const limiter = new Bottleneck({
  minTime: 350,
  maxConcurrent: 1,
});

// Wrap Alpaca API calls with rate limiter (already handled in OrderManager)
const limitedGetAccount = limiter.wrap(alpaca.getAccount.bind(alpaca));
const limitedGetPositions = limiter.wrap(alpaca.getPositions.bind(alpaca));

// Async Initialization Function
async function initialize() {
  try {
    // Connect to Polygon WebSocket
    polygon.connect();

    logger.info('Polygon WebSocket connected.');
    dashboard.logInfo('Polygon WebSocket connected.');

    logger.info('Started polling for order statuses.');
    dashboard.logInfo('Started polling for order statuses.');

    // Set Callbacks for Polygon Client
    polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      // All exit logic uses quote data (bid for calculations)
      await orderManager.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

    polygon.onTrade = async (symbol, tradePrice) => {
      // Entry logic uses trade data to detect if a trade prints above HOD + offset
      await orderManager.onTradeUpdate(symbol, tradePrice);
    };

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Gracefully shutting down...');
      dashboard.logInfo('Gracefully shutting down...');
      process.exit(0);
    });
  } catch (err) {
    logger.error(
      `Error initializing positions or setting up connections: ${err.message}`
    );
    dashboard.logError(
      `Error initializing positions or setting up connections: ${err.message}`
    );
  }
}

// Invoke Initialization
initialize().catch((err) => {
  logger.error(`Error in main initialization: ${err.message}`);
  dashboard.logError(`Error in main initialization: ${err.message}`);
});
