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

    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // Positions (0,0,4,7)
    this.positionsTable = this.grid.set(0, 0, 4, 7, contrib.table, {
      keys: true,
      fg: 'white',
      label: ' POSITIONS ',
      border: { type: 'line', fg: 'cyan' },
      columnWidth: [8, 6, 6, 10, 10, 20, 20],
    });
    this.positionsTable.setData({
      headers: [
        'SYMBOL',
        'SIDE',
        'QTY',
        'AVG ENTRY',
        'PROFIT',
        'STOP PRICE',
        'TRAIL STOP',
      ],
      data: [],
    });

    // Account Summary (0,7,2,5)
    this.accountSummaryBox = this.grid.set(0, 7, 2, 5, contrib.markdown, {
      label: ' ACCOUNT SUMMARY ',
      border: { type: 'line', fg: 'cyan' },
    });

    // Watchlist (2,7,2,5)
    this.watchlistTable = this.grid.set(2, 7, 2, 5, contrib.table, {
      keys: true,
      fg: 'white',
      label: ' WATCHLIST ',
      border: { type: 'line', fg: 'cyan' },
      columnWidth: [10, 10, 14, 10],
    });
    this.watchlistTable.setData({
      headers: ['SYMBOL', 'HOD', 'CANDIDATE_HOD', 'TIER'],
      data: [],
    });

    // Info (4,0,4,6)
    this.infoBox = this.grid.set(4, 0, 4, 6, contrib.log, {
      fg: 'green',
      label: ' INFO ',
      tags: true,
      keys: true,
      scrollbar: { fg: 'blue' },
    });

    // Orders (4,6,4,6)
    this.ordersTable = this.grid.set(4, 6, 4, 6, contrib.table, {
      keys: true,
      fg: 'magenta',
      label: ' ORDERS ',
      border: { type: 'line', fg: 'magenta' },
      columnWidth: [8, 10, 6, 10, 10, 10, 12],
    });
    this.ordersTable.setData({
      headers: ['ID', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'STATUS'],
      data: [],
    });

    // Errors (8,0,4,6)
    this.errorBox = this.grid.set(8, 0, 4, 6, contrib.log, {
      fg: 'red',
      label: ' ERRORS ',
      tags: true,
      keys: true,
      scrollbar: { fg: 'blue' },
    });

    // Warnings (8,6,4,6)
    this.warningBox = this.grid.set(8, 6, 4, 6, contrib.log, {
      fg: 'yellow',
      label: ' WARNINGS ',
      tags: true,
      keys: true,
      scrollbar: { fg: 'blue' },
    });

    this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
    this.screen.render();
  }

  logInfo(message) {
    if (this.shouldDisplayMessage(message)) {
      const timestamp = new Date().toISOString();
      this.infoBox.log(`[${timestamp}] INFO: ${message}`);
      this.screen.render();
    } else {
      logger.debug(`Filtered out info message: ${message}`);
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
    return !excludedMessages.some((ex) => message.includes(ex));
  }

  updatePositions(positions) {
    const data = positions.map((pos) => {
      const profitCents = parseFloat(pos.profitCents);
      const profit = `${profitCents.toFixed(2)}¢`;

      let stopPrice = 'N/A';
      if (pos.stopPrice !== null && pos.stopPrice !== undefined) {
        stopPrice = `$${pos.stopPrice.toFixed(2)} (dynamic)`;
      }

      let trailStop = 'N/A';
      if (pos.trailingStopActive && pos.trailingStopPrice) {
        trailStop = `$${pos.trailingStopPrice.toFixed(2)} (trail)`;
      }

      return [
        pos.symbol,
        pos.side.toUpperCase(),
        pos.qty,
        `$${pos.avgEntryPrice.toFixed(2)}`,
        profit,
        stopPrice,
        trailStop,
      ];
    });

    this.positionsTable.setData({
      headers: [
        'SYMBOL',
        'SIDE',
        'QTY',
        'AVG ENTRY',
        'PROFIT',
        'STOP PRICE',
        'TRAIL STOP',
      ],
      data: data,
    });

    this.applyRowColors(positions);
    this.screen.render();
  }

  applyRowColors(positions) {
    const rows = this.positionsTable.rows;
    positions.forEach((pos, i) => {
      const profitCents = parseFloat(pos.profitCents);
      if (profitCents > 0) {
        rows.items[i].style = { fg: 'green' };
      } else if (profitCents < 0) {
        rows.items[i].style = { fg: 'red' };
      } else {
        rows.items[i].style = { fg: 'yellow' };
      }
    });
  }

  updateOrders(orders) {
    const data = orders.map((o) => {
      const limitPrice = o.limit_price
        ? `$${parseFloat(o.limit_price).toFixed(2)}`
        : o.trail_price
        ? `$${parseFloat(o.trail_price).toFixed(2)}`
        : 'Market';
      return [
        o.id,
        o.symbol,
        o.side.toUpperCase(),
        o.type.toUpperCase(),
        o.qty,
        limitPrice,
        o.status.toUpperCase(),
      ];
    });

    this.ordersTable.setData({
      headers: ['ID', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'STATUS'],
      data: data,
    });
    this.screen.render();
  }

  updateWatchlist(watchlist) {
    const data = Object.keys(watchlist).map((sym) => {
      const w = watchlist[sym];
      return [
        sym,
        w.highOfDay !== null ? w.highOfDay.toFixed(2) : 'N/A',
        w.candidateHOD !== null ? w.candidateHOD.toFixed(2) : 'N/A',
        w.tier ? w.tier.name : 'N/A',
      ];
    });

    this.watchlistTable.setData({
      headers: ['SYMBOL', 'HOD', 'CANDIDATE_HOD', 'TIER'],
      data: data,
    });
    this.screen.render();
  }

  updateAccountSummary(account) {
    const content = `### Account Summary

- **Equity**: $${account.equity}
- **Cash**: $${account.cash}
- **Day's P&L**: $${account.pnl} (${account.pnl_percentage}%)
- **Open P&L**: $${account.unrealized_pl}
`;
    this.accountSummaryBox.setMarkdown(content);
    this.screen.render();
  }
}

module.exports = Dashboard;
