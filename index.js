// index.js

const Polygon = require('./polygon');
const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const logger = require('./logger');

const polygon = new Polygon();
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

// Set the polling intervals (in milliseconds)
const POLLING_INTERVAL = 5000; // 5 seconds for new positions
const ORDER_STATUS_POLLING_INTERVAL = 5000; // 5 seconds for order status

async function checkForNewPositions() {
  try {
    // Fetch all current positions from Alpaca
    const currentPositions = await alpaca.getPositions();

    // Compare with existing tracked positions
    for (const position of currentPositions) {
      const symbol = position.symbol;
      if (!orderManager.positions[symbol]) {
        logger.info(`New position opened: ${symbol}`);
        dashboard.log(`New position opened: ${symbol}`);

        // Add the new position to the order manager
        await orderManager.addPosition(position);
      }
    }

    // Remove positions that have been closed
    for (const symbol in orderManager.positions) {
      if (!currentPositions.find((pos) => pos.symbol === symbol)) {
        logger.info(`Position closed: ${symbol}`);
        dashboard.log(`Position closed: ${symbol}`);
        orderManager.removePosition(symbol);
      }
    }

    // Update the dashboard with the latest positions
    dashboard.updatePositions(Object.values(orderManager.positions));
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
    // Initialize existing positions
    await orderManager.initializeExistingPositions();

    // Connect to the Polygon WebSocket
    polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      await orderManager.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

    polygon.connect();

    logger.info('Polygon WebSocket connected.');
    dashboard.log('Polygon WebSocket connected.');

    // Start the polling loop to check for new positions
    setInterval(checkForNewPositions, POLLING_INTERVAL);

    // Start the periodic check for breakeven stops
    setInterval(async () => {
      await orderManager.checkBreakevenStops();
    }, 10000); // Check every 10 seconds

    // Start the polling loop to check for order statuses
    setInterval(async () => {
      await orderManager.pollOrderStatuses();
    }, ORDER_STATUS_POLLING_INTERVAL);

    logger.info(
      'Started polling for new positions, breakeven stops, and order statuses.'
    );
    dashboard.log(
      'Started polling for new positions, breakeven stops, and order statuses.'
    );
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
