const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
const logger = require('./logger');
const config = require('./config');
const Bottleneck = require('bottleneck');
const PolygonClient = require('./polygon');

const polygon = new PolygonClient();
const dashboard = new Dashboard();
const orderManager = new OrderManager(dashboard, polygon);

const limiter = new Bottleneck({
  minTime: 350,
  maxConcurrent: 1,
});

const limitedGetAccount = limiter.wrap(alpaca.getAccount.bind(alpaca));
const limitedGetPositions = limiter.wrap(alpaca.getPositions.bind(alpaca));

process.on('SIGINT', async () => {
  logger.info('Gracefully shutting down...');
  dashboard.logInfo('Gracefully shutting down...');
  await orderManager.saveSystemState();
  process.exit(0);
});

(async function main() {
  try {
    await orderManager.loadSystemState();

    polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      await orderManager.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

    polygon.onTrade = async (symbol, price, size, timestamp) => {
      await orderManager.onTradeUpdate(symbol, price, size, timestamp);
    };

    polygon.connect();
    logger.info('Polygon WebSocket connected.');
    dashboard.logInfo('Polygon WebSocket connected.');

    logger.info('Started polling for order statuses.');
    dashboard.logInfo('Started polling for order statuses.');

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
  } catch (err) {
    logger.error(`Error in main: ${err.message}`);
    dashboard.logError(`Error in main: ${err.message}`);
  }
})();
