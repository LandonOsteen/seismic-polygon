// orderManager.js

const { alpaca } = require('./alpaca'); // Alpaca API client
const config = require('./config'); // Configuration file
const logger = require('./logger'); // Logger module
const crypto = require('crypto'); // For generating unique client order IDs
const Bottleneck = require('bottleneck'); // Rate limiter
const axios = require('axios'); // HTTP requests
const fs = require('fs'); // File system operations
const path = require('path'); // Path utilities
const moment = require('moment-timezone'); // Timezone-aware date handling

class OrderManager {
  constructor(dashboard, polygon) {
    this.dashboard = dashboard;
    this.polygon = polygon;

    this.positions = {}; // symbol => position info
    this.orderTracking = {}; // orderId => { symbol, type, qty, side, filledQty }

    // watchlist: symbol => {side, HOD, LOD, attemptHOD, attemptLOD, trailingStopActive, trailingStopPrice}
    this.watchlist = {};
    this.lastEntryTime = {}; // track last entry time for cooldown

    // Flags
    this.isRefreshing = false;
    this.isPolling = false;

    // Initialize rate limiter
    this.limiter = new Bottleneck({
      minTime: 350, // Minimum time between requests in ms
      maxConcurrent: 1,
    });

    // Wrap Alpaca API calls
    this.limitedGetPositions = this.limiter.wrap(
      alpaca.getPositions.bind(alpaca)
    );
    this.limitedGetOrders = this.limiter.wrap(alpaca.getOrders.bind(alpaca));
    this.limitedCreateOrder = this.limiter.wrap(
      alpaca.createOrder.bind(alpaca)
    );

    // Initialize existing positions
    this.initializeExistingPositions();

    // Polling intervals
    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(
      () => this.refreshPositions(),
      config.pollingIntervals.positionRefresh
    );

    // Load and refresh watchlist
    this.watchlistFilePath = path.resolve(config.watchlistFile);
    this.loadWatchlist();
    setInterval(
      () => this.refreshWatchlist(),
      config.pollingIntervals.watchlistRefresh
    );

    // Initial and periodic HOD/LOD updates
    this.updateHodLodData();
    setInterval(
      () => this.updateHodLodData(),
      config.pollingIntervals.hodLodRefresh
    );
  }

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  loadWatchlist() {
    try {
      const data = fs.readFileSync(this.watchlistFilePath, 'utf-8');
      const updatedList = JSON.parse(data);

      for (const item of updatedList) {
        const symbol = item.symbol.toUpperCase();
        const side = item.side.toLowerCase();
        if (!this.watchlist[symbol]) {
          this.watchlist[symbol] = {
            symbol,
            side,
            HOD: null,
            LOD: null,
            attemptHOD: null,
            attemptLOD: null,
            attemptActive: false, // Add this field
            trailingStopActive: false,
            trailingStopPrice: null,
          };

          this.polygon.subscribeQuotes(symbol);
          this.polygon.subscribeTrades(symbol);

          logger.info(`Added ${symbol} to watchlist as ${side}.`);
          this.dashboard.logInfo(`Added ${symbol} to watchlist as ${side}.`);

          this.initializeSymbolHodLod(symbol);
        } else {
          if (this.watchlist[symbol].side !== side) {
            this.watchlist[symbol].side = side;
            logger.info(`Updated side for ${symbol} to ${side}.`);
            this.dashboard.logInfo(`Updated side for ${symbol} to ${side}.`);
          }
        }
      }

      // Remove symbols not in the updated watchlist
      const currentSymbols = Object.keys(this.watchlist);
      const updatedSymbols = updatedList.map((x) => x.symbol.toUpperCase());

      for (const sym of currentSymbols) {
        if (!updatedSymbols.includes(sym)) {
          delete this.watchlist[sym];
          this.polygon.unsubscribeQuotes(sym);
          this.polygon.unsubscribeTrades(sym);
          logger.info(`Removed ${sym} from watchlist.`);
          this.dashboard.logInfo(`Removed ${sym} from watchlist.`);
        }
      }

      this.updateWatchlistOnDashboard();
    } catch (err) {
      logger.error(`Error loading watchlist: ${err.message}`);
      this.dashboard.logError(`Error loading watchlist: ${err.message}`);
    }
  }

