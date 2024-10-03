// index.js

const PolygonClient = require('./polygon'); // Updated to use PolygonClient
const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const logger = require('./logger');
const config = require('./config'); // Ensure config is imported

const polygon = new PolygonClient();
const dashboard = new Dashboard();
const orderManager = new OrderManager(dashboard, polygon);

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
  dashboard.error(`Uncaught Exception: ${err.message}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection: ${reason}`);
  dashboard.error(`Unhandled Rejection: ${reason}`);
});

async function main() {
  try {
    // Assign the onQuote handler
    polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      await orderManager.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

    // Connect to Polygon WebSocket
    polygon.connect();

    // logger.info('Polygon WebSocket connected.');
    // dashboard.log('Polygon WebSocket connected.');

    // logger.info('Started polling for order statuses.');
    // dashboard.log('Started polling for order statuses.');

    // Graceful shutdown on SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      logger.info('Gracefully shutting down...');
      dashboard.log('Gracefully shutting down...');
      process.exit(0);
    });
  } catch (err) {
    logger.error(
      `Error initializing positions or setting up connections: ${err.message}`
    );
    dashboard.error(
      `Error initializing positions or setting up connections: ${err.message}`
    );
  }
}

main().catch((err) => {
  logger.error(`Error in main: ${err.message}`);
  dashboard.error(`Error in main: ${err.message}`);
});
