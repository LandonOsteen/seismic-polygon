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
      rows: 16,
      cols: 12,
      screen: this.screen,
    });

    // Now we have one additional column: PT_HIT (Profit Targets Hit)
    // Adjust column widths accordingly
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
      // Updated column widths to accommodate PT_HIT column
      columnWidth: [8, 6, 6, 10, 10, 10, 9, 7, 20],
      style: {
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
      },
    });

    // Updated headers to include PT_HIT after PROFIT and before STOP PRICE
    this.positionsTable.setData({
      headers: [
        'SYMBOL',
        'SIDE',
        'QTY',
        'AVG ENTRY',
        'BID',
        'ASK',
        'PROFIT',
        'PT_HIT',
        'STOP PRICE',
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
      selectedFg: 'green',
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
      headers: ['SYMBOL', 'HOD'],
      data: [],
    });

    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    this.screen.render();
  }

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

  updatePositions(positions) {
    const tableData = positions.map((pos) => {
      const profitCents = parseFloat(pos.profitCents);
      const profit = `${profitCents.toFixed(2)}¢`;
      const stopDescription = pos.stopDescription || 'N/A';
      const targetsHit =
        pos.profitTargetsHit != null ? pos.profitTargetsHit.toString() : '0';

      return [
        pos.symbol,
        pos.side.toUpperCase(),
        pos.qty,
        `$${pos.avgEntryPrice.toFixed(2)}`,
        pos.currentBid !== undefined ? `$${pos.currentBid.toFixed(2)}` : 'N/A',
        pos.currentAsk !== undefined ? `$${pos.currentAsk.toFixed(2)}` : 'N/A',
        profit,
        targetsHit,
        stopDescription,
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
        'PT_HIT',
        'STOP PRICE',
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

  updateWatchlist(watchlist) {
    const data = Object.keys(watchlist).map((symbol) => {
      const hod = watchlist[symbol].highOfDay;
      return [symbol, hod !== null ? `$${hod.toFixed(2)}` : 'N/A'];
    });

    this.watchlistTable.setData({
      headers: ['SYMBOL', 'HOD'],
      data: data,
    });
    this.screen.render();
  }
}

module.exports = Dashboard;