  async refreshWatchlist() {
    try {
      const data = fs.readFileSync(this.watchlistFilePath, 'utf-8');
      const updatedList = JSON.parse(data);

      const currentSymbols = Object.keys(this.watchlist);
      const updatedSymbols = updatedList.map((item) =>
        item.symbol.toUpperCase()
      );

      // Add new symbols
      for (const item of updatedList) {
        const symbol = item.symbol.toUpperCase();
        const side = item.side.toLowerCase();
        if (!this.watchlist[symbol]) {
          this.watchlist[symbol] = {
            symbol,
            side,
            HOD: null,
            LOD: null,
            attemptHOD: null,
            attemptLOD: null,
            trailingStopActive: false,
            trailingStopPrice: null,
          };

          this.polygon.subscribeQuotes(symbol);
          this.polygon.subscribeTrades(symbol);

          logger.info(`Added ${symbol} to watchlist as ${side}.`);
          this.dashboard.logInfo(`Added ${symbol} to watchlist as ${side}.`);

          this.initializeSymbolHodLod(symbol);
        } else {
          if (this.watchlist[symbol].side !== side) {
            this.watchlist[symbol].side = side;
            logger.info(`Updated side for ${symbol} to ${side}.`);
            this.dashboard.logInfo(`Updated side for ${symbol} to ${side}.`);
          }
        }
      }

      // Remove symbols not in updated watchlist
      for (const sym of currentSymbols) {
        if (!updatedSymbols.includes(sym)) {
          delete this.watchlist[sym];
          this.polygon.unsubscribeQuotes(sym);
          this.polygon.unsubscribeTrades(sym);
          logger.info(`Removed ${sym} from watchlist.`);
          this.dashboard.logInfo(`Removed ${sym} from watchlist.`);
        }
      }

      this.updateWatchlistOnDashboard();
    } catch (err) {
      logger.error(`Error refreshing watchlist: ${err.message}`);
      this.dashboard.logError(`Error refreshing watchlist: ${err.message}`);
    }
  }

  async initializeSymbolHodLod(symbol) {
    try {
      await this.updateHodLodForSymbol(symbol);
    } catch (err) {
      logger.error(`Error initializing HOD/LOD for ${symbol}: ${err.message}`);
      this.dashboard.logError(
        `Error initializing HOD/LOD for ${symbol}: ${err.message}`
      );
    }
  }

  /**
   * Updates HOD and LOD for all symbols in the watchlist by calling updateHodLodForSymbol.
   */
  async updateHodLodData() {
    for (const sym in this.watchlist) {
      try {
        await this.updateHodLodForSymbol(sym);
      } catch (err) {
        this.dashboard.logError(
          `Error updating HOD/LOD for ${sym}: ${err.message}`
        );
        logger.error(`Error updating HOD/LOD for ${sym}: ${err.message}`);
      }
    }
    this.updateWatchlistOnDashboard();
  }

  async updateHodLodForSymbol(symbol) {
    symbol = symbol.toUpperCase();
    const endTime = Date.now();
    const now = moment().tz(config.timeZone);
    const fourAm = now.clone().hour(4).minute(0).second(0).millisecond(0);
    if (fourAm.isAfter(now)) {
      fourAm.subtract(1, 'day');
    }
    const startOfDay = fourAm.valueOf();

    const fiveMinutesMs = 5 * 60 * 1000;
    const start5MinAgo = endTime - fiveMinutesMs;

    try {
      const bars5Min = await this.fetchAggregates(
        symbol,
        5,
        'minute',
        startOfDay,
        endTime
      );
      let maxHigh5min = Number.NEGATIVE_INFINITY;
      let minLow5min = Number.POSITIVE_INFINITY;

      if (bars5Min && bars5Min.length > 0) {
        for (const bar of bars5Min) {
          if (bar.h > maxHigh5min) maxHigh5min = bar.h;
          if (bar.l < minLow5min) minLow5min = bar.l;
        }
      } else {
        maxHigh5min = null;
        minLow5min = null;
      }

      const bars5Sec = await this.fetchAggregates(
        symbol,
        5,
        'second',
        start5MinAgo,
        endTime
      );
      let maxHigh5sec = Number.NEGATIVE_INFINITY;
      let minLow5sec = Number.POSITIVE_INFINITY;

      if (bars5Sec && bars5Sec.length > 0) {
        for (const bar of bars5Sec) {
          if (bar.h > maxHigh5sec) maxHigh5sec = bar.h;
          if (bar.l < minLow5sec) minLow5sec = bar.l;
        }
      } else {
        maxHigh5sec = null;
        minLow5sec = null;
      }

      let finalHOD = null;
      let finalLOD = null;

      const candidatesHOD = [maxHigh5min, maxHigh5sec].filter(
        (x) => x !== null
      );
      const candidatesLOD = [minLow5min, minLow5sec].filter((x) => x !== null);

      if (candidatesHOD.length > 0) {
        finalHOD = Math.max(...candidatesHOD);
      }

      if (candidatesLOD.length > 0) {
        finalLOD = Math.min(...candidatesLOD);
      }

      this.watchlist[symbol].HOD = finalHOD;
      this.watchlist[symbol].LOD = finalLOD;

      logger.info(
        `HOD/LOD updated for ${symbol}: HOD=${finalHOD}, LOD=${finalLOD}`
      );
      this.dashboard.logInfo(
        `HOD/LOD updated for ${symbol}: HOD=${finalHOD}, LOD=${finalLOD}`
      );
    } catch (err) {
      logger.error(`Error updating HOD/LOD for ${symbol}: ${err.message}`);
      this.dashboard.logError(
        `Error updating HOD/LOD for ${symbol}: ${err.message}`
      );
    }
  }

