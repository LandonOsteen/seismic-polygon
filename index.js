const PolygonClient = require('./polygonClient');
const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const logger = require('./logger');
const config = require('./config');
const Bottleneck = require('bottleneck');

const polygon = new PolygonClient();
const dashboard = new Dashboard();
const orderManager = new OrderManager(dashboard, polygon);

const limiter = new Bottleneck({
  minTime: 350,
  maxConcurrent: 1,
});

const limitedGetAccount = limiter.wrap(alpaca.getAccount.bind(alpaca));
const limitedGetPositions = limiter.wrap(alpaca.getPositions.bind(alpaca));

setInterval(async () => {
  try {
    const accountInfo = await limitedGetAccount();
    const positions = await limitedGetPositions();

    const equity = parseFloat(accountInfo.equity);
    const lastEquity = parseFloat(accountInfo.last_equity);
    const pnl = equity - lastEquity;
    const pnlPercentage = ((pnl / lastEquity) * 100).toFixed(2);

    let unrealizedPL = 0;
    positions.forEach((position) => {
      unrealizedPL += parseFloat(position.unrealized_pl);
    });

    const accountSummary = {
      equity: equity.toFixed(2),
      cash: parseFloat(accountInfo.cash).toFixed(2),
      pnl: pnl.toFixed(2),
      pnl_percentage: pnlPercentage,
      unrealized_pl: unrealizedPL.toFixed(2),
    };

    dashboard.updateAccountSummary(accountSummary);
  } catch (err) {
    logger.error(`Error fetching account info: ${err.message}`);
    dashboard.logError(`Error fetching account info: ${err.message}`);
  }
}, 1500);

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
  dashboard.logError(`Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
  dashboard.logError(`Unhandled Rejection: ${reason}`);
});

async function main() {
  try {
    polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      await orderManager.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

    polygon.connect();

    logger.info('Polygon WebSocket connected.');
    dashboard.logInfo('Polygon WebSocket connected.');

    logger.info('Started polling for order statuses.');
    dashboard.logInfo('Started polling for order statuses.');

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

main().catch((err) => {
  logger.error(`Error in main: ${err.message}`);
  dashboard.logError(`Error in main: ${err.message}`);
});
