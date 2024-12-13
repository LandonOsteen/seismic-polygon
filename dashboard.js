// dashboard.js

const blessed = require('blessed');

class Dashboard {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Dashboard',
    });

    // Existing Watchlist Table Setup
    this.watchlistTable = blessed.listtable({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '50%',
      align: 'center',
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      keys: true,
      vi: true,
      mouse: true,
      border: {
        type: 'line',
      },
      style: {
        header: {
          fg: 'cyan',
          bold: true,
        },
        cell: {
          fg: 'white',
          selected: {
            bg: 'blue',
          },
        },
      },
      data: [
        [
          'SYMBOL',
          'HOD',
          'Trade Subscribed',
          'Quote Subscribed',
          'Entry Trigger Price',
          'Bid Price', // New column
          'Ask Price', // New column
          'Last Trade Price', // New column
        ],
        // Existing data rows can be dynamically populated
      ],
    });

    // Existing Orders Table Setup (if any)
    this.ordersTable = blessed.listtable({
      parent: this.screen,
      top: '55%',
      left: 0,
      width: '100%',
      height: '45%',
      align: 'center',
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      keys: true,
      vi: true,
      mouse: true,
      border: {
        type: 'line',
      },
      style: {
        header: {
          fg: 'cyan',
          bold: true,
        },
        cell: {
          fg: 'white',
          selected: {
            bg: 'blue',
          },
        },
      },
      data: [
        [
          'ORDER ID',
          'SYMBOL',
          'TYPE',
          'SIDE',
          'QTY',
          'FILLED',
          'PRICE',
          'STATUS',
        ],
        // Existing data rows can be dynamically populated
      ],
    });

    // Logs Box Setup
    this.logsBox = blessed.log({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: '10%',
      label: 'Logs',
      border: {
        type: 'line',
      },
      style: {
        fg: 'green',
        border: {
          fg: '#f0f0f0',
        },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        bg: 'blue',
      },
    });

    // Key bindings to exit the dashboard
    this.screen.key(['escape', 'q', 'C-c'], function (ch, key) {
      return process.exit(0);
    });

    this.screen.render();
  }

  // Existing methods for updating watchlist, orders, etc.

  // **New Logging Methods**

  /**
   * Logs informational messages.
   * @param {string} message - The message to log.
   */
  logInfo(message) {
    this.logsBox.log(`[INFO] ${message}`);
    this.screen.render();
  }

  /**
   * Logs warning messages with yellow color.
   * @param {string} message - The warning message to log.
   */
  logWarning(message) {
    this.logsBox.log(`{yellow-fg}[WARNING]{/yellow-fg} ${message}`);
    this.screen.render();
  }

  /**
   * Logs error messages with red color.
   * @param {string} message - The error message to log.
   */
  logError(message) {
    this.logsBox.log(`{red-fg}[ERROR]{/red-fg} ${message}`);
    this.screen.render();
  }

  /**
   * Updates the Watchlist Table with Bid, Ask, and Last Trade Prices.
   * @param {Object} watchlist - The current watchlist data.
   */
  updateWatchlist(watchlist) {
    const data = Object.keys(watchlist).map((symbol) => {
      const hod = watchlist[symbol].highOfDay;
      const tradeSubscribed = watchlist[symbol].tradeSubscribed ? 'Y' : 'N';
      const quoteSubscribed = watchlist[symbol].quoteSubscribed ? 'Y' : 'N';
      const entryTriggerPrice =
        watchlist[symbol].entryTriggerPrice !== null
          ? `$${parseFloat(watchlist[symbol].entryTriggerPrice).toFixed(2)}`
          : 'N/A';
      const bidPrice =
        watchlist[symbol].bidPrice !== null
          ? `$${parseFloat(watchlist[symbol].bidPrice).toFixed(2)}`
          : 'N/A';
      const askPrice =
        watchlist[symbol].askPrice !== null
          ? `$${parseFloat(watchlist[symbol].askPrice).toFixed(2)}`
          : 'N/A';
      const lastTradePrice =
        watchlist[symbol].lastTradePrice !== null
          ? `$${parseFloat(watchlist[symbol].lastTradePrice).toFixed(2)}`
          : 'N/A';
      return [
        symbol,
        hod !== null ? `$${hod.toFixed(2)}` : 'N/A',
        tradeSubscribed,
        quoteSubscribed,
        entryTriggerPrice,
        bidPrice, // New data point
        askPrice, // New data point
        lastTradePrice, // New data point
      ];
    });

    // Prepend header row
    const tableData = [
      [
        'SYMBOL',
        'HOD',
        'Trade Subscribed',
        'Quote Subscribed',
        'Entry Trigger Price',
        'Bid Price', // New header
        'Ask Price', // New header
        'Last Trade Price', // New header
      ],
      ...data,
    ];

    this.watchlistTable.setData(tableData);
    this.screen.render();
  }

  /**
   * Updates the Orders Table.
   * @param {Array} orders - The list of current orders.
   */
  updateOrders(orders) {
    const data = orders.map((order) => [
      order.id,
      order.symbol,
      order.type,
      order.side,
      order.qty,
      order.filled_qty || '0',
      order.limit_price || 'Market',
      order.status,
    ]);

    // Prepend header row
    const tableData = [
      [
        'ORDER ID',
        'SYMBOL',
        'TYPE',
        'SIDE',
        'QTY',
        'FILLED',
        'PRICE',
        'STATUS',
      ],
      ...data,
    ];

    this.ordersTable.setData(tableData);
    this.screen.render();
  }

  /**
   * Updates the Positions Table.
   * @param {Array} positions - The list of current positions.
   */
  updatePositions(positions) {
    const data = positions.map((pos) => [
      pos.symbol,
      pos.qty,
      `$${parseFloat(pos.avgEntryPrice).toFixed(2)}`,
      `$${parseFloat(pos.currentPrice).toFixed(2)}`,
      `${pos.profitCents}¢`,
      pos.stopDescription,
      pos.isActive ? 'Active' : 'Closed',
    ]);

    // Prepend header row
    const tableData = [
      [
        'SYMBOL',
        'QTY',
        'AVG ENTRY',
        'CURRENT PRICE',
        'PROFIT',
        'STOP',
        'STATUS',
      ],
      ...data,
    ];

    this.positionsTable.setData(tableData);
    this.screen.render();
  }

  /**
   * Logs messages to the Logs Box.
   * @param {string} message - The message to log.
   */
  log(message) {
    this.logsBox.log(message);
    this.screen.render();
  }
}

module.exports = Dashboard;