  async fetchAggregates(symbol, timespanValue, timespanUnit, start, end) {
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${timespanValue}/${timespanUnit}/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${config.polygon.apiKey}`;
    try {
      const response = await axios.get(url);
      return response.data.results || [];
    } catch (err) {
      logger.error(`Error fetching aggregates for ${symbol}: ${err.message}`);
      this.dashboard.logError(
        `Error fetching aggregates for ${symbol}: ${err.message}`
      );
      return [];
    }
  }

  async initializeExistingPositions() {
    try {
      const positions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      for (const position of positions) {
        await this.addPosition(position);
      }
      this.dashboard.updatePositions(Object.values(this.positions));
    } catch (err) {
      const message = `Error initializing existing positions: ${err.message}`;
      logger.error(message);
      this.dashboard.logError(message);
    }
  }

  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = position.side === 'long' ? 'buy' : 'sell';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    const dynamicStop = this.calculateDynamicStopPrice(0, avgEntryPrice, side);
    const stopPrice = dynamicStop ? dynamicStop.stopPrice : null;
    const stopCents = dynamicStop ? dynamicStop.stopCents : null;

    this.positions[symbol] = {
      symbol,
      qty,
      initialQty: qty,
      side,
      avgEntryPrice,
      currentBid: parseFloat(position.current_price) - 0.01,
      currentAsk: parseFloat(position.current_price) + 0.01,
      currentPrice: parseFloat(position.current_price),
      profitCents: 0,
      profitTargetsHit: 0,
      totalProfitTargets: config.orderSettings.profitTargets.length,
      isActive: true,
      isProcessing: false,
      stopPrice: stopPrice,
      stopCents: stopCents,
      stopTriggered: false,
      pyramidLevelsHit: 0,
      totalPyramidLevels: config.orderSettings.pyramidLevels.length,
      trailingStopActive: false,
      trailingStopPrice: null,
    };

    const message = `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`;
    logger.info(message);
    this.dashboard.logInfo(message);

    this.polygon.subscribeQuotes(symbol);
    this.dashboard.updatePositions(Object.values(this.positions));
  }

  removePosition(symbol) {
    symbol = symbol.toUpperCase();
    if (this.positions[symbol]) {
      delete this.positions[symbol];
      const message = `Position removed: ${symbol}`;
      logger.info(message);
      this.dashboard.logInfo(message);

      // Reset attempt fields since the position is closed
      if (this.watchlist[symbol]) {
        this.watchlist[symbol].attemptHOD = null;
        this.watchlist[symbol].attemptLOD = null;
        this.watchlist[symbol].attemptActive = false;
      }

      this.polygon.unsubscribeQuotes(symbol);
      this.dashboard.updatePositions(Object.values(this.positions));
    }
  }

  async refreshPositions() {
    if (this.isRefreshing) return;

    this.isRefreshing = true;

    try {
      const latestPositions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      const latestPositionMap = {};
      latestPositions.forEach((position) => {
        latestPositionMap[position.symbol] = position;
      });

      for (const symbol in this.positions) {
        if (latestPositionMap[symbol]) {
          const latestQty = Math.abs(parseFloat(latestPositionMap[symbol].qty));
          const latestAvgEntryPrice = parseFloat(
            latestPositionMap[symbol].avg_entry_price
          );
          this.positions[symbol].qty = latestQty;
          this.positions[symbol].avgEntryPrice = latestAvgEntryPrice;
          this.positions[symbol].currentPrice = parseFloat(
            latestPositionMap[symbol].current_price
          );

          this.positions[symbol].profitCents = (
            (this.positions[symbol].currentPrice -
              this.positions[symbol].avgEntryPrice) *
            100 *
            (this.positions[symbol].side === 'buy' ? 1 : -1)
          ).toFixed(2);

          const dynamicStop = this.calculateDynamicStopPrice(
            this.positions[symbol].profitTargetsHit,
            this.positions[symbol].avgEntryPrice,
            this.positions[symbol].side
          );
          if (dynamicStop) {
            this.positions[symbol].stopPrice = dynamicStop.stopPrice;
            this.positions[symbol].stopCents = dynamicStop.stopCents;
          }

          if (latestQty === 0) {
            this.removePosition(symbol);
            if (this.watchlist[symbol]) {
              this.watchlist[symbol].attemptHOD = null;
              this.watchlist[symbol].attemptLOD = null;
            }
          }
        } else {
          this.removePosition(symbol);
          if (this.watchlist[symbol]) {
            this.watchlist[symbol].attemptHOD = null;
            this.watchlist[symbol].attemptLOD = null;
          }
        }
      }

      latestPositions.forEach((position) => {
        const symbol = position.symbol;
        if (!this.positions[symbol]) {
          this.addPosition(position);
        }
      });

      this.dashboard.updatePositions(Object.values(this.positions));
    } catch (err) {
      const errorMessage = `Error refreshing positions: ${err.message}`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Handles incoming quote updates from Polygon.
   * @param {string} symbol - The ticker symbol.
   * @param {number} bidPrice - The current bid price.
   * @param {number} askPrice - The current ask price.
   */
  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    symbol = symbol.toUpperCase();

    // Check if the symbol is in the watchlist
    if (!this.watchlist[symbol]) {
      // If not, optionally log this occurrence
      logger.warn(
        `Received quote update for ${symbol}, which is not in the watchlist.`
      );
      this.dashboard.logWarning(
        `Received quote update for ${symbol}, which is not in the watchlist.`
      );
      return;
    }

    // Update last known bid and ask in watchlist
    this.watchlist[symbol].lastBid = bidPrice;
    this.watchlist[symbol].lastAsk = askPrice;

    // Check if the attempt has timed out and reset if necessary
    await this.checkAttemptTimeout(symbol);

    const pos = this.positions[symbol];
    if (!pos || !pos.isActive) {
      return; // No active position to manage
    }

    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;

    // Update current price and profit
    pos.currentBid = bidPrice;
    pos.currentAsk = askPrice;
    pos.currentPrice = currentPrice;

    pos.profitCents = (
      (currentPrice - entryPrice) *
      100 *
      (side === 'buy' ? 1 : -1)
    ).toFixed(2);

    const message = `Symbol: ${symbol} | Profit: ${
      pos.profitCents
    }¢ | Current Price: $${currentPrice.toFixed(2)}`;
    this.dashboard.logInfo(message);

    // Check stop conditions
    if (!pos.stopTriggered) {
      if (
        (side === 'buy' && bidPrice <= pos.stopPrice) ||
        (side === 'sell' && askPrice >= pos.stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMessage = `Stop condition met for ${symbol}. Initiating limit order to close position.`;
        logger.info(stopMessage);
        this.dashboard.logWarning(stopMessage);
        await this.closePositionMarketOrder(symbol);
        return;
      }
    }

    // Update trailing stops
    if (pos.trailingStopActive) {
      await this.updateTrailingStop(
        pos,
        currentPrice,
        symbol,
        bidPrice,
        askPrice
      );
    }

    // Handle profit targets and pyramiding
    await this.handleProfitTargetsAndPyramiding(pos, currentPrice);
  }
  /**
   * Handles trade updates for triggering entry orders.
   * @param {string} symbol - The ticker symbol.
   * @param {number} tradePrice - The price at which the trade occurred.
   */
  async onTradeUpdate(symbol, tradePrice) {
    symbol = symbol.toUpperCase();
    if (!this.watchlist[symbol]) return;

    const item = this.watchlist[symbol];
    const offset = config.orderSettings.entryOffsetCents / 100;
    const now = Date.now();
    const cooldown = config.orderSettings.entryCooldownSeconds * 1000;

    // Check if a position already exists for this symbol
    if (this.positions[symbol] && this.positions[symbol].isActive) {
      this.dashboard.logInfo(
        `Skipping entry for ${symbol} because a position is already open.`
      );
      return;
    }

    // If an attempt is already active, skip creating a new entry
    if (item.attemptActive) {
      this.dashboard.logInfo(
        `Skipping entry for ${symbol} because an attempt is already active.`
      );
      return;
    }

    // Check cooldown
    if (
      this.lastEntryTime[symbol] &&
      now - this.lastEntryTime[symbol] < cooldown
    ) {
      this.dashboard.logInfo(`Skipping entry for ${symbol} due to cooldown.`);
      return;
    }

    // Conditions to trigger a long entry on HOD break
    if (
      item.side === 'long' &&
      item.HOD !== null &&
      tradePrice > item.HOD + offset
    ) {
      if (item.attemptHOD === null) {
        item.attemptHOD = item.HOD; // Record the attempt level
      }

      // Mark attempt as active
      item.attemptActive = true;
      this.lastEntryTime[symbol] = now;
      this.attemptStartTime[symbol] = now; // Record attempt start time

      try {
        await this.placeEntryOrder(symbol, 'buy', tradePrice);
      } catch (err) {
        this.dashboard.logError(
          `Error placing entry order for ${symbol}: ${err.message}`
        );
        // Optionally, reset attemptActive here if you want another try
        // item.attemptActive = false;
        // this.attemptStartTime[symbol] = 0;
      }
    }

    // Conditions to trigger a short entry on LOD break
    if (
      item.side === 'short' &&
      item.LOD !== null &&
      tradePrice < item.LOD - offset
    ) {
      if (item.attemptLOD === null) {
        item.attemptLOD = item.LOD; // Record the attempt level
      }

      // Mark attempt as active
      item.attemptActive = true;
      this.lastEntryTime[symbol] = now;
      this.attemptStartTime[symbol] = now; // Record attempt start time

      try {
        await this.placeEntryOrder(symbol, 'sell', tradePrice);
      } catch (err) {
        this.dashboard.logError(
          `Error placing entry order for ${symbol}: ${err.message}`
        );
        // Optionally, reset attemptActive here if you want another try
        // item.attemptActive = false;
        // this.attemptStartTime[symbol] = 0;
      }
    }
  }

  async fetchIntradayBars(symbol, start, end) {
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${config.polygon.apiKey}`;
    try {
      const response = await axios.get(url);
      return response.data.results || [];
    } catch (err) {
      logger.error(
        `Error fetching intraday bars for ${symbol}: ${err.message}`
      );
      this.dashboard.logError(
        `Error fetching intraday bars for ${symbol}: ${err.message}`
      );
      return [];
    }
  }

  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (err.response && err.response.status === 429) {
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        const message = `Rate limit hit. Retrying in ${totalDelay.toFixed(
          0
        )}ms...`;
        logger.warn(message);
        this.dashboard.logWarning(message);
        await this.sleep(totalDelay);
        return this.retryOperation(operation, retries - 1, delay * 2);
      }
      throw err;
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateWatchlistOnDashboard() {
    const data = Object.values(this.watchlist).map((item) => [
      item.symbol,
      item.side.toUpperCase(),
      item.HOD !== null ? item.HOD.toFixed(2) : 'N/A',
      item.LOD !== null ? item.LOD.toFixed(2) : 'N/A',
      item.attemptHOD !== null ? item.attemptHOD.toFixed(2) : 'N/A',
      item.attemptLOD !== null ? item.attemptLOD.toFixed(2) : 'N/A',
    ]);

    this.dashboard.watchlistTable.setData({
      headers: ['SYM', 'SIDE', 'HOD', 'LOD', 'A-HOD', 'A-LOD'],
      data: data,
    });

    this.dashboard.screen.render();
  }

