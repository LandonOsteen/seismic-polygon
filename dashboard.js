// dashboard.js

const blessed = require('blessed');
const config = require('./config');

class Dashboard {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
    });

    this.screen.title = 'Trading Exit System';

    // Positions List
    this.positionsList = blessed.list({
      top: 0,
      left: 0,
      width: '70%',
      height: '70%',
      label: 'Positions',
      border: {
        type: 'line',
      },
      style: {
        selected: {
          bg: 'blue',
        },
      },
      keys: true,
      vi: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'grey',
        },
        style: {
          bg: 'blue',
        },
      },
    });

    // P&L Box
    this.pnlBox = blessed.box({
      top: 0,
      left: '70%',
      width: '30%',
      height: '70%',
      label: 'P&L',
      border: {
        type: 'line',
      },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    });

    // Logs Box
    this.logBox = blessed.log({
      top: '70%',
      left: 0,
      width: '70%',
      height: '30%',
      label: 'Logs',
      border: {
        type: 'line',
      },
      scrollbar: {
        ch: ' ',
      },
      alwaysScroll: true,
      scrollable: true,
      keys: true,
      vi: true,
    });

    // Error Box
    this.errorBox = blessed.log({
      top: '70%',
      left: '70%',
      width: '30%',
      height: '30%',
      label: 'Errors',
      border: {
        type: 'line',
      },
      style: {
        fg: 'red',
      },
      scrollbar: {
        ch: ' ',
      },
      alwaysScroll: true,
      scrollable: true,
      keys: true,
      vi: true,
    });

    this.screen.append(this.positionsList);
    this.screen.append(this.pnlBox);
    this.screen.append(this.logBox);
    this.screen.append(this.errorBox);

    // Exit the program
    this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

    this.screen.render();
  }

  updatePositions(positions) {
    this.positionsList.clearItems();
    this.pnlBox.setContent(''); // Clear P&L box

    positions.forEach((pos) => {
      const nextTarget = config.profitTargets[pos.profitTargetsHit];
      const profitInfo = nextTarget
        ? `Next Target: +${nextTarget.targetCents}¢ (${(
            nextTarget.proportion * 100
          ).toFixed(0)}%)`
        : 'All targets hit';

      const positionItem = `${pos.symbol} | Qty: ${
        pos.qty
      } | Avg Entry: $${pos.avgEntryPrice.toFixed(2)} | ${profitInfo}`;
      this.positionsList.addItem(positionItem);

      // Calculate P&L
      const unrealizedPnL = pos.hasBreakevenStop
        ? (
            (pos.currentPrice - pos.avgEntryPrice) *
            pos.qty *
            (pos.side === 'buy' ? 1 : -1)
          ).toFixed(2)
        : 'N/A';
      const pnlItem = `${pos.symbol}: ${
        unrealizedPnL !== 'N/A' ? `$${unrealizedPnL}` : 'N/A'
      }`;

      this.pnlBox.setContent(this.pnlBox.getContent() + pnlItem + '\n');
    });

    this.screen.render();
  }

  log(message) {
    this.logBox.log(message);
    this.screen.render();
  }

  error(message) {
    this.errorBox.log(message);
    this.screen.render();
  }
}

module.exports = Dashboard;
