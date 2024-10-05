// dashboard.js

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const logger = require('./logger'); // Ensure logger is imported
const config = require('./config'); // Ensure config is imported

class Dashboard {
  constructor() {
    // Create a screen object.
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Exit System Dashboard',
    });

    // Create a grid layout with 12 rows and 12 columns.
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // --------------------------
    // 1. Positions Table (Top)
    // --------------------------
    this.positionsTable = this.grid.set(0, 0, 4, 12, contrib.table, {
      keys: true,
      fg: 'cyan',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' Positions ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'cyan' },
      columnWidth: [10, 6, 6, 10, 10, 10, 10, 15, 20], // Symbol, Side, Qty, Avg Entry, Bid, Ask, Profit, Stop Price, Profit Targets Hit
    });

    // Define table headers for Positions Table
    this.positionsTable.setData({
      headers: [
        'Symbol',
        'Side',
        'Qty',
        'Avg Entry',
        'Bid',
        'Ask',
        'Profit',
        'Stop Price',
        'Profit Targets Hit',
      ],
      data: [],
    });

    // --------------------------
    // 2. Info Box and Orders Table (Middle)
    // --------------------------

    // Info Box (Left)
    this.infoBox = this.grid.set(4, 0, 4, 6, contrib.log, {
      fg: 'green',
      selectedFg: 'green',
      label: ' Info ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        fg: 'blue',
        ch: ' ',
      },
    });

    // Orders Table (Right)
    this.ordersTable = this.grid.set(4, 6, 4, 6, contrib.table, {
      keys: true,
      fg: 'magenta',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' Orders ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'magenta' },
      columnWidth: [8, 10, 6, 10, 10, 10, 12], // ID, Symbol, Side, Type, Qty, Price, Status
    });

    // Define table headers for Orders Table
    this.ordersTable.setData({
      headers: ['ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Status'],
      data: [],
    });

    // --------------------------
    // 3. Errors Box and Warnings Box (Bottom)
    // --------------------------

    // Errors Box (Left)
    this.errorBox = this.grid.set(8, 0, 4, 6, contrib.log, {
      fg: 'red',
      selectedFg: 'red',
      label: ' Errors ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        fg: 'blue',
        ch: ' ',
      },
    });

    // Warnings Box (Right)
    this.warningBox = this.grid.set(8, 6, 4, 6, contrib.log, {
      fg: 'yellow',
      selectedFg: 'yellow',
      label: ' Warnings ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        fg: 'blue',
        ch: ' ',
      },
    });

    // --------------------------
    // 4. Quit Key Bindings
    // --------------------------
    // Quit on Escape, q, or Control-C.
    this.screen.key(['escape', 'q', 'C-c'], function () {
      return process.exit(0);
    });

    this.screen.render();
  }

  /**
   * Logs informational messages to the Info box.
   * @param {string} message - The message to log.
   */
  logInfo(message) {
    if (this.shouldDisplayMessage(message)) {
      const timestamp = new Date().toISOString();
      this.infoBox.log(`[${timestamp}] INFO: ${message}`);
      this.screen.render();
    } else {
      // Optionally, log to file without displaying on dashboard
      logger.debug(`Filtered out info message: ${message}`);
    }
  }

  /**
   * Logs warning messages to the Warnings box.
   * @param {string} message - The warning message to log.
   */
  logWarning(message) {
    const timestamp = new Date().toISOString();
    this.warningBox.log(`[${timestamp}] WARNING: ${message}`);
    this.screen.render();
  }

  /**
   * Logs error messages to the Errors box.
   * @param {string} message - The error message to log.
   */
  logError(message) {
    const timestamp = new Date().toISOString();
    this.errorBox.log(`[${timestamp}] ERROR: ${message}`);
    this.screen.render();
  }

  /**
   * Determines whether a message should be displayed on the Info box.
   * @param {string} message - The message to evaluate.
   * @returns {boolean} - True if the message should be displayed; false otherwise.
   */
  shouldDisplayMessage(message) {
    const excludedMessages = config.logging.excludedMessages || [
      'Already refreshing positions. Skipping this interval.',
      'Already polling order statuses. Skipping this interval.',
      // Add any other messages you want to exclude from dashboard logs
    ];

    // Check if the message includes any of the excluded phrases
    return !excludedMessages.some((excludedMsg) =>
      message.includes(excludedMsg)
    );
  }

  /**
   * Updates the Positions table with the latest positions.
   * @param {Array} positions - Array of position objects.
   */
  updatePositions(positions) {
    const tableData = positions.map((pos) => {
      // Ensure all necessary properties are present
      const profit = pos.profitCents ? `${pos.profitCents}¢` : '0¢';
      const stopPrice = pos.stopPrice ? `$${pos.stopPrice.toFixed(2)}` : 'N/A';

      // Fetch total profit targets from config
      const totalProfitTargets =
        pos.totalProfitTargets || config.orderSettings.profitTargets.length;

      const profitTargetsHit = pos.profitTargetsHit
        ? `${pos.profitTargetsHit}/${totalProfitTargets}`
        : `0/${totalProfitTargets}`;

      return [
        pos.symbol,
        pos.side,
        pos.qty,
        `$${pos.avgEntryPrice.toFixed(2)}`,
        pos.currentBid !== undefined ? `$${pos.currentBid.toFixed(2)}` : 'N/A',
        pos.currentAsk !== undefined ? `$${pos.currentAsk.toFixed(2)}` : 'N/A',
        profit,
        stopPrice,
        profitTargetsHit,
      ];
    });

    this.positionsTable.setData({
      headers: [
        'Symbol',
        'Side',
        'Qty',
        'Avg Entry',
        'Bid',
        'Ask',
        'Profit',
        'Stop Price',
        'Profit Targets Hit',
      ],
      data: tableData,
    });

    this.screen.render();
  }

  /**
   * Updates the Orders table with the latest orders.
   * @param {Array} orders - Array of order objects.
   */
  updateOrders(orders) {
    const tableData = orders.map((order) => {
      const limitPrice = order.limit_price
        ? `$${parseFloat(order.limit_price).toFixed(2)}`
        : order.trail_price
        ? `$${parseFloat(order.trail_price).toFixed(2)}`
        : 'Market';

      return [
        order.id,
        order.symbol,
        order.side,
        order.type,
        order.qty,
        limitPrice,
        order.status,
      ];
    });

    this.ordersTable.setData({
      headers: ['ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Status'],
      data: tableData,
    });

    this.screen.render();
  }
}

module.exports = Dashboard;