  /**
   * Places an entry order with a marketable limit price.
   * @param {string} symbol - The ticker symbol.
   * @param {string} side - 'buy' for long entries, 'sell' for short entries.
   * @param {number} tradePrice - The price at which the trade was triggered.
   */
  async placeEntryOrder(symbol, side, tradePrice) {
    const now = Date.now();
    const cooldown = config.orderSettings.entryCooldownSeconds * 1000;
    const entryOrderOffsetCents =
      config.orderSettings.entryOrderOffsetCents || 10; // Default to 10 cents if not set

    // Double-check cooldown here as well
    if (
      this.lastEntryTime[symbol] &&
      now - this.lastEntryTime[symbol] < cooldown
    ) {
      this.dashboard.logInfo(
        `Cooldown check inside placeEntryOrder: Skipping entry for ${symbol}.`
      );
      return;
    }

    const entryQty = config.orderSettings.entryQty;

    // Get the last known quote from watchlist
    const item = this.watchlist[symbol];
    if (!item || item.lastBid == null || item.lastAsk == null) {
      this.dashboard.logError(
        `No last quote data for ${symbol}. Cannot place entry order with offset.`
      );
      return;
    }

    let limitPrice;
    if (side === 'buy') {
      // For a long entry, set limit price above the ask
      limitPrice = item.lastAsk + entryOrderOffsetCents / 100;
    } else {
      // For a short entry, set limit price below the bid
      limitPrice = item.lastBid - entryOrderOffsetCents / 100;
    }

    const order = {
      symbol,
      qty: entryQty.toString(),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('ENTRY'),
    };

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const msg = `Entry order placed: ${side.toUpperCase()} ${symbol} ${entryQty} @ ${limitPrice.toFixed(
        2
      )}`;
      logger.info(msg);
      this.dashboard.logInfo(msg);

      this.orderTracking[result.id] = {
        symbol,
        type: 'entry',
        qty: parseFloat(order.qty),
        side,
        filledQty: 0,
      };
    } catch (err) {
      const errorMessage = `Error placing entry order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      // Optionally, reset attemptActive here if placing the order fails
      // this.watchlist[symbol].attemptActive = false;
    }
  }

  /**
   * Checks if an active entry attempt has timed out. If so, resets the attempt and updates HOD/LOD.
   * @param {string} symbol - The ticker symbol.
   */
  async checkAttemptTimeout(symbol) {
    const item = this.watchlist[symbol];
    if (!item) return; // Symbol not in watchlist; nothing to do

    // Proceed only if an attempt is active and no position is open
    if (
      item.attemptActive &&
      (!this.positions[symbol] || !this.positions[symbol].isActive)
    ) {
      const now = Date.now();
      const timeoutMs =
        (config.orderSettings.attemptTimeoutSeconds || 5) * 1000;
      const startTime = this.attemptStartTime[symbol] || 0;

      // If the attempt has been active longer than the timeout and no position is open
      if (startTime > 0 && now - startTime > timeoutMs) {
        this.dashboard.logInfo(
          `Attempt for ${symbol} timed out. Resetting attemptActive.`
        );
        item.attemptActive = false;
        item.attemptHOD = null;
        item.attemptLOD = null;
        this.attemptStartTime[symbol] = 0;

        // Refresh HOD/LOD to use the latest data
        await this.updateHodLodForSymbol(symbol);
        this.dashboard.logInfo(
          `Refreshed HOD/LOD for ${symbol} after attempt timeout.`
        );
      }
    }
  }

  async placeIOCOrder(symbol, qty, side) {
    const pos = this.positions[symbol];
    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    let limitPrice;

    if (side === 'buy') {
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
    } else {
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    }

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${symbol}. Cannot place ${side} order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      return;
    }

    const order = {
      symbol,
      qty: qty.toString(),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('LIMIT'),
    };

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `IOC limit order placed: ${side.toUpperCase()} ${symbol} ${qty} @ ${limitPrice}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'ioc',
        qty: parseFloat(order.qty),
        side,
        filledQty: 0,
      };

