const { alpaca } = require('./alpaca');
const config = require('./config');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const PolygonClient = require('./polygon');
const logger = require('./logger');
const Bottleneck = require('bottleneck');
const polygon = new PolygonClient();
const dashboard = new Dashboard();
const orderManager = new OrderManager(dashboard, polygon);

const limiter = new Bottleneck({
  minTime: 350,
  maxConcurrent: 1,
});

async function retryOperation(operation, retries = 5, delay = 1000) {
  try {
    return await operation();
  } catch (err) {
    if (retries <= 0) throw err;
    if (
      err.code === 'ECONNRESET' ||
      (err.response &&
        (err.response.status === 429 ||
          (err.response.status >= 500 && err.response.status < 600)))
    ) {
      const jitter = Math.random() * 1000;
      const totalDelay = delay + jitter;
      let message = '';

      if (err.code === 'ECONNRESET') {
        message = `ECONNRESET encountered. Retrying in ${totalDelay.toFixed(
          0
        )}ms...`;
      } else if (err.response && err.response.status === 429) {
        message = `Rate limit hit. Retrying in ${totalDelay.toFixed(0)}ms...`;
      } else if (
        err.response &&
        err.response.status >= 500 &&
        err.response.status < 600
      ) {
        message = `Server error ${
          err.response.status
        }. Retrying in ${totalDelay.toFixed(0)}ms...`;
      }

      logger.warn(message);
      dashboard.logWarning(message);
      await new Promise((res) => setTimeout(res, totalDelay));
      return retryOperation(operation, retries - 1, delay * 2);
    }
    throw err;
  }
}

const limitedGetAccount = async () =>
  retryOperation(() => limiter.schedule(() => alpaca.getAccount()));
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
