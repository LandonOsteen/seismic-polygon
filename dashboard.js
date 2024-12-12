const blessed = require('blessed');
const contrib = require('blessed-contrib');
const logger = require('./logger');
const config = require('./config');

class Dashboard {
  constructor() {
    // Initialize the screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Exit System Dashboard',
    });

    // Create a grid layout for panels
    this.grid = new contrib.grid({
      rows: 16,
      cols: 12,
      screen: this.screen,
    });

    // Positions Table: Shows open positions and stats
    this.positionsTable = this.grid.set(0, 0, 4, 7, contrib.table, {
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' POSITIONS ',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 2,
      columnWidth: [8, 6, 6, 10, 10, 10, 9, 20, 16, 16, 25],
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
        'NEXT PYRAMID LEVEL',
      ],
      data: [],
    });

    // Account Summary Box: High-level account info
    this.accountSummaryBox = this.grid.set(0, 7, 4, 5, contrib.markdown, {
      label: ' ACCOUNT SUMMARY ',
      border: { type: 'line', fg: 'cyan' },
      style: { fg: 'white' },
    });

    // Info Box: General informational logs
    this.infoBox = this.grid.set(4, 0, 4, 5, contrib.log, {
      fg: 'green',
      label: ' INFO ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    // Orders Table: Shows active and recent orders
    this.ordersTable = this.grid.set(4, 5, 4, 7, contrib.table, {
      keys: true,
      fg: 'magenta',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: ' ORDERS ',
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

    // Error Box: Logs errors in red
    this.errorBox = this.grid.set(8, 0, 4, 5, contrib.log, {
      fg: 'red',
      label: ' ERRORS ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    // Warning Box: Logs warnings in yellow
    this.warningBox = this.grid.set(8, 5, 4, 7, contrib.log, {
      fg: 'yellow',
      label: ' WARNINGS ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    // Watchlist & HOD Table:
    // Reordered to show TIER and ENTRY PRICE prominently right after SYMBOL.
    this.watchlistTable = this.grid.set(12, 0, 4, 12, contrib.table, {
      keys: true,
      fg: 'white',
      label: ' WATCHLIST (Tiers & Targets) ',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 2,
      // New order: SYMBOL, TIER, ENTRY PRICE, HOD
      columnWidth: [10, 8, 12, 10],
      style: {
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
      },
    });

    this.watchlistTable.setData({
      headers: ['SYMBOL', 'TIER', 'ENTRY PRICE', 'HOD'],
      data: [],
    });

    // Keybindings to exit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    this.screen.render();
  }

  // Logging methods
  logInfo(message) {
    if (this.shouldDisplayMessage(message)) {
      const timestamp = new Date().toISOString();
      this.infoBox.log(`[${timestamp}] INFO: ${message}`);
      this.screen.render();
    }
  }

  logWarning(message) {
    const timestamp = new Date().toISOString();
    this.warningBox.log(`[${timestamp}] WARNING: ${message}`);
    this.screen.render();
  }

  logError(message) {
    const timestamp = new Date().toISOString();
    this.errorBox.log(`[${timestamp}] ERROR: ${message}`);
    this.screen.render();
  }

  shouldDisplayMessage(message) {
    const excludedMessages = config.logging.excludedMessages || [];
    return !excludedMessages.some((excludedMsg) =>
      message.includes(excludedMsg)
    );
  }

  // Update positions table data
  updatePositions(positions) {
    const tableData = positions.map((pos) => {
      const profitCents = parseFloat(pos.profitCents);
      const profit = `${profitCents.toFixed(2)}¢`;
      const stopDescription = pos.stopDescription || 'N/A';

      const profitTargetsHit = pos.profitTargetsHit
        ? `${pos.profitTargetsHit}/${pos.totalProfitTargets}`
        : `0/${pos.totalProfitTargets || 4}`;

      const pyramidLevelsHit = pos.executedPyramidLevels
        ? `${pos.executedPyramidLevels.length}/${pos.totalPyramidLevels}`
        : `0/${pos.totalPyramidLevels || 3}`;

      let nextPyramidLevel = 'N/A';
      if (
        pos.executedPyramidLevels &&
        pos.executedPyramidLevels.length < pos.totalPyramidLevels
      ) {
        const nextIndex = pos.executedPyramidLevels.length;
        const nextLevel =
          pos.pyramidLevels && pos.pyramidLevels[nextIndex]
            ? pos.pyramidLevels[nextIndex]
            : null;

        if (nextLevel) {
          nextPyramidLevel = `Add ${nextLevel.percentToAdd}% @ +${nextLevel.priceIncreaseCents}¢`;
        }
      }

      return [
        pos.symbol,
        pos.side.toUpperCase(),
        pos.qty,
        `$${pos.avgEntryPrice.toFixed(2)}`,
        pos.currentBid !== undefined ? `$${pos.currentBid.toFixed(2)}` : 'N/A',
        pos.currentAsk !== undefined ? `$${pos.currentAsk.toFixed(2)}` : 'N/A',
        profit,
        stopDescription,
        profitTargetsHit,
        pyramidLevelsHit,
        nextPyramidLevel,
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
        'NEXT PYRAMID LEVEL',
      ],
      data: tableData,
    });

    this.applyRowColors(positions);
    this.screen.render();
  }

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

  // Updates the watchlist with tier and entry price prominently displayed
  updateWatchlist(watchlist) {
    const data = Object.keys(watchlist).map((symbol) => {
      const w = watchlist[symbol];
      const hod = w.highOfDay;
      const tierName =
        w.tierIndex !== undefined ? `TIER ${w.tierIndex + 1}` : 'N/A';
      const entryPrice = w.plannedEntryPrice
        ? `$${w.plannedEntryPrice.toFixed(2)}`
        : 'N/A';

      return [
        symbol,
        tierName,
        entryPrice,
        hod !== null ? `$${hod.toFixed(2)}` : 'N/A',
      ];
    });

    this.watchlistTable.setData({
      headers: ['SYMBOL', 'TIER', 'ENTRY PRICE', 'HOD'],
      data: data,
    });
    this.screen.render();
  }
}

module.exports = Dashboard;