      await this.refreshPositions();
    } catch (err) {
      const errorMessage = `Error placing IOC order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  async placePyramidOrder(pos, qtyToAdd, offsetCents) {
    const symbol = pos.symbol;
    const side = pos.side;
    let limitPrice;

    if (side === 'buy') {
      limitPrice = pos.currentAsk + offsetCents / 100;
    } else {
      limitPrice = pos.currentBid - offsetCents / 100;
    }

    const order = {
      symbol,
      qty: qtyToAdd.toString(),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('PYRAMID'),
    };

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const msg = `Pyramid order placed: ${side.toUpperCase()} ${symbol} ${qtyToAdd} @ ${limitPrice}`;
      logger.info(msg);
      this.dashboard.logInfo(msg);

      this.orderTracking[result.id] = {
        symbol,
        type: 'pyramid',
        qty: parseFloat(order.qty),
        side,
        filledQty: 0,
      };

      await this.refreshPositions();
    } catch (err) {
      const errorMessage = `Error placing pyramid order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  async closePositionMarketOrder(symbol) {
    symbol = symbol.toUpperCase();
    const pos = this.positions[symbol];
    const qty = pos.qty;

    if (qty <= 0) {
      const warnMessage = `Attempted to close position for ${symbol} with qty ${qty}.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    // Determine the correct side to close the position
    // If pos.side === 'buy' (long), we must SELL to close.
    // If pos.side === 'sell' (short), we must BUY to close.
    const closeSide = pos.side === 'buy' ? 'sell' : 'buy';

    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    let limitPrice;

    if (closeSide === 'buy') {
      // Closing a short position: buy at ask + offset
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
    } else {
      // Closing a long position: sell at bid - offset
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    }

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${symbol}. Cannot place ${closeSide} order to close.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      return;
    }

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side: closeSide,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('CLOSE'),
    };

    const closeMessage = `Closing position with limit order: ${JSON.stringify(
      order
    )}`;
    logger.info(closeMessage);
    this.dashboard.logInfo(closeMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Limit order placed to close position in ${symbol}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'close',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };

      // Immediately refresh positions after placing an order
      await this.refreshPositions();
    } catch (err) {
      const errorMessage = `Error placing limit order to close position for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  calculateDynamicStopPrice(profitTargetsHit, avgEntryPrice, side) {
    const dynamicStops = config.orderSettings.dynamicStops
      .filter((ds) => ds.profitTargetsHit <= profitTargetsHit)
      .sort((a, b) => b.profitTargetsHit - a.profitTargetsHit);

    if (dynamicStops.length > 0) {
      const dynamicStop = dynamicStops[0];
      const stopCents = dynamicStop.stopCents;
      const stopPrice =
        avgEntryPrice + (stopCents / 100) * (side === 'buy' ? 1 : -1);
      return { stopPrice, stopCents };
    } else {
      const stopLossCents = config.orderSettings.dynamicStops[0].stopCents;
      const stopPrice =
        avgEntryPrice - (stopLossCents / 100) * (side === 'buy' ? 1 : -1);
      return { stopPrice, stopCents: -stopLossCents };
    }
  }

  async updateTrailingStop(pos, currentPrice, symbol, bidPrice, askPrice) {
    const trailingOffset = config.orderSettings.trailingStopOffsetCents / 100;

    if (pos.side === 'buy') {
      // For a long position:
      // Move trailing stop up if current price - offset > trailingStopPrice
      if (currentPrice - trailingOffset > pos.trailingStopPrice) {
        pos.trailingStopPrice = currentPrice - trailingOffset;
        logger.info(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
        this.dashboard.logInfo(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
      }

      // If bid falls below trailing stop, close the position
      if (bidPrice <= pos.trailingStopPrice) {
        const msg = `Trailing stop triggered for ${symbol}. Closing long position.`;
        logger.info(msg);
        this.dashboard.logWarning(msg);
        await this.closePositionMarketOrder(symbol);
      }
    } else {
      // For a short position:
      // Move trailing stop down (from the other direction) if current price + offset < trailingStopPrice
      if (pos.trailingStopPrice - currentPrice > trailingOffset) {
        pos.trailingStopPrice = currentPrice + trailingOffset;
        logger.info(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
        this.dashboard.logInfo(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
      }

      // If ask rises above trailing stop, close the short position
      if (askPrice >= pos.trailingStopPrice) {
        const msg = `Trailing stop triggered for ${symbol}. Closing short position.`;
        logger.info(msg);
        this.dashboard.logWarning(msg);
        await this.closePositionMarketOrder(symbol);
      }
    }
  }

  async handleProfitTargetsAndPyramiding(pos, currentPrice) {
    const side = pos.side;
    const profitCents = parseFloat(pos.profitCents);

    const profitTargets = config.orderSettings.profitTargets;
    if (pos.profitTargetsHit < profitTargets.length) {
      const target = profitTargets[pos.profitTargetsHit];
      if (!pos.isProcessing && profitCents >= target.targetCents) {
        pos.isProcessing = true;
        const targetMessage = `Profit target hit for ${pos.symbol}: ${profitCents}¢ >= ${target.targetCents}¢`;
        logger.info(targetMessage);
        this.dashboard.logInfo(targetMessage);

        let qtyToClose = Math.floor(pos.qty * (target.percentToClose / 100));
        qtyToClose = Math.min(qtyToClose, pos.qty);
        if (qtyToClose > 0) {
          await this.placeIOCOrder(
            pos.symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
        }

        pos.profitTargetsHit += 1;
        const dynamicStop = this.calculateDynamicStopPrice(
          pos.profitTargetsHit,
          pos.avgEntryPrice,
          pos.side
        );
        if (dynamicStop) {
          pos.stopPrice = dynamicStop.stopPrice;
          pos.stopCents = dynamicStop.stopCents;
        }

        pos.isProcessing = false;
        this.dashboard.updatePositions(Object.values(this.positions));
      }
    }

    if (
      pos.profitTargetsHit >= profitTargets.length &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      let offset = config.orderSettings.trailingStopOffsetCents / 100;
      if (pos.side === 'buy') {
        pos.trailingStopPrice = pos.currentPrice - offset;
      } else {
        pos.trailingStopPrice = pos.currentPrice + offset;
      }
      const trailStopMessage = `Trailing stop activated for ${
        pos.symbol
      } at $${pos.trailingStopPrice.toFixed(2)}`;
      logger.info(trailStopMessage);
      this.dashboard.logInfo(trailStopMessage);
      this.dashboard.updatePositions(Object.values(this.positions));
    }

    const pyramidLevels = config.orderSettings.pyramidLevels;
    if (pos.pyramidLevelsHit < pyramidLevels.length) {
      const nextLevel = pyramidLevels[pos.pyramidLevelsHit];
      if (profitCents >= nextLevel.addInCents) {
        if (!pos.isProcessingPyramid) {
          pos.isProcessingPyramid = true;
          let qtyToAdd = Math.floor(pos.qty * (nextLevel.percentToAdd / 100));
          if (qtyToAdd >= 1) {
            await this.placePyramidOrder(pos, qtyToAdd, nextLevel.offsetCents);
            pos.pyramidLevelsHit += 1;
          } else {
            const warnMessage = `Qty to add < 1 for ${
              pos.symbol
            } at pyramid level ${pos.pyramidLevelsHit + 1}.`;
            logger.warn(warnMessage);
            this.dashboard.logWarning(warnMessage);
          }
          pos.isProcessingPyramid = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }
  }

  async pollOrderStatuses() {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open' })
      );
      this.dashboard.updateOrders(openOrders);

      for (const order of openOrders) {
        const trackedOrder = this.orderTracking[order.id];
        if (trackedOrder) {
          const filledQty = parseFloat(order.filled_qty || '0');
          trackedOrder.filledQty = filledQty;

          if (filledQty > 0) {
            const pos = this.positions[trackedOrder.symbol];
            if (pos) {
              if (
                trackedOrder.type === 'ioc' ||
                trackedOrder.type === 'close'
              ) {
                pos.qty -= filledQty;

                const fillMessage = `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`;
                logger.info(fillMessage);
                this.dashboard.logInfo(fillMessage);

                pos.profitCents = (
                  (pos.currentPrice - pos.avgEntryPrice) *
                  100 *
                  (pos.side === 'buy' ? 1 : -1)
                ).toFixed(2);

                this.dashboard.updatePositions(Object.values(this.positions));

                if (pos.qty <= 0) {
                  this.removePosition(trackedOrder.symbol);
                  if (this.watchlist[trackedOrder.symbol]) {
                    this.watchlist[trackedOrder.symbol].attemptHOD = null;
                    this.watchlist[trackedOrder.symbol].attemptLOD = null;
                  }
                }
              } else if (trackedOrder.type === 'pyramid') {
                pos.qty += filledQty;

                const totalCost =
                  pos.avgEntryPrice * (pos.qty - filledQty) +
                  filledQty * parseFloat(order.limit_price);
                pos.avgEntryPrice = totalCost / pos.qty;

                const fillMessage = `Pyramid order ${
                  order.id
                } filled ${filledQty} qty for ${
                  trackedOrder.symbol
                }. New qty: ${
                  pos.qty
                }, New Avg Entry Price: $${pos.avgEntryPrice.toFixed(2)}`;
                logger.info(fillMessage);
                this.dashboard.logInfo(fillMessage);

                pos.profitCents = (
                  (pos.currentPrice - pos.avgEntryPrice) *
                  100 *
                  (pos.side === 'buy' ? 1 : -1)
                ).toFixed(2);

                this.dashboard.updatePositions(Object.values(this.positions));
              }
            }
          }

          if (order.status === 'filled' || order.status === 'canceled') {
            delete this.orderTracking[order.id];
          }
        }
      }
    } catch (err) {
      const errorMessage = `Error polling order statuses: ${err.message}`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    } finally {
      this.isPolling = false;
    }
  }

  calculateDynamicStopPrice(profitTargetsHit, avgEntryPrice, side) {
    const dynamicStops = config.orderSettings.dynamicStops
      .filter((ds) => ds.profitTargetsHit <= profitTargetsHit)
      .sort((a, b) => b.profitTargetsHit - a.profitTargetsHit);

    if (dynamicStops.length > 0) {
      const dynamicStop = dynamicStops[0];
      const stopCents = dynamicStop.stopCents;
      const stopPrice =
        avgEntryPrice + (stopCents / 100) * (side === 'buy' ? 1 : -1);
      return { stopPrice, stopCents };
    } else {
      const stopLossCents = config.orderSettings.dynamicStops[0].stopCents;
      const stopPrice =
        avgEntryPrice - (stopLossCents / 100) * (side === 'buy' ? 1 : -1);
      return { stopPrice, stopCents: -stopLossCents };
    }
  }

  async updateTrailingStop(pos, currentPrice, symbol, bidPrice, askPrice) {
    const trailingOffset = config.orderSettings.trailingStopOffsetCents / 100;
    if (pos.side === 'buy') {
      if (currentPrice - trailingOffset > pos.trailingStopPrice) {
        pos.trailingStopPrice = currentPrice - trailingOffset;
        logger.info(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
        this.dashboard.logInfo(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
      }

      if (bidPrice <= pos.trailingStopPrice) {
        const msg = `Trailing stop triggered for ${symbol}. Closing position.`;
        logger.info(msg);
        this.dashboard.logWarning(msg);
        await this.closePositionMarketOrder(symbol);
      }
    } else {
      if (pos.trailingStopPrice - currentPrice > trailingOffset) {
        pos.trailingStopPrice = currentPrice + trailingOffset;
        logger.info(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
        this.dashboard.logInfo(
          `Trailing stop updated for ${symbol} to $${pos.trailingStopPrice.toFixed(
            2
          )}`
        );
      }

      if (askPrice >= pos.trailingStopPrice) {
        const msg = `Trailing stop triggered for ${symbol}. Closing short position.`;
        logger.info(msg);
        this.dashboard.logWarning(msg);
        await this.closePositionMarketOrder(symbol);
      }
    }
  }

  async handleProfitTargetsAndPyramiding(pos, currentPrice) {
    const side = pos.side;
    const profitCents = parseFloat(pos.profitCents);

    const profitTargets = config.orderSettings.profitTargets;
    if (pos.profitTargetsHit < profitTargets.length) {
      const target = profitTargets[pos.profitTargetsHit];
      if (!pos.isProcessing && profitCents >= target.targetCents) {
        pos.isProcessing = true;
        const targetMessage = `Profit target hit for ${pos.symbol}: ${profitCents}¢ >= ${target.targetCents}¢`;
        logger.info(targetMessage);
        this.dashboard.logInfo(targetMessage);

        let qtyToClose = Math.floor(pos.qty * (target.percentToClose / 100));
        qtyToClose = Math.min(qtyToClose, pos.qty);
        if (qtyToClose > 0) {
          await this.placeIOCOrder(
            pos.symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
        }

        pos.profitTargetsHit += 1;
        const dynamicStop = this.calculateDynamicStopPrice(
          pos.profitTargetsHit,
          pos.avgEntryPrice,
          pos.side
        );
        if (dynamicStop) {
          pos.stopPrice = dynamicStop.stopPrice;
          pos.stopCents = dynamicStop.stopCents;
        }

        pos.isProcessing = false;
        this.dashboard.updatePositions(Object.values(this.positions));
      }
    }

    if (
      pos.profitTargetsHit >= profitTargets.length &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      let offset = config.orderSettings.trailingStopOffsetCents / 100;
      if (pos.side === 'buy') {
        pos.trailingStopPrice = pos.currentPrice - offset;
      } else {
        pos.trailingStopPrice = pos.currentPrice + offset;
      }
      const trailStopMessage = `Trailing stop activated for ${
        pos.symbol
      } at $${pos.trailingStopPrice.toFixed(2)}`;
      logger.info(trailStopMessage);
      this.dashboard.logInfo(trailStopMessage);
      this.dashboard.updatePositions(Object.values(this.positions));
    }

    const pyramidLevels = config.orderSettings.pyramidLevels;
    if (pos.pyramidLevelsHit < pyramidLevels.length) {
      const nextLevel = pyramidLevels[pos.pyramidLevelsHit];
      if (profitCents >= nextLevel.addInCents) {
        if (!pos.isProcessingPyramid) {
          pos.isProcessingPyramid = true;
          let qtyToAdd = Math.floor(pos.qty * (nextLevel.percentToAdd / 100));
          if (qtyToAdd >= 1) {
            await this.placePyramidOrder(pos, qtyToAdd, nextLevel.offsetCents);
            pos.pyramidLevelsHit += 1;
          } else {
            const warnMessage = `Qty to add < 1 for ${
              pos.symbol
            } at pyramid level ${pos.pyramidLevelsHit + 1}.`;
            logger.warn(warnMessage);
            this.dashboard.logWarning(warnMessage);
          }
          pos.isProcessingPyramid = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }
  }
}

module.exports = OrderManager;
