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

    // Positions Table
    this.positionsTable = this.grid.set(0, 0, 4, 6, contrib.table, {
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

    // Account Summary Box
    this.accountSummaryBox = this.grid.set(0, 6, 4, 3, contrib.markdown, {
      label: ' ACCOUNT SUMMARY ',
      border: { type: 'line', fg: 'cyan' },
      style: {
        fg: 'white',
      },
    });

    // Watchlist Table
    this.watchlistTable = this.grid.set(0, 9, 4, 3, contrib.table, {
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: false,
      label: ' WATCHLIST ',
      width: '100%',
      height: '100%',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 1,
      columnWidth: [
        8, // SYMBOL
        5, // SIDE
        10, // HOD
        10, // LOD
        10, // ATTEMPT_HOD
        10, // ATTEMPT_LOD
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

    this.watchlistTable.setData({
      headers: ['SYM', 'SIDE', 'HOD', 'LOD', 'A-HOD', 'A-LOD'],
      data: [],
    });

    // Info Box
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

    // Orders Table
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
      columnWidth: [8, 10, 6, 10, 10, 10, 12],
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

    this.ordersTable.setData({
      headers: ['ID', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'STATUS'],
      data: [],
    });

    // Errors Box
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

    // Warnings Box
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

    // Quit key bindings
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
    const excludedMessages = config.logging.excludedMessages || [
      'Already refreshing positions.',
      'Already polling order statuses.',
    ];
    return !excludedMessages.some((excludedMsg) =>
      message.includes(excludedMsg)
    );
  }

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

      const totalProfitTargets =
        pos.totalProfitTargets || config.orderSettings.profitTargets.length;
      const profitTargetsHit = pos.profitTargetsHit
        ? `${pos.profitTargetsHit}/${totalProfitTargets}`
        : `0/${totalProfitTargets}`;

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

  updateWatchlist(watchlistData) {
    const tableData = watchlistData.map((item) => [
      item.symbol,
      item.side.toUpperCase(),
      item.HOD !== null ? item.HOD.toFixed(2) : 'N/A',
      item.LOD !== null ? item.LOD.toFixed(2) : 'N/A',
      item.attemptHOD !== null ? item.attemptHOD.toFixed(2) : 'N/A',
      item.attemptLOD !== null ? item.attemptLOD.toFixed(2) : 'N/A',
    ]);

    this.watchlistTable.setData({
      headers: ['SYM', 'SIDE', 'HOD', 'LOD', 'A-HOD', 'A-LOD'],
      data: tableData,
    });

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

- **Equity**: $${accountSummary.equity}
- **Cash**: $${accountSummary.cash}
- **Day's P&L**: $${accountSummary.pnl} (${accountSummary.pnl_percentage}%)
- **Open P&L**: $${accountSummary.unrealized_pl}
`;
    this.accountSummaryBox.setMarkdown(content);
    this.screen.render();
  }
}

module.exports = Dashboard;
