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

    // Create a grid layout
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // Logs Box
    this.logBox = this.grid.set(0, 0, 4, 12, contrib.log, {
      fg: 'green',
      selectedFg: 'green',
      label: ' Logs ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        fg: 'blue',
        ch: ' ',
      },
    });

    // Errors Box
    this.errorBox = this.grid.set(4, 0, 2, 12, blessed.box, {
      label: ' Errors ',
      content: '',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        inverse: true,
      },
      style: {
        fg: 'red',
        bg: 'black',
        border: {
          fg: '#f0f0f0',
        },
      },
    });

    // Positions Table
    this.positionsTable = this.grid.set(6, 0, 3, 6, contrib.table, {
      keys: true,
      fg: 'cyan',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' Positions ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'cyan' },
      columnWidth: [10, 6, 6, 10, 10, 10, 10, 15, 20], // Adjusted for new columns
      columnSpacing: 2,
      columnWidth: [10, 6, 6, 10, 10, 10, 10, 15, 20], // Symbol, Side, Qty, Avg Entry, Bid, Ask, Profit, Stop Price, Profit Targets Hit
    });

    // Orders Table
    this.ordersTable = this.grid.set(6, 6, 3, 6, contrib.table, {
      keys: true,
      fg: 'yellow',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' Orders ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'yellow' },
      columnWidth: [8, 10, 6, 10, 10, 10, 12],
    });

    // Closed Positions Table
    this.closedPositionsTable = this.grid.set(9, 0, 3, 12, contrib.table, {
      keys: true,
      fg: 'magenta',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' Closed Positions Today ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'magenta' },
      columnWidth: [10, 6, 6, 10, 10, 12], // Symbol, Side, Qty, Entry Price, Exit Price, P&L ($)
    });

    // Summary Box
    this.summaryBox = this.grid.set(12, 0, 1, 12, blessed.box, {
      label: ' Summary ',
      content: '',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        inverse: true,
      },
      style: {
        fg: 'magenta',
        bg: 'black',
        border: {
          fg: '#f0f0f0',
        },
      },
    });

    // Define table headers
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

    this.ordersTable.setData({
      headers: ['ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Status'],
      data: [],
    });

    this.closedPositionsTable.setData({
      headers: [
        'Symbol',
        'Side',
        'Qty',
        'Entry Price',
        'Exit Price',
        'P&L ($)',
      ],
      data: [],
    });

    // Quit on Escape, q, or Control-C.
    this.screen.key(['escape', 'q', 'C-c'], function () {
      return process.exit(0);
    });

    this.screen.render();
  }

  /**
   * Determines whether a message should be displayed on the dashboard.
   * @param {string} message - The message to evaluate.
   * @returns {boolean} - True if the message should be displayed; false otherwise.
   */
  shouldDisplayMessage(message) {
    const excludedMessages = [
      'Already refreshing positions. Skipping this interval.',
      'Already polling order statuses. Skipping this interval.',
      // Add any other messages you want to exclude
    ];

    // Check if the message includes any of the excluded phrases
    return !excludedMessages.some((excludedMsg) =>
      message.includes(excludedMsg)
    );
  }

  /**
   * Logs informational messages to the Logs box if they pass the filter.
   * @param {string} message - The message to log.
   */
  log(message) {
    if (this.shouldDisplayMessage(message)) {
      const timestamp = new Date().toISOString();
      this.logBox.log(`[${timestamp}] INFO: ${message}`);
      this.screen.render();
    } else {
      // Optionally, log to file without displaying on dashboard
      logger.debug(`Filtered out log message: ${message}`);
    }
  }

  /**
   * Logs error messages to the Errors box.
   * @param {string} message - The error message to log.
   */
  error(message) {
    const timestamp = new Date().toISOString();
    this.errorBox.setContent(
      this.errorBox.getContent() + `[${timestamp}] ERROR: ${message}\n`
    );
    this.screen.render();
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
      const profitTargetsHit = pos.profitTargetsHit
        ? `${pos.profitTargetsHit}/${config.orderSettings.profitTargets.length}`
        : '0/0';

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

  /**
   * Updates the Closed Positions table with the latest data.
   * @param {Array} closedPositions - Array of closed position objects.
   */
  updateClosedPositions(closedPositions) {
    const tableData = closedPositions.map((pos) => {
      return [
        pos.symbol,
        pos.side,
        pos.qty,
        pos.entryPrice,
        pos.exitPrice,
        pos.pnl,
      ];
    });

    this.closedPositionsTable.setData({
      headers: [
        'Symbol',
        'Side',
        'Qty',
        'Entry Price',
        'Exit Price',
        'P&L ($)',
      ],
      data: tableData,
    });

    this.screen.render();
  }

  /**
   * Updates the Summary box with aggregated data.
   * @param {Object} summary - Summary data object.
   */
  updateSummary(summary) {
    let content = '';
    content += `{bold}Total Positions:{/bold} ${summary.totalPositions}\n`;
    content += `{bold}Active Positions:{/bold} ${summary.activePositions}\n`;
    content += `{bold}Closed Positions:{/bold} ${summary.closedPositions}\n`;
    content += `{bold}Total Orders:{/bold} ${summary.totalOrders}\n`;
    content += `{bold}Active Orders:{/bold} ${summary.activeOrders}\n`;
    content += `{bold}Completed Orders:{/bold} ${summary.completedOrders}\n`;
    this.summaryBox.setContent(content);
    this.screen.render();
  }
}

module.exports = Dashboard;
