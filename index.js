const { alpaca } = require('./alpaca');
const Dashboard = require('./dashboard');
const OrderManager = require('./orderManager');
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
    dashboard.logInfo('Polygon WebSocket connected.');

    await orderManager.refreshAllSubscriptions();
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
        for (const position of positions) {
          unrealizedPL += parseFloat(position.unrealized_pl);
        }

        const accountSummary = {
          equity: equity.toFixed(2),
          cash: parseFloat(accountInfo.cash).toFixed(2),
          pnl: pnl.toFixed(2),
          pnl_percentage: pnlPercentage,
          unrealized_pl: unrealizedPL.toFixed(2),
        };

        const currentVolumeRequirement =
          orderManager.getCurrentVolumeRequirement();
        dashboard.logInfo(
          `Current Volume Requirement: ${currentVolumeRequirement}`
        );

        dashboard.updateAccountSummary(
          accountSummary,
          currentVolumeRequirement
        );
      } catch (err) {
        dashboard.logError(`Error fetching account info: ${err.message}`);
      }
    }, 1500);
  } catch (err) {
    dashboard.logError(`Error in main: ${err.message}`);
  }
})();
