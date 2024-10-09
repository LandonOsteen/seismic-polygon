// dashboard.js

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const logger = require('./logger');
const config = require('./config');

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
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' POSITIONS ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 2,
      columnWidth: [
        8, // SYMBOL
        6, // SIDE
        6, // QTY
        10, // AVG ENTRY
        10, // BID
        10, // ASK
        9, // PROFIT
        20, // STOP PRICE
        16, // TARGETS HIT
        16, // PYRAMIDS HIT
      ],
      style: {
        header: { fg: 'cyan', bold: true },
        cell: {
          fg: 'white',
          selected: {
            fg: 'white',
            bg: 'blue',
          },
        },
      },
    });

    // Define table headers for Positions Table (All Caps)
    this.positionsTable.setData({
      headers: [
        'SYMBOL',
        'SIDE',
        'QTY',
        'AVG ENTRY',
        'BID',
        'ASK',
        'PROFIT',
        'STOP PRICE',
        'TARGETS HIT',
        'PYRAMIDS HIT',
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
      label: ' INFO ',
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
      label: ' ORDERS ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'magenta' },
      columnWidth: [8, 10, 6, 10, 10, 10, 12], // ID, SYMBOL, SIDE, TYPE, QTY, PRICE, STATUS
      style: {
        header: { fg: 'magenta', bold: true },
        cell: {
          fg: 'white',
          selected: {
            fg: 'white',
            bg: 'blue',
          },
        },
      },
    });

    // Define table headers for Orders Table (All Caps)
    this.ordersTable.setData({
      headers: ['ID', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'STATUS'],
      data: [],
    });

    // --------------------------
    // 3. Errors Box and Warnings Box (Bottom)
    // --------------------------

    // Errors Box (Left)
    this.errorBox = this.grid.set(8, 0, 4, 6, contrib.log, {
      fg: 'red',
      selectedFg: 'red',
      label: ' ERRORS ',
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
      label: ' WARNINGS ',
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
    this.screen.key(['escape', 'q', 'C-c'], () => {
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
      const profitCents = parseFloat(pos.profitCents);
      const profit = `${profitCents.toFixed(2)}¢`;

      // Update stop price display
      let stopPriceDisplay;
      if (pos.trailingStopActive) {
        stopPriceDisplay = `Trailing at $${pos.stopPrice.toFixed(2)}`;
      } else if (pos.stopPrice) {
        const stopCentsValue = parseFloat(pos.stopCents);
        const stopCentsDisplay = `${stopCentsValue >= 0 ? '' : '-'}${Math.abs(
          stopCentsValue
        )}¢`;
        stopPriceDisplay = `$${pos.stopPrice.toFixed(2)} (${stopCentsDisplay})`;
      } else {
        stopPriceDisplay = 'N/A';
      }

      // Fetch total profit targets from config
      const totalProfitTargets =
        pos.totalProfitTargets || config.orderSettings.profitTargets.length;

      const profitTargetsHit = pos.profitTargetsHit
        ? `${pos.profitTargetsHit}/${totalProfitTargets}`
        : `0/${totalProfitTargets}`;

      // Fetch total pyramid levels from config
      const totalPyramidLevels =
        pos.totalPyramidLevels || config.orderSettings.pyramidLevels.length;

      const pyramidLevelsHit = pos.pyramidLevelsHit
        ? `${pos.pyramidLevelsHit}/${totalPyramidLevels}`
        : `0/${totalPyramidLevels}`;

      return [
        pos.symbol,
        pos.side.toUpperCase(),
        pos.qty,
        `$${pos.avgEntryPrice.toFixed(2)}`,
        pos.currentBid !== undefined ? `$${pos.currentBid.toFixed(2)}` : 'N/A',
        pos.currentAsk !== undefined ? `$${pos.currentAsk.toFixed(2)}` : 'N/A',
        profit,
        stopPriceDisplay,
        profitTargetsHit,
        pyramidLevelsHit,
      ];
    });

    // Update the table data with the new positions
    this.positionsTable.setData({
      headers: [
        'SYMBOL',
        'SIDE',
        'QTY',
        'AVG ENTRY',
        'BID',
        'ASK',
        'PROFIT',
        'STOP PRICE',
        'TARGETS HIT',
        'PYRAMIDS HIT',
      ],
      data: tableData,
    });

    // Apply coloring to rows based on profit or loss
    this.applyRowColors(positions);

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
        order.side.toUpperCase(),
        order.type.toUpperCase(),
        order.qty,
        limitPrice,
        order.status.toUpperCase(),
      ];
    });

    this.ordersTable.setData({
      headers: ['ID', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'STATUS'],
      data: tableData,
    });

    this.screen.render();
  }

  /**
   * Applies color coding to the positions table rows based on profit or loss.
   * @param {Array} positions - Array of position objects.
   */
  applyRowColors(positions) {
    // Retrieve the table rows
    const rows = this.positionsTable.rows;

    positions.forEach((pos, index) => {
      const profitCents = parseFloat(pos.profitCents);

      if (profitCents > 0) {
        // Profit zone: Green text
        rows.items[index].style = { fg: 'green' };
      } else if (profitCents < 0) {
        // Loss zone: Red text
        rows.items[index].style = { fg: 'red' };
      } else {
        // Breakeven: Yellow text
        rows.items[index].style = { fg: 'yellow' };
      }
    });
  }

  /**
   * Updates trailing stop status on the dashboard.
   * @param {string} symbol - The symbol for which the trailing stop is activated.
   * @param {number} stopPrice - The current stop price.
   */
  updateTrailingStopStatus(symbol, stopPrice) {
    const message = `Trailing stop activated for ${symbol} at $${stopPrice.toFixed(
      2
    )}`;
    this.logInfo(message);
    this.screen.render();
  }
}

module.exports = Dashboard;
