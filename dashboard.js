// dashboard.js

const blessed = require('blessed');
const config = require('./config');

class Dashboard {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Exit System',
    });

    // Orders List
    this.ordersList = blessed.list({
      top: 0,
      left: 0,
      width: '50%',
      height: '50%',
      label: 'Active Orders',
      border: {
        type: 'line',
      },
      style: {
        selected: {
          bg: 'magenta',
        },
      },
      keys: true,
      vi: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'grey',
        },
        style: {
          bg: 'magenta',
        },
      },
      alwaysScroll: true,
      scrollable: true,
    });

    // Positions List
    this.positionsList = blessed.list({
      top: 0,
      left: '50%',
      width: '50%',
      height: '50%',
      label: 'Positions',
      border: {
        type: 'line',
      },
      style: {
        selected: {
          bg: 'blue',
        },
      },
      keys: true,
      vi: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'grey',
        },
        style: {
          bg: 'blue',
        },
      },
      alwaysScroll: true,
      scrollable: true,
    });

    // Logs Box
    this.logBox = blessed.log({
      top: '50%',
      left: 0,
      width: '100%',
      height: '50%',
      label: 'Logs',
      border: {
        type: 'line',
      },
      scrollbar: {
        ch: ' ',
      },
      alwaysScroll: true,
      scrollable: true,
      keys: true,
      vi: true,
    });

    // Error Box
    this.errorBox = blessed.log({
      top: '50%',
      left: 0,
      width: '100%',
      height: '50%',
      label: 'Errors',
      border: {
        type: 'line',
      },
      style: {
        fg: 'red',
      },
      scrollbar: {
        ch: ' ',
      },
      alwaysScroll: true,
      scrollable: true,
      keys: true,
      vi: true,
    });

    // Append all components to the screen
    this.screen.append(this.ordersList);
    this.screen.append(this.positionsList);
    this.screen.append(this.logBox);
    this.screen.append(this.errorBox);

    // Exit the program
    this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

    this.screen.render();
  }

  /**
   * Update the list of active orders on the dashboard.
   * @param {Array} orders - Array of active order objects from Alpaca.
   */
  updateOrders(orders) {
    this.ordersList.clearItems();

    if (!Array.isArray(orders) || orders.length === 0) {
      this.ordersList.addItem('No active orders.');
    } else {
      orders.forEach((order) => {
        const statusColor = this.getOrderStatusColor(order.status);
        const orderItem = `{${statusColor}-fg}ID: ${order.id} | ${
          order.symbol
        } | ${order.side.toUpperCase()} | ${order.type.toUpperCase()} | Qty: ${
          order.qty
        } | Status: ${order.status}{/}`;
        this.ordersList.addItem(orderItem);
      });
    }

    this.screen.render();
  }

  /**
   * Update the list of current positions on the dashboard.
   * @param {Array} positions - Array of current position objects.
   */
  updatePositions(positions) {
    this.positionsList.clearItems();

    if (!Array.isArray(positions) || positions.length === 0) {
      this.positionsList.addItem('No open positions.');
    } else {
      positions.forEach((pos) => {
        // Ensure necessary properties exist
        const avgEntryPrice = pos.avgEntryPrice || 0;
        const currentBid = pos.currentBid || 0;
        const currentAsk = pos.currentAsk || 0;

        // Determine color based on price comparison
        let priceColor = 'white';
        if (pos.side === 'buy') {
          priceColor = currentAsk > avgEntryPrice ? 'green' : 'red';
        } else if (pos.side === 'sell') {
          priceColor = currentBid < avgEntryPrice ? 'green' : 'red';
        }

        const positionItem = `{bold}${pos.symbol}{/} | Qty: ${
          pos.qty
        } | Avg Entry: $${avgEntryPrice.toFixed(
          2
        )} | Bid: $${currentBid.toFixed(2)} | Ask: $${currentAsk.toFixed(
          2
        )} | Side: ${pos.side.toUpperCase()}`;

        const coloredPositionItem = `{${priceColor}-fg}${positionItem}{/}`;
        this.positionsList.addItem(coloredPositionItem);
      });
    }

    this.screen.render();
  }

  /**
   * Determine the color based on order status for better visualization.
   * @param {string} status - Status of the order.
   * @returns {string} - Color name.
   */
  getOrderStatusColor(status) {
    switch (status) {
      case 'new':
        return 'cyan';
      case 'submitted':
        return 'blue';
      case 'filled':
        return 'green';
      case 'canceled':
        return 'red';
      case 'expired':
        return 'yellow';
      default:
        return 'white';
    }
  }

  /**
   * Log informational messages to the Logs box.
   * @param {string} message - The message to log.
   */
  log(message) {
    this.logBox.log(message);
    this.screen.render();
  }

  /**
   * Log error messages to the Errors box.
   * @param {string} message - The error message to log.
   */
  error(message) {
    this.errorBox.log(message);
    this.screen.render();
  }
}

module.exports = Dashboard;
