// index.js

const PolygonClient = require('./polygon'); // Updated to use PolygonClient
const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const logger = require('./logger');
const config = require('./config'); // Ensure config is imported

const polygon = new PolygonClient(config.polygon.apiKey); // Initialize with API key
const dashboard = new Dashboard();
const orderManager = new OrderManager(dashboard, polygon);

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
  dashboard.error(`Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection: ${reason}`);
  dashboard.error(`Unhandled Rejection: ${reason}`);
});

async function checkForNewPositions() {
  try {
    const currentPositions = await orderManager.limiter.schedule(() =>
      alpaca.getPositions()
    );

    for (const position of currentPositions) {
      const symbol = position.symbol;
      if (!orderManager.positions[symbol]) {
        logger.info(`New position opened: ${symbol}`);
        dashboard.log(`New position opened: ${symbol}`);
        await orderManager.addPosition(position);
      }
    }

    for (const symbol in orderManager.positions) {
      if (!currentPositions.find((pos) => pos.symbol === symbol)) {
        logger.info(`Position closed: ${symbol}`);
        dashboard.log(`Position closed: ${symbol}`);
        orderManager.removePosition(symbol);
      }
    }

    dashboard.updatePositions(Object.values(orderManager.positions));
    // Removed the incorrect dashboard.updateSummary() call
  } catch (err) {
    logger.error(
      `Error checking for new positions: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`
    );
    dashboard.error(
      `Error checking for new positions: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`
    );
  }
}

async function main() {
  try {
    await orderManager.initializeExistingPositions();

    polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      await orderManager.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

    polygon.connect();

    logger.info('Polygon WebSocket connected.');
    dashboard.log('Polygon WebSocket connected.');

    // Start the polling loop to check for new positions
    setInterval(checkForNewPositions, config.pollingIntervals.orderStatus);

    logger.info('Started polling for new positions and order statuses.');
    dashboard.log('Started polling for new positions and order statuses.');

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Gracefully shutting down...');
      dashboard.log('Gracefully shutting down...');

      // Optionally, close all active positions
      for (const symbol of Object.keys(orderManager.positions)) {
        await orderManager.closePositionMarketOrder(symbol);
      }

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
