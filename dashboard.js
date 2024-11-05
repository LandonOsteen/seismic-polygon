// dashboard.js

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const logger = require('./logger');
const config = require('./config');

class Dashboard {
  constructor() {
    this.orderManager = null;
    this.polygon = null;

    // Create a screen object with mouse support enabled.
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Exit System Dashboard',
      // Mouse support is optional since we're focusing on keyboard navigation
      // mouse: true,
      // keys: true, // Enabled by default
    });

    // Create a grid layout with 12 rows and 12 columns.
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // --------------------------
    // Symbol Entry Boxes (Top)
    // --------------------------
    this.symbolBoxes = [];

    for (let i = 0; i < 3; i++) {
      const col = i * 4; // Each box is 4 columns wide
      const symbolBox = this.grid.set(0, col, 3, 4, blessed.box, {
        label: ` SYMBOL ${i + 1} `,
        border: { type: 'line' },
        style: {
          fg: 'white',
          border: { fg: 'cyan' },
        },
      });

      // Add input field for symbol
      const symbolInput = blessed.textbox({
        parent: symbolBox,
        top: 0,
        left: 'center',
        width: '80%',
        height: 1,
        inputOnFocus: true,
        name: `symbolInput${i}`,
        style: {
          fg: 'white',
          bg: 'black',
          focus: {
            bg: 'blue',
          },
        },
      });

      // Add text elements for bid and ask prices
      const bidText = blessed.text({
        parent: symbolBox,
        top: 1,
        left: 0,
        content: 'Bid: N/A',
        style: {
          fg: 'green',
        },
      });

      const askText = blessed.text({
        parent: symbolBox,
        top: 2,
        left: 0,
        content: 'Ask: N/A',
        style: {
          fg: 'red',
        },
      });

      // Store references
      this.symbolBoxes.push({
        box: symbolBox,
        input: symbolInput,
        bidText: bidText,
        askText: askText,
        symbol: '',
        selected: false,
        currentBid: null,
        currentAsk: null,
      });

      // Handle symbol input submission
      symbolInput.on('submit', (value) => {
        const symbol = value.toUpperCase().trim();
        if (!symbol) {
          this.logWarning(`No symbol entered in box ${i + 1}.`);
          return;
        }
        this.logInfo(`Symbol entered in box ${i + 1}: ${symbol}`);

        // Update the symbol in the symbol box
        this.symbolBoxes[i].symbol = symbol;

        // Display the symbol in the box label
        this.symbolBoxes[i].box.setLabel(` SYMBOL ${i + 1} - ${symbol} `);

        // Subscribe to symbol in Polygon
        this.onSymbolEntered(i, symbol);

        symbolInput.clearValue();

        // Keep the box selected
        this.selectSymbolBox(i);

        this.screen.render();
      });

      // Prevent Tab from inserting spaces in the input
      symbolInput.on('keypress', (ch, key) => {
        if (key.name === 'tab' || (key.shift && key.name === 'tab')) {
          // Prevent default Tab behavior
          key.preventDefault = true;
          key.stopPropagation = true;
        }
      });

      // Handle box focus to select it
      symbolBox.on('focus', () => {
        this.selectSymbolBox(i);
        this.screen.render();
      });
    }

    // --------------------------
    // Positions Table (Below Symbol Boxes)
    // --------------------------
    this.positionsTable = this.grid.set(3, 0, 4, 12, contrib.table, {
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
    // Info Box and Orders Table (Middle)
    // --------------------------

    // Info Box (Left)
    this.infoBox = this.grid.set(7, 0, 2, 6, contrib.log, {
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
    this.ordersTable = this.grid.set(7, 6, 2, 6, contrib.table, {
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
    // Errors Box and Warnings Box (Bottom)
    // --------------------------

    // Errors Box (Left)
    this.errorBox = this.grid.set(9, 0, 3, 6, contrib.log, {
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
    this.warningBox = this.grid.set(9, 6, 3, 6, contrib.log, {
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
    // Hotkey Listener
    // --------------------------
    const keyMap = { '!': 1, '@': 2, '#': 3, $: 4, '%': 5 };

    this.screen.key(['!', '@', '#', '$', '%'], (ch, key) => {
      // Find the selected symbol box
      const selectedBox = this.symbolBoxes.find((sb) => sb.selected);
      if (selectedBox) {
        const symbol = selectedBox.symbol;
        if (!symbol) {
          this.logWarning('No symbol entered in the selected box.');
          return;
        }
        // Handle the hotkey
        const actionNumber = keyMap[key.full];
        this.handleHotkey(actionNumber, symbol);
      } else {
        this.logWarning('No symbol box selected.');
      }
    });

    // --------------------------
    // Quit Key Bindings
    // --------------------------
    // Quit on Escape, q, or Control-C.
    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });

    // --------------------------
    // Tab Navigation Key Bindings
    // --------------------------
    this.screen.key(['tab', 'S-tab'], (ch, key) => {
      this.cycleSymbolBox(key.shift);
    });

    // Select the first symbol box by default and focus its input
    if (this.symbolBoxes.length > 0) {
      this.selectSymbolBox(0);
      this.symbolBoxes[0].input.focus();
    }

    this.screen.render();
  }

  setOrderManager(orderManager) {
    this.orderManager = orderManager;
  }

  setPolygonClient(polygon) {
    this.polygon = polygon;
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

      // Simplify stop price display
      const stopCentsValue = parseFloat(pos.stopCents);
      const stopCentsDisplay = `${stopCentsValue >= 0 ? '' : '-'}${Math.abs(
        stopCentsValue
      )}¢`;

      const stopPrice = pos.stopPrice
        ? `$${pos.stopPrice.toFixed(2)} (${stopCentsDisplay})`
        : 'N/A';

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
        stopPrice,
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
   * Selects a symbol box and highlights it.
   * @param {number} index - Index of the symbol box to select.
   */
  selectSymbolBox(index) {
    // Deselect all symbol boxes
    this.symbolBoxes.forEach((sb, i) => {
      sb.selected = false;
      sb.box.style.border.fg = 'cyan';
    });

    // Select the specified box
    this.symbolBoxes[index].selected = true;
    this.symbolBoxes[index].box.style.border.fg = 'yellow';

    // Focus the input field of the selected box
    this.symbolBoxes[index].input.focus();
  }

  /**
   * Cycles through the symbol boxes based on the direction.
   * @param {boolean} reverse - If true, cycles in reverse order.
   */
  cycleSymbolBox(reverse = false) {
    const totalBoxes = this.symbolBoxes.length;
    if (totalBoxes === 0) return;

    // Find the currently selected box index
    let currentIndex = this.symbolBoxes.findIndex((sb) => sb.selected);

    // If no box is selected, default to first box
    if (currentIndex === -1) {
      currentIndex = 0;
    }

    // Determine the next index based on the direction
    if (reverse) {
      currentIndex = (currentIndex - 1 + totalBoxes) % totalBoxes;
    } else {
      currentIndex = (currentIndex + 1) % totalBoxes;
    }

    // Select the new box
    this.selectSymbolBox(currentIndex);

    this.screen.render();
  }

  /**
   * Handles when a symbol is entered into a symbol box.
   * @param {number} index - Index of the symbol box.
   * @param {string} symbol - The symbol entered.
   */
  onSymbolEntered(index, symbol) {
    if (!this.polygon) {
      this.logError('Polygon client is not set.');
      return;
    }

    // Unsubscribe from previous symbol if any
    const previousSymbol = this.symbolBoxes[index].currentSymbol;
    if (previousSymbol) {
      this.polygon.unsubscribe(previousSymbol);
    }

    // Subscribe to symbol in Polygon
    this.polygon.subscribe(symbol);

    // Store the symbol in the symbol box data
    this.symbolBoxes[index].currentSymbol = symbol;

    // Update the bid and ask prices to N/A until new data arrives
    this.symbolBoxes[index].bidText.setContent('Bid: N/A');
    this.symbolBoxes[index].askText.setContent('Ask: N/A');

    this.screen.render();
  }

  /**
   * Updates the bid and ask prices in the symbol boxes.
   * @param {string} symbol - The symbol for which to update prices.
   * @param {number} bidPrice - The latest bid price.
   * @param {number} askPrice - The latest ask price.
   */
  updateSymbolBoxPrices(symbol, bidPrice, askPrice) {
    const symbolBox = this.symbolBoxes.find((sb) => sb.symbol === symbol);
    if (symbolBox) {
      symbolBox.bidText.setContent(`Bid: $${bidPrice.toFixed(2)}`);
      symbolBox.askText.setContent(`Ask: $${askPrice.toFixed(2)}`);
      symbolBox.currentBid = bidPrice;
      symbolBox.currentAsk = askPrice;
      this.screen.render();
    }
  }

  /**
   * Handles hotkey actions for the selected symbol box.
   * @param {number} actionNumber - The action number corresponding to the hotkey.
   * @param {string} symbol - The symbol associated with the action.
   */
  handleHotkey(actionNumber, symbol) {
    this.logInfo(`Hotkey ${actionNumber} pressed for symbol ${symbol}`);
    if (!this.orderManager) {
      this.logError('OrderManager is not set.');
      return;
    }
    this.orderManager.handleHotkeyAction(actionNumber, symbol);
  }
}

module.exports = Dashboard;
