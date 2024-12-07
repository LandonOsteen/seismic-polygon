// Dashboard.js
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const logger = require('./logger');
const config = require('./config');

class Dashboard {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Exit System Dashboard',
    });

    // Updated grid to have 16 rows to accommodate the Watchlist
    this.grid = new contrib.grid({
      rows: 16,
      cols: 12,
      screen: this.screen,
    });

    // Positions Table
    this.positionsTable = this.grid.set(0, 0, 4, 7, contrib.table, {
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
      columnWidth: [8, 6, 6, 10, 10, 10, 9, 20, 16, 16],
      style: {
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
      },
    });

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

    // Account Summary
    this.accountSummaryBox = this.grid.set(0, 7, 4, 5, contrib.markdown, {
      label: ' ACCOUNT SUMMARY ',
      border: { type: 'line', fg: 'cyan' },
      style: { fg: 'white' },
    });

    // Info Box
    this.infoBox = this.grid.set(4, 0, 4, 5, contrib.log, {
      fg: 'green',
      selectedFg: 'green',
      label: ' INFO ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    // Orders Table
    this.ordersTable = this.grid.set(4, 5, 4, 7, contrib.table, {
      keys: true,
      fg: 'magenta',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' ORDERS ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'magenta' },
      columnWidth: [8, 10, 6, 10, 10, 10, 12],
      style: {
        header: { fg: 'magenta', bold: true },
        cell: { fg: 'white' },
      },
    });

    this.ordersTable.setData({
      headers: ['ID', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'STATUS'],
      data: [],
    });

    // Errors Box
    this.errorBox = this.grid.set(8, 0, 4, 5, contrib.log, {
      fg: 'red',
      selectedFg: 'red',
      label: ' ERRORS ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    // Warnings Box
    this.warningBox = this.grid.set(8, 5, 4, 7, contrib.log, {
      fg: 'yellow',
      selectedFg: 'yellow',
      label: ' WARNINGS ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    // Watchlist Table
    this.watchlistTable = this.grid.set(12, 0, 4, 12, contrib.table, {
      keys: true,
      fg: 'white',
      label: ' WATCHLIST & HOD ',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 2,
      columnWidth: [10, 10],
      style: {
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
      },
    });

    this.watchlistTable.setData({
      headers: ['SYMBOL', 'HIGH OF DAY'],
      data: [],
    });

    // Exit Keys
    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    this.screen.render();
  }

  /**
   * Logs an informational message to the Info Box.
   * Filters out excluded messages based on config.
   * @param {string} message - The message to log.
   */
  logInfo(message) {
    if (this.shouldDisplayMessage(message)) {
      const timestamp = new Date().toISOString();
      this.infoBox.log(`[${timestamp}] INFO: ${message}`);
      this.screen.render();
    }
  }

  /**
   * Logs a warning message to the Warnings Box.
   * @param {string} message - The warning message.
   */
  logWarning(message) {
    const timestamp = new Date().toISOString();
    this.warningBox.log(`[${timestamp}] WARNING: ${message}`);
    this.screen.render();
  }

  /**
   * Logs an error message to the Errors Box.
   * @param {string} message - The error message.
   */
  logError(message) {
    const timestamp = new Date().toISOString();
    this.errorBox.log(`[${timestamp}] ERROR: ${message}`);
    this.screen.render();
  }

  /**
   * Determines whether a message should be displayed based on exclusions.
   * @param {string} message - The message to evaluate.
   * @returns {boolean} - True if the message should be displayed.
   */
  shouldDisplayMessage(message) {
    const excludedMessages = config.logging.excludedMessages || [];
    return !excludedMessages.some((excludedMsg) =>
      message.includes(excludedMsg)
    );
  }

  /**
   * Updates the Positions Table with the latest positions data.
   * @param {Array} positions - Array of position objects.
   */
  updatePositions(positions) {
    const tableData = positions.map((pos) => {
      const profitCents = parseFloat(pos.profitCents);
      const profit = `${profitCents.toFixed(2)}¢`;

      const stopCentsValue = parseFloat(pos.stopCents);
      const stopCentsDisplay = `${stopCentsValue >= 0 ? '' : '-'}${Math.abs(
        stopCentsValue
      )}¢`;

      const stopPrice = pos.stopPrice
        ? `$${pos.stopPrice.toFixed(2)} (${stopCentsDisplay})`
        : 'N/A';

      const profitTargetsHit = pos.profitTargetsHit
        ? `${pos.profitTargetsHit}/${pos.totalProfitTargets}`
        : `0/${pos.totalProfitTargets}`;

      const pyramidLevelsHit = pos.pyramidLevelsHit
        ? `${pos.pyramidLevelsHit}/${pos.totalPyramidLevels}`
        : `0/${pos.totalPyramidLevels}`;

      return [
        pos.symbol,
        pos.side.toUpperCase(),
        pos.qty,
        `$${pos.avgEntryPrice.toFixed(2)}`,
        pos.currentBid !== undefined ? `$${pos.currentBid.toFixed(2)}` : 'N/A',
        pos.currentAsk !== undefined ? `$${pos.currentAsk.toFixed(2)}` : 'N/A',
        profit,
        stopPrice,
        profitTargetsHit,
        pyramidLevelsHit,
      ];
    });

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

    this.applyRowColors(positions);
    this.screen.render();
  }

  /**
   * Updates the Orders Table with the latest orders data.
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
   * Applies color coding to the Positions Table rows based on profit.
   * Green for profit, Red for loss, Yellow for neutral.
   * @param {Array} positions - Array of position objects.
   */
  applyRowColors(positions) {
    const rows = this.positionsTable.rows;
    positions.forEach((pos, index) => {
      const profitCents = parseFloat(pos.profitCents);
      if (profitCents > 0) {
        rows.items[index].style = { fg: 'green' };
      } else if (profitCents < 0) {
        rows.items[index].style = { fg: 'red' };
      } else {
        rows.items[index].style = { fg: 'yellow' };
      }
    });
  }

  /**
   * Updates the Account Summary Box with the latest account data.
   * @param {object} accountSummary - The account summary object.
   */
  updateAccountSummary(accountSummary) {
    const content = `### Account Summary

- **Equity**: $${parseFloat(accountSummary.equity).toFixed(2)}
- **Cash**: $${parseFloat(accountSummary.cash).toFixed(2)}
- **Day's P&L**: $${parseFloat(accountSummary.pnl).toFixed(2)} (${parseFloat(
      accountSummary.pnl_percentage
    ).toFixed(2)}%)
- **Open P&L**: $${parseFloat(accountSummary.unrealized_pl).toFixed(2)}
`;
    this.accountSummaryBox.setMarkdown(content);
    this.screen.render();
  }

  /**
   * Updates the Watchlist Table with the latest watchlist data.
   * @param {object} watchlist - The watchlist object.
   */
  updateWatchlist(watchlist) {
    const data = Object.keys(watchlist).map((symbol) => {
      const hod = watchlist[symbol].highOfDay;
      return [symbol, hod !== null ? `$${hod.toFixed(2)}` : 'N/A'];
    });

    this.watchlistTable.setData({
      headers: ['SYMBOL', 'HIGH OF DAY'],
      data: data,
    });
    this.screen.render();
  }
}

module.exports = Dashboard;
