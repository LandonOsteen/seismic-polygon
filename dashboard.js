const blessed = require('blessed');
const contrib = require('blessed-contrib');
const config = require('./config');
const moment = require('moment-timezone');

class Dashboard {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Exit System Dashboard',
    });

    this.grid = new contrib.grid({
      rows: 16,
      cols: 12,
      screen: this.screen,
    });

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

    this.accountSummaryBox = this.grid.set(0, 7, 4, 5, contrib.markdown, {
      label: ' ACCOUNT SUMMARY ',
      border: { type: 'line', fg: 'cyan' },
      style: { fg: 'white' },
    });

    this.infoBox = this.grid.set(4, 0, 4, 5, contrib.log, {
      fg: 'green',
      label: ' INFO ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

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

    this.errorBox = this.grid.set(8, 0, 4, 5, contrib.log, {
      fg: 'red',
      label: ' ERRORS ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    this.warningBox = this.grid.set(8, 5, 4, 7, contrib.log, {
      fg: 'yellow',
      label: ' WARNINGS ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { fg: 'blue', ch: ' ' },
    });

    this.watchlistTable = this.grid.set(12, 0, 4, 12, contrib.table, {
      keys: true,
      fg: 'white',
      label: ' WATCHLIST (Tiers & Targets) ',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 2,
      columnWidth: [10, 8, 12, 10, 10, 10],
      style: {
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
      },
    });

    this.watchlistTable.setData({
      headers: [
        'SYMBOL',
        'TIER',
        'ENTRY PRICE',
        'HOD',
        'QUOTE_SUB',
        'TRADE_SUB',
      ],
      data: [],
    });

    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    this.screen.render();
  }

  logInfo(message) {
    const timestamp = new Date().toISOString();
    this.infoBox.log(`[${timestamp}] INFO: ${message}`);
    this.screen.render();
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

  updatePositions(positions) {
    // ... same as previous code ...
    // unchanged
    // This code is long but unchanged from previous snippet
    // Just ensure no changes needed
    // ...
  }

  updateOrders(orders) {
    // ... unchanged ...
  }

  applyRowColors(positions) {
    // ... unchanged ...
  }

  updateAccountSummary(accountSummary, currentVolumeRequirement) {
    // ... unchanged ...
  }

  updateWatchlist(watchlist) {
    const data = Object.keys(watchlist).map((symbol) => {
      const w = watchlist[symbol];
      const hod = w.highOfDay;
      const tierName =
        w.tierIndex !== undefined ? `TIER ${w.tierIndex + 1}` : 'N/A';
      const entryPrice = w.plannedEntryPrice
        ? `$${w.plannedEntryPrice.toFixed(2)}`
        : 'N/A';

      const quoteSub = w.isQuoteSubscribed ? 'Y' : 'N';
      const tradeSub = w.isSubscribedToTrade ? 'Y' : 'N';

      return [
        symbol,
        tierName,
        entryPrice,
        hod !== null && hod !== undefined ? `$${hod.toFixed(2)}` : 'N/A',
        quoteSub,
        tradeSub,
      ];
    });

    this.watchlistTable.setData({
      headers: [
        'SYMBOL',
        'TIER',
        'ENTRY PRICE',
        'HOD',
        'QUOTE_SUB',
        'TRADE_SUB',
      ],
      data: data,
    });
    this.screen.render();
  }
}

module.exports = Dashboard;
