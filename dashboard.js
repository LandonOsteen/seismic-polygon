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
      columnWidth: [10, 6, 6, 10, 10, 10, 20, 15, 10], // 9 entries
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
      columnWidth: [8, 10, 6, 10, 10, 10, 12], // 7 entries
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
      columnWidth: [10, 6, 6, 10, 10, 12], // 6 entries
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
        'Status',
        'Stop Tracking',
        'Profit',
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
    const excludedMessages = config.logging.excludedMessages || [];

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
    if (!Array.isArray(positions)) {
      logger.error('Positions data is not an array.');
      this.error('Positions data is not an array.');
      return;
    }

    const tableData = positions.map((pos) => {
      // Validate each position object
      if (
        !pos.symbol ||
        typeof pos.side !== 'string' ||
        typeof pos.qty !== 'number' ||
        typeof pos.avgEntryPrice !== 'number' ||
        (pos.currentBid !== undefined && typeof pos.currentBid !== 'number') ||
        (pos.currentAsk !== undefined && typeof pos.currentAsk !== 'number') ||
        typeof pos.profitTracking !== 'number' ||
        !Array.isArray(pos.profitTargets)
      ) {
        logger.warn(`Invalid position data for symbol: ${pos.symbol}`);
        this.log(`Invalid position data for symbol: ${pos.symbol}`);
        return [
          pos.symbol || 'N/A',
          pos.side || 'N/A',
          pos.qty !== undefined ? pos.qty.toString() : '0',
          pos.avgEntryPrice !== undefined
            ? `$${pos.avgEntryPrice.toFixed(2)}`
            : '$0.00',
          pos.currentBid !== undefined
            ? `$${pos.currentBid.toFixed(2)}`
            : 'N/A',
          pos.currentAsk !== undefined
            ? `$${pos.currentAsk.toFixed(2)}`
            : 'N/A',
          'Data Error',
          pos.stopTracking || 'N/A',
          `${pos.profitTracking.toFixed(1)}¢`,
        ];
      }

      let status;

      if (pos.profitTargetsHit === 0) {
        status = 'No target hit';
      } else {
        // Determine if it's the final target
        const totalTargets = pos.profitTargets.length;
        if (pos.profitTargetsHit >= totalTargets) {
          status = 'Final target hit';
        } else {
          status = `${pos.profitTargetsHit}${this.getOrdinalSuffix(
            pos.profitTargetsHit
          )} target hit`;
        }
      }

      return [
        pos.symbol,
        pos.side,
        pos.qty.toString(),
        `$${pos.avgEntryPrice.toFixed(2)}`,
        pos.currentBid !== undefined ? `$${pos.currentBid.toFixed(2)}` : 'N/A',
        pos.currentAsk !== undefined ? `$${pos.currentAsk.toFixed(2)}` : 'N/A',
        status, // Updated Status
        pos.stopTracking, // 'Initial' or 'Breakeven'
        `${pos.profitTracking.toFixed(1)}¢`, // Profit in cents
      ];
    });

    // Validate table data before setting
    try {
      this.validateTableData(
        [
          'Symbol',
          'Side',
          'Qty',
          'Avg Entry',
          'Bid',
          'Ask',
          'Status',
          'Stop Tracking',
          'Profit',
        ],
        tableData
      );
      this.positionsTable.setData({
        headers: [
          'Symbol',
          'Side',
          'Qty',
          'Avg Entry',
          'Bid',
          'Ask',
          'Status',
          'Stop Tracking',
          'Profit',
        ],
        data: tableData,
      });
    } catch (error) {
      logger.error(`Positions Table Data Validation Error: ${error.message}`);
      this.error(`Positions Table Data Validation Error: ${error.message}`);
    }

    this.screen.render();
  }

  /**
   * Updates the Orders table with the latest orders.
   * @param {Array} orders - Array of order objects.
   */
  updateOrders(orders) {
    if (!Array.isArray(orders)) {
      logger.error('Orders data is not an array.');
      this.error('Orders data is not an array.');
      return;
    }

    const tableData = orders.map((order) => {
      // Validate each order object
      if (
        !order.id ||
        !order.symbol ||
        typeof order.side !== 'string' ||
        typeof order.type !== 'string' ||
        typeof order.qty !== 'number' ||
        (order.limit_price !== undefined &&
          typeof order.limit_price !== 'number') ||
        typeof order.status !== 'string'
      ) {
        logger.warn(`Invalid order data for order ID: ${order.id}`);
        this.log(`Invalid order data for order ID: ${order.id}`);
        return [
          order.id ? order.id.substring(0, 6) + '...' : 'N/A',
          order.symbol || 'N/A',
          order.side || 'N/A',
          order.type || 'N/A',
          order.qty !== undefined ? order.qty.toString() : '0',
          order.limit_price !== undefined
            ? `$${order.limit_price.toFixed(2)}`
            : order.trail_price !== undefined
            ? `$${order.trail_price.toFixed(2)}`
            : 'Market',
          order.status || 'N/A',
        ];
      }

      return [
        order.id.substring(0, 6) + '...', // Shorten ID for display
        order.symbol,
        order.side,
        order.type,
        order.qty,
        order.limit_price !== undefined
          ? `$${order.limit_price.toFixed(2)}`
          : order.trail_price !== undefined
          ? `$${order.trail_price.toFixed(2)}`
          : 'Market',
        order.status,
      ];
    });

    // Validate table data before setting
    try {
      this.validateTableData(
        ['ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Status'],
        tableData
      );
      this.ordersTable.setData({
        headers: ['ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Status'],
        data: tableData,
      });
    } catch (error) {
      logger.error(`Orders Table Data Validation Error: ${error.message}`);
      this.error(`Orders Table Data Validation Error: ${error.message}`);
    }

    this.screen.render();
  }

  /**
   * Updates the Closed Positions table with the latest data.
   * @param {Array} closedPositions - Array of closed position objects.
   */
  updateClosedPositions(closedPositions) {
    if (!Array.isArray(closedPositions)) {
      logger.error('Closed Positions data is not an array.');
      this.error('Closed Positions data is not an array.');
      return;
    }

    const tableData = closedPositions.map((pos) => {
      // Validate each closed position object
      if (
        !pos.symbol ||
        typeof pos.side !== 'string' ||
        typeof pos.qty !== 'number' ||
        typeof pos.entryPrice !== 'string' ||
        typeof pos.exitPrice !== 'string' ||
        typeof pos.pnl !== 'string'
      ) {
        logger.warn(`Invalid closed position data for symbol: ${pos.symbol}`);
        this.log(`Invalid closed position data for symbol: ${pos.symbol}`);
        return [
          pos.symbol || 'N/A',
          pos.side || 'N/A',
          pos.qty !== undefined ? pos.qty.toString() : '0',
          pos.entryPrice ? pos.entryPrice : 'N/A',
          pos.exitPrice ? pos.exitPrice : 'N/A',
          pos.pnl ? pos.pnl : 'N/A',
        ];
      }

      return [
        pos.symbol,
        pos.side,
        pos.qty,
        pos.entryPrice,
        pos.exitPrice,
        pos.pnl,
      ];
    });

    // Validate table data before setting
    try {
      this.validateTableData(
        ['Symbol', 'Side', 'Qty', 'Entry Price', 'Exit Price', 'P&L ($)'],
        tableData
      );
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
    } catch (error) {
      logger.error(
        `Closed Positions Table Data Validation Error: ${error.message}`
      );
      this.error(
        `Closed Positions Table Data Validation Error: ${error.message}`
      );
    }

    this.screen.render();
  }

  /**
   * Updates the Summary box with aggregated data.
   * @param {Object} summary - Summary data object.
   */
  updateSummary(summary) {
    if (!summary) {
      logger.error('Summary data is undefined or null.');
      this.error('Summary data is undefined or null.');
      return;
    }

    const requiredFields = [
      'totalPositions',
      'activePositions',
      'closedPositions',
      'totalOrders',
      'activeOrders',
      'completedOrders',
    ];
    const missingFields = requiredFields.filter((field) => !(field in summary));

    if (missingFields.length > 0) {
      logger.error(
        `Missing fields in summary data: ${missingFields.join(', ')}`
      );
      this.error(`Missing fields in summary data: ${missingFields.join(', ')}`);
      return;
    }

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

  /**
   * Validates table data to ensure consistency.
   * @param {Array} headers - Array of header strings.
   * @param {Array} data - Array of row arrays.
   * @throws Will throw an error if validation fails.
   */
  validateTableData(headers, data) {
    if (!Array.isArray(headers)) {
      throw new Error('Headers should be an array.');
    }
    if (!Array.isArray(data)) {
      throw new Error('Data should be an array of arrays.');
    }
    data.forEach((row, index) => {
      if (!Array.isArray(row)) {
        throw new Error(`Row ${index + 1} is not an array.`);
      }
      if (row.length !== headers.length) {
        throw new Error(
          `Row ${index + 1} length (${
            row.length
          }) does not match headers length (${headers.length}).`
        );
      }
    });
    return true;
  }

  /**
   * Returns the ordinal suffix for a given number.
   * @param {number} n - The number to get the ordinal suffix for.
   * @returns {string} - The ordinal suffix (e.g., 'st', 'nd', 'rd', 'th').
   */
  getOrdinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'],
      v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }

  /**
   * Calculates the initial stop price based on the position side.
   * @param {number} avgEntryPrice - The average entry price of the position.
   * @param {string} side - The side of the position ('buy' or 'sell').
   * @returns {number} - The calculated stop price.
   */
  calculateInitialStopPrice(avgEntryPrice, side) {
    const stopLossCents = config.orderSettings.stopLossCents;
    if (side === 'buy') {
      // Long position: stop price is below entry price
      return avgEntryPrice - stopLossCents / 100;
    } else if (side === 'sell') {
      // Short position: stop price is above entry price
      return avgEntryPrice + stopLossCents / 100;
    }
    // Default to breakeven if side is unknown
    return avgEntryPrice;
  }
}

module.exports = Dashboard;
