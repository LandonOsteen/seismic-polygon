const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const Bottleneck = require('bottleneck');
const PolygonRestClient = require('./polygonRestClient');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

class OrderManager {
  constructor(dashboard, polygon) {
    this.positions = {}; // Active positions
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.orderTracking = {}; // Tracking open orders

    this.isRefreshing = false;
    this.isPolling = false;

    // Override lists (if used)
    this.overrideAddList = new Set(
      (config.overrideAddSymbols || []).map((sym) => sym.toUpperCase())
    );
    this.overrideRemoveList = new Set(
      (config.overrideRemoveSymbols || []).map((sym) => sym.toUpperCase())
    );

    // Initialize rate limiter
    this.limiter = new Bottleneck({
      minTime: 350,
      maxConcurrent: 1,
    });

    // Wrap Alpaca API methods with limiter
    this.limitedGetPositions = this.limiter.wrap(
      alpaca.getPositions.bind(alpaca)
    );
    this.limitedGetOrders = this.limiter.wrap(alpaca.getOrders.bind(alpaca));
    this.limitedCreateOrder = this.limiter.wrap(
      alpaca.createOrder.bind(alpaca)
    );
    this.limitedCancelOrder = this.limiter.wrap(
      alpaca.cancelOrder.bind(alpaca)
    );

    this.restClient = new PolygonRestClient();
    this.watchlist = this.loadManualWatchlist(); // Load initial watchlist from JSON

    this.rollingData = {}; // For trailing stops

    // Initialize watchlist symbols (fetch initial HOD/LOD)
    this.initializeWatchlistSymbols();

    // Initialize existing positions
    this.initializeExistingPositions();

    // Set intervals
    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(
      () => this.refreshPositions(),
      config.pollingIntervals.positionRefresh
    );
    setInterval(
      () => this.reloadManualWatchlist(),
      config.pollingIntervals.watchlistRefresh
    );

    // HOD verification for long positions
    if (
      config.longStrategy.enableHodVerification &&
      config.longStrategy.hodVerificationIntervalMs > 0
    ) {
      setInterval(
        () => this.verifyAllHODs(),
        config.longStrategy.hodVerificationIntervalMs
      );
    }

    // Rolling stop checks
    setInterval(
      () => this.checkRollingStops(),
      config.longStrategy.rollingStopCheckIntervalMs
    );

    // Setup WebSocket callbacks
    if (
      this.dashboard &&
      typeof this.dashboard.setOrderTracking === 'function'
    ) {
      this.dashboard.setOrderTracking(this.orderTracking);
    }

    polygon.onTrade = (symbol, price, size, timestamp) => {
      this.handleTradeUpdate(symbol, price, timestamp);
    };
    polygon.onQuote = (symbol, bidPrice, askPrice) => {
      this.onQuoteUpdate(symbol, bidPrice, askPrice);
    };
  }

  // Load watchlist from manualWatchlist.json
  loadManualWatchlist() {
    const filePath = path.join(__dirname, 'manualWatchlist.json');
    if (!fs.existsSync(filePath)) {
      logger.error('manualWatchlist.json not found. Please provide it.');
      return {};
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const watchlist = {};
      if (Array.isArray(data.longSymbols)) {
        data.longSymbols.forEach((sym) => {
          watchlist[sym.toUpperCase()] = {
            side: 'long',
            highOfDay: null,
            lowOfDay: null,
            candidateHOD: null,
            candidateLOD: null,
            lastEntryTime: null,
            hasPosition: false,
            hasPendingEntryOrder: false,
            isHODFrozen: false,
            executedPyramidLevels: [],
            isSubscribedToTrade: false,
          };
        });
      }
      if (Array.isArray(data.shortSymbols)) {
        data.shortSymbols.forEach((sym) => {
          watchlist[sym.toUpperCase()] = {
            side: 'short',
            highOfDay: null,
            lowOfDay: null,
            candidateHOD: null,
            candidateLOD: null,
            lastEntryTime: null,
            hasPosition: false,
            hasPendingEntryOrder: false,
            isHODFrozen: false,
            executedPyramidLevels: [],
            isSubscribedToTrade: false,
          };
        });
      }
      return watchlist;
    } catch (err) {
      logger.error(`Error parsing manualWatchlist.json: ${err.message}`);
      return {};
    }
  }

  // Reload watchlist from manualWatchlist.json periodically
  reloadManualWatchlist() {
    const filePath = path.join(__dirname, 'manualWatchlist.json');
    if (!fs.existsSync(filePath)) return; // No change if file doesn't exist
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const newLongSymbols = new Set(
        (data.longSymbols || []).map((s) => s.toUpperCase())
      );
      const newShortSymbols = new Set(
        (data.shortSymbols || []).map((s) => s.toUpperCase())
      );

      // Add new long symbols
      newLongSymbols.forEach((sym) => {
        if (!this.watchlist[sym]) {
          this.watchlist[sym] = {
            side: 'long',
            highOfDay: null,
            lowOfDay: null,
            candidateHOD: null,
            candidateLOD: null,
            lastEntryTime: null,
            hasPosition: false,
            hasPendingEntryOrder: false,
            isHODFrozen: false,
            executedPyramidLevels: [],
            isSubscribedToTrade: false,
          };
          logger.info(`Added new long symbol ${sym} from updated watchlist.`);
          this.dashboard.logInfo(
            `Added new long symbol ${sym} from updated watchlist.`
          );
          this.polygon.subscribeQuote(sym);
        }
      });

      // Add new short symbols
      newShortSymbols.forEach((sym) => {
        if (!this.watchlist[sym]) {
          this.watchlist[sym] = {
            side: 'short',
            highOfDay: null,
            lowOfDay: null,
            candidateHOD: null,
            candidateLOD: null,
            lastEntryTime: null,
            hasPosition: false,
            hasPendingEntryOrder: false,
            isHODFrozen: false,
            executedPyramidLevels: [],
            isSubscribedToTrade: false,
          };
          logger.info(`Added new short symbol ${sym} from updated watchlist.`);
          this.dashboard.logInfo(
            `Added new short symbol ${sym} from updated watchlist.`
          );
          this.polygon.subscribeQuote(sym);
        }
      });

      // Remove symbols no longer in watchlist if they have no open position
      for (const sym in this.watchlist) {
        const isLong = this.watchlist[sym].side === 'long';
        if (isLong && !newLongSymbols.has(sym) && !this.positions[sym]) {
          this.removeSymbolFromWatchlist(sym);
        } else if (
          !isLong &&
          !newShortSymbols.has(sym) &&
          !this.positions[sym]
        ) {
          this.removeSymbolFromWatchlist(sym);
        }
      }

      this.dashboard.updateWatchlist(this.watchlist);
    } catch (err) {
      logger.error(`Error reloading manualWatchlist.json: ${err.message}`);
      this.dashboard.logError(
        `Error reloading manualWatchlist.json: ${err.message}`
      );
    }
  }

  // Initialize watchlist symbols by fetching initial HOD/LOD
  async initializeWatchlistSymbols() {
    for (const sym in this.watchlist) {
      const entry = this.watchlist[sym];
      if (entry.side === 'long') {
        try {
          const hod = await this.restClient.getIntradayHighFromAgg(
            sym,
            config.longStrategy.initialAggBarTimeframe.unit,
            config.longStrategy.initialAggBarTimeframe.amount
          );
          if (hod !== null) {
            entry.highOfDay = hod;
            entry.candidateHOD = hod;
            logger.info(`Initialized HOD for ${sym}: $${hod.toFixed(2)}`);
            this.dashboard.logInfo(
              `Initialized HOD for ${sym}: $${hod.toFixed(2)}`
            );
          }
        } catch (err) {
          logger.error(`Error initializing HOD for ${sym}: ${err.message}`);
          this.dashboard.logError(
            `Error initializing HOD for ${sym}: ${err.message}`
          );
        }
      } else if (entry.side === 'short') {
        try {
          const lod = await this.restClient.getIntradayLowFromAgg(
            sym,
            config.shortStrategy.initialAggBarTimeframe.unit,
            config.shortStrategy.initialAggBarTimeframe.amount
          );
          if (lod !== null) {
            entry.lowOfDay = lod;
            entry.candidateLOD = lod;
            logger.info(`Initialized LOD for ${sym}: $${lod.toFixed(2)}`);
            this.dashboard.logInfo(
              `Initialized LOD for ${sym}: $${lod.toFixed(2)}`
            );
          }
        } catch (err) {
          logger.error(`Error initializing LOD for ${sym}: ${err.message}`);
          this.dashboard.logError(
            `Error initializing LOD for ${sym}: ${err.message}`
          );
        }
      }
    }

    // Update watchlist in dashboard
    this.dashboard.updateWatchlist(this.watchlist);
  }

  // Verify HODs for all long symbols
  async verifyAllHODs() {
    for (const sym in this.watchlist) {
      const entry = this.watchlist[sym];
      if (entry.side === 'long') {
        await this.verifyHOD(sym);
      }
    }
  }

  // Verify and update HOD for a single symbol
  async verifyHOD(sym) {
    const entry = this.watchlist[sym];
    if (!entry || entry.side !== 'long') return;

    try {
      const hod = await this.restClient.getIntradayHighFromAgg(
        sym,
        config.longStrategy.initialAggBarTimeframe.unit,
        config.longStrategy.initialAggBarTimeframe.amount
      );
      if (hod !== null && hod > (entry.highOfDay || 0)) {
        const oldHod = entry.highOfDay;
        entry.highOfDay = hod;
        if (entry.candidateHOD === null) {
          entry.candidateHOD = hod;
        }
        logger.info(`HOD for ${sym} verified and updated: ${oldHod} -> ${hod}`);
        this.dashboard.logInfo(
          `HOD for ${sym} verified and updated: ${oldHod} -> ${hod}`
        );
        this.dashboard.updateWatchlist(this.watchlist);
      }
    } catch (err) {
      logger.error(`Error verifying HOD for ${sym}: ${err.message}`);
      this.dashboard.logError(`Error verifying HOD for ${sym}: ${err.message}`);
    }
  }

  // Initialize existing positions from Alpaca
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

  // Add a new position to the system
  async addPosition(position) {
    const sym = position.symbol.toUpperCase();
    const posQty = Math.abs(parseFloat(position.qty));
    const side = position.side === 'long' ? 'buy' : 'sell';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    const entry = this.watchlist[sym];
    if (!entry) {
      const msg = `Watchlist entry missing for ${sym} while adding position.`;
      logger.warn(msg);
      this.dashboard.logWarning(msg);
      return;
    }

    let initialStopPrice;
    let stopDescription;
    if (entry.side === 'long') {
      if (entry.highOfDay === null) {
        const msg = `High of Day missing for ${sym} (long) while adding position.`;
        logger.warn(msg);
        this.dashboard.logWarning(msg);
        return;
      }
      const offset = config.longStrategy.initialStopOffsetCents;
      initialStopPrice = entry.highOfDay - offset / 100;
      stopDescription = `Initial Stop @ $${initialStopPrice.toFixed(
        2
      )} (${offset}¢ below HOD)`;
    } else {
      if (entry.lowOfDay === null) {
        const msg = `Low of Day missing for ${sym} (short) while adding position.`;
        logger.warn(msg);
        this.dashboard.logWarning(msg);
        return;
      }
      const offset = config.shortStrategy.initialStopOffsetCents;
      initialStopPrice = entry.lowOfDay + offset / 100;
      stopDescription = `Initial Stop @ $${initialStopPrice.toFixed(
        2
      )} (${offset}¢ above LOD)`;
    }

    this.positions[sym] = {
      symbol: sym,
      qty: posQty,
      initialQty: posQty,
      side,
      avgEntryPrice,
      currentBid: parseFloat(position.current_price) - 0.01,
      currentAsk: parseFloat(position.current_price) + 0.01,
      currentPrice: parseFloat(position.current_price),
      profitCents: 0,
      isActive: true,
      stopPrice: initialStopPrice,
      stopCents:
        entry.side === 'long'
          ? config.longStrategy.initialStopOffsetCents
          : config.shortStrategy.initialStopOffsetCents,
      stopDescription: stopDescription,
      stopTriggered: false,
      trailingStopActive: false,
      trailingStopPrice: null,
      trailingStopMaxPrice: null,
      trailingStopLastUpdatePrice: null,
      executedPyramidLevels: [],
      totalPyramidLevels: (entry.side === 'long'
        ? config.longStrategy
        : config.shortStrategy
      ).pyramidLevels.length,
      isProcessing: false,
    };

    const message = `Position added: ${sym} | Qty: ${posQty} | Avg Entry: $${avgEntryPrice.toFixed(
      2
    )} | Initial Stop: $${initialStopPrice.toFixed(2)}`;
    logger.info(message);
    this.dashboard.logInfo(message);

    this.polygon.subscribeQuote(sym);
    this.dashboard.updatePositions(Object.values(this.positions));

    if (entry) {
      entry.hasPosition = true;
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  // Remove a position from the system
  removePosition(sym) {
    if (this.positions[sym]) {
      delete this.positions[sym];
      const message = `Position for ${sym} removed.`;
      logger.info(message);
      this.dashboard.logInfo(message);

      if (this.watchlist[sym]) {
        // Reset candidate references after position is fully closed
        this.watchlist[sym].candidateHOD = null;
        this.watchlist[sym].candidateLOD = null;
        this.watchlist[sym].hasPosition = false;
        this.dashboard.updateWatchlist(this.watchlist);
      }

      this.dashboard.updatePositions(Object.values(this.positions));
    }
  }

  // Handle quote updates
  async onQuoteUpdate(sym, bidPrice, askPrice) {
    const upperSym = sym.toUpperCase();
    const entry = this.watchlist[upperSym];
    if (!entry) return;

    const side = entry.side; // 'long' or 'short'
    const strat = side === 'long' ? config.longStrategy : config.shortStrategy;

    // Update HOD or LOD based on side
    if (side === 'long') {
      if (askPrice > (entry.highOfDay || 0)) {
        const oldHod = entry.highOfDay;
        entry.highOfDay = askPrice;
        this.dashboard.logInfo(
          `HOD updated for ${upperSym}: ${oldHod} -> ${entry.highOfDay}`
        );
        if (entry.candidateHOD === null) {
          entry.candidateHOD = entry.highOfDay;
        }
        this.dashboard.updateWatchlist(this.watchlist);
      }
    } else if (side === 'short') {
      if (bidPrice < (entry.lowOfDay || Infinity)) {
        const oldLod = entry.lowOfDay;
        entry.lowOfDay = bidPrice;
        this.dashboard.logInfo(
          `LOD updated for ${upperSym}: ${oldLod} -> ${entry.lowOfDay}`
        );
        if (entry.candidateLOD === null) {
          entry.candidateLOD = entry.lowOfDay;
        }
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }

    // Manage trade proximity subscription
    let referencePrice;
    if (side === 'long') {
      referencePrice = entry.highOfDay;
    } else {
      referencePrice = entry.lowOfDay;
    }

    if (referencePrice !== null) {
      const distanceCents =
        side === 'long'
          ? (referencePrice - askPrice) * 100
          : (bidPrice - referencePrice) * 100;

      if (
        Math.abs(distanceCents) <= strat.tradeProximityCents &&
        !entry.isSubscribedToTrade
      ) {
        this.polygon.subscribeTrade(upperSym);
        entry.isSubscribedToTrade = true;
        this.dashboard.logInfo(
          `Subscribed to trade-level data for ${upperSym} (within ${strat.tradeProximityCents} cents).`
        );
      } else if (
        Math.abs(distanceCents) > strat.tradeProximityCents &&
        entry.isSubscribedToTrade
      ) {
        this.polygon.unsubscribeTrade(upperSym);
        entry.isSubscribedToTrade = false;
        this.dashboard.logInfo(
          `Unsubscribed from trade-level data for ${upperSym} (beyond ${strat.tradeProximityCents} cents).`
        );
      }
    }

    // Check entry conditions
    let entryConditionMet = false;
    let targetPrice;
    if (side === 'long' && entry.candidateHOD !== null) {
      if (
        askPrice >=
        entry.candidateHOD + strat.initialEntryOffsetCents / 100
      ) {
        entryConditionMet = true;
        targetPrice = entry.candidateHOD + strat.initialEntryOffsetCents / 100;
      }
    } else if (side === 'short' && entry.candidateLOD !== null) {
      if (
        bidPrice <=
        entry.candidateLOD - strat.initialEntryOffsetCents / 100
      ) {
        entryConditionMet = true;
        targetPrice = entry.candidateLOD - strat.initialEntryOffsetCents / 100;
      }
    }

    if (
      entryConditionMet &&
      !entry.hasPosition &&
      !entry.hasPendingEntryOrder
    ) {
      const now = Date.now();
      const canPlaceOrder =
        (!entry.lastEntryTime ||
          now - entry.lastEntryTime >
            strat.openingOrderCooldownSeconds * 1000) &&
        !this.positions[upperSym] &&
        !this.hasPendingOpeningOrder(upperSym);

      if (canPlaceOrder) {
        entry.lastEntryTime = now;
        entry.hasPendingEntryOrder = true;
        entry.isHODFrozen = true; // Prevent further HOD/LOD updates during order placement

        this.dashboard.logInfo(
          `Anticipation entry for ${upperSym}: targetPrice=$${targetPrice.toFixed(
            2
          )} (${side})`
        );

        try {
          const orderSide = side === 'long' ? 'buy' : 'sell';
          await this.placeEntryOrder(
            upperSym,
            strat.initialShareSize,
            orderSide,
            targetPrice
          );
        } catch (err) {
          entry.hasPendingEntryOrder = false;
          entry.isHODFrozen = false;
          const errorMsg = `Error placing entry order for ${upperSym}: ${err.message}`;
          logger.error(errorMsg);
          this.dashboard.logError(errorMsg);
        }
      }
    }
  }

  // Handle trade updates
  handleTradeUpdate(sym, price, timestamp) {
    const upperSym = sym.toUpperCase();
    const entry = this.watchlist[upperSym];
    if (!entry) return;

    const side = entry.side; // 'long' or 'short'
    const strat = side === 'long' ? config.longStrategy : config.shortStrategy;

    // For longs: if a trade breaks above HOD + offset, handle similarly to quote update
    // For shorts: if a trade breaks below LOD - offset, handle similarly
    let entryConditionMet = false;
    let targetPrice;

    if (side === 'long') {
      if (price >= entry.highOfDay + strat.initialEntryOffsetCents / 100) {
        entryConditionMet = true;
        targetPrice = entry.highOfDay + strat.initialEntryOffsetCents / 100;
      }
    } else if (side === 'short') {
      if (price <= entry.lowOfDay - strat.initialEntryOffsetCents / 100) {
        entryConditionMet = true;
        targetPrice = entry.lowOfDay - strat.initialEntryOffsetCents / 100;
      }
    }

    if (
      entryConditionMet &&
      !entry.hasPosition &&
      !entry.hasPendingEntryOrder
    ) {
      const now = Date.now();
      const canPlaceOrder =
        (!entry.lastEntryTime ||
          now - entry.lastEntryTime >
            strat.openingOrderCooldownSeconds * 1000) &&
        !this.positions[upperSym] &&
        !this.hasPendingOpeningOrder(upperSym);

      if (canPlaceOrder) {
        entry.lastEntryTime = now;
        entry.hasPendingEntryOrder = true;
        entry.isHODFrozen = true; // Prevent further HOD/LOD updates during order placement

        this.dashboard.logInfo(
          `Anticipation entry for ${upperSym}: targetPrice=$${targetPrice.toFixed(
            2
          )} (${side})`
        );

        try {
          const orderSide = side === 'long' ? 'buy' : 'sell';
          this.placeEntryOrder(
            upperSym,
            strat.initialShareSize,
            orderSide,
            targetPrice
          );
        } catch (err) {
          entry.hasPendingEntryOrder = false;
          entry.isHODFrozen = false;
          const errorMsg = `Error placing entry order for ${upperSym}: ${err.message}`;
          logger.error(errorMsg);
          this.dashboard.logError(errorMsg);
        }
      }
    }

    // Update rolling data
    if (!this.rollingData[upperSym]) {
      this.rollingData[upperSym] = { trades: [] };
    }
    this.rollingData[upperSym].trades.push({ price, timestamp: Date.now() });
  }

  // Check and update trailing stops
  checkRollingStops() {
    const now = Date.now();

    for (const sym in this.positions) {
      const pos = this.positions[sym];
      if (!pos.isActive || pos.qty <= 0) continue;

      const side = pos.side === 'buy' ? 'long' : 'short';
      const strat =
        side === 'long' ? config.longStrategy : config.shortStrategy;

      if (!this.rollingData[sym] || !this.rollingData[sym].trades) continue;

      const cutoff = now - strat.rollingStopWindowSeconds * 1000;
      this.rollingData[sym].trades = this.rollingData[sym].trades.filter(
        (t) => t.timestamp >= cutoff
      );

      if (this.rollingData[sym].trades.length === 0) continue;

      let referencePrice;
      if (side === 'long') {
        // For longs, trailing stop is based on the lowest trade in the window
        referencePrice = this.rollingData[sym].trades.reduce(
          (min, t) => Math.min(min, t.price),
          Infinity
        );
        const trailingStopPrice =
          referencePrice - strat.initialTrailingStopOffsetCents / 100;
        const fallbackStopPrice =
          pos.avgEntryPrice - strat.fallbackStopCents / 100;
        const finalStopPrice = Math.min(trailingStopPrice, fallbackStopPrice);

        if (pos.stopPrice === null || finalStopPrice < pos.stopPrice) {
          pos.stopPrice = finalStopPrice;
          pos.stopDescription = `ROLLING STOP @ $${finalStopPrice.toFixed(2)}`;
          logger.info(
            `Updated rolling stop for ${sym}: $${finalStopPrice.toFixed(2)}`
          );
          this.dashboard.logInfo(
            `Updated rolling stop for ${sym}: $${finalStopPrice.toFixed(2)}`
          );
          this.dashboard.updatePositions(Object.values(this.positions));
        }

        if (pos.currentBid <= finalStopPrice) {
          const stopMsg = `Rolling stop hit for ${sym} at $${finalStopPrice.toFixed(
            2
          )}. Closing position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(sym);
        }
      } else {
        // For shorts, trailing stop is based on the highest trade in the window
        referencePrice = this.rollingData[sym].trades.reduce(
          (max, t) => Math.max(max, t.price),
          -Infinity
        );
        const trailingStopPrice =
          referencePrice + strat.initialTrailingStopOffsetCents / 100;
        const fallbackStopPrice =
          pos.avgEntryPrice + strat.fallbackStopCents / 100;
        const finalStopPrice = Math.max(trailingStopPrice, fallbackStopPrice);

        if (pos.stopPrice === null || finalStopPrice > pos.stopPrice) {
          pos.stopPrice = finalStopPrice;
          pos.stopDescription = `ROLLING STOP @ $${finalStopPrice.toFixed(2)}`;
          logger.info(
            `Updated rolling stop for ${sym}: $${finalStopPrice.toFixed(2)}`
          );
          this.dashboard.logInfo(
            `Updated rolling stop for ${sym}: $${finalStopPrice.toFixed(2)}`
          );
          this.dashboard.updatePositions(Object.values(this.positions));
        }

        if (pos.currentAsk >= finalStopPrice) {
          const stopMsg = `Rolling stop hit for ${sym} at $${finalStopPrice.toFixed(
            2
          )} (short). Closing position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(sym);
        }
      }
    }
  }

  // Check if there is a pending opening order for a symbol
  hasPendingOpeningOrder(sym) {
    for (const orderId in this.orderTracking) {
      const o = this.orderTracking[orderId];
      if (o.symbol === sym && o.type === 'entry') {
        return true;
      }
    }
    return false;
  }

  // Handle updates to active positions based on quote data
  async handlePositionQuoteUpdate(pos, sym, bidPrice, askPrice) {
    const side = pos.side; // 'buy' or 'sell'
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
    pos.currentBid = bidPrice;
    pos.currentAsk = askPrice;
    pos.currentPrice = currentPrice;

    pos.profitCents = (
      (currentPrice - pos.avgEntryPrice) *
      100 *
      (side === 'buy' ? 1 : -1)
    ).toFixed(2);

    const message = `Symbol: ${sym} | Profit: ${
      pos.profitCents
    }¢ | Current Price: $${currentPrice.toFixed(2)}`;
    this.dashboard.logInfo(message);

    // Check if stop is triggered
    if (!pos.stopTriggered && pos.stopPrice !== null) {
      let stopTriggered = false;
      if (side === 'buy') {
        stopTriggered = bidPrice <= pos.stopPrice;
      } else {
        stopTriggered = askPrice >= pos.stopPrice;
      }

      if (stopTriggered) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${sym}. Closing position immediately.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        pos.isProcessing = false;
        await this.closePositionMarketOrder(sym);
        return;
      }
    }

    // Check pyramiding conditions
    if (!pos.isProcessing && pos.qty > 0) {
      await this.checkAndExecutePyramiding(pos, sym, currentPrice);
    }

    // Update dashboard
    this.dashboard.updatePositions(Object.values(this.positions));
  }

  // Check and execute pyramiding orders
  async checkAndExecutePyramiding(pos, sym, currentPrice) {
    const side = pos.side === 'buy' ? 'long' : 'short';
    const strat = side === 'long' ? config.longStrategy : config.shortStrategy;
    const pyramidLevels = strat.pyramidLevels;

    for (let i = 0; i < pyramidLevels.length; i++) {
      const level = pyramidLevels[i];
      if (pos.executedPyramidLevels.includes(i)) continue;

      let conditionMet = false;
      let targetPrice;

      if (side === 'long') {
        targetPrice = pos.avgEntryPrice + level.priceIncreaseCents / 100;
        if (currentPrice >= targetPrice) {
          conditionMet = true;
        }
      } else {
        targetPrice = pos.avgEntryPrice - level.priceIncreaseCents / 100;
        if (currentPrice <= targetPrice) {
          conditionMet = true;
        }
      }

      if (conditionMet) {
        pos.isProcessing = true;
        const qtyToAdd = Math.floor(
          (pos.initialQty * level.percentToAdd) / 100
        );
        if (qtyToAdd > 0) {
          await this.placePyramidOrder(
            pos,
            sym,
            qtyToAdd,
            level.offsetCents,
            targetPrice,
            i
          );
        } else {
          pos.isProcessing = false;
        }
      }
    }
  }

  // Place an entry order
  async placeEntryOrder(sym, qty, side, targetPrice) {
    const entry = this.watchlist[sym];
    if (!entry) return;

    if (this.positions[sym]) {
      const msg = `Cannot place entry order for ${sym} - position already exists.`;
      this.dashboard.logInfo(msg);
      logger.info(msg);
      if (entry) {
        entry.hasPendingEntryOrder = false;
        entry.candidateHOD = null;
        entry.candidateLOD = null;
      }
      return;
    }

    if (this.hasPendingOpeningOrder(sym)) {
      const msg = `Cannot place entry order for ${sym} - pending opening order exists.`;
      this.dashboard.logInfo(msg);
      logger.info(msg);
      if (entry) {
        entry.hasPendingEntryOrder = false;
        entry.candidateHOD = null;
        entry.candidateLOD = null;
      }
      return;
    }

    const strat =
      entry.side === 'long' ? config.longStrategy : config.shortStrategy;
    const entryLimitOffsetCents = strat.entryLimitOffsetCents || 0;
    const limitPrice =
      entry.side === 'long'
        ? targetPrice + entryLimitOffsetCents / 100
        : targetPrice - entryLimitOffsetCents / 100;

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${sym}. Cannot place entry order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      if (entry) {
        entry.hasPendingEntryOrder = false;
        entry.candidateHOD = null;
        entry.candidateLOD = null;
      }
      return;
    }

    const order = {
      symbol: sym,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('ENTRY'),
    };

    const orderMessage = `Placing entry order: ${JSON.stringify(order)}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Entry order placed for ${qty} shares of ${sym} at $${limitPrice.toFixed(
        2
      )}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol: sym,
        type: 'entry',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
        triggerPrice: targetPrice,
        entryOffsetUsed: entryLimitOffsetCents,
      };
    } catch (err) {
      if (entry.side === 'short') {
        // For shorts, if entry order fails, remove symbol from watchlist
        this.removeSymbolFromWatchlist(sym);
        const errorMsg = `Short entry order failed for ${sym}. Symbol removed from watchlist. Error: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`;
        logger.error(errorMsg);
        this.dashboard.logError(errorMsg);
      } else {
        if (entry) {
          entry.hasPendingEntryOrder = false;
          entry.candidateHOD = null;
          entry.candidateLOD = null;
        }
        const errorMsg = `Error placing entry order for ${sym}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`;
        logger.error(errorMsg);
        this.dashboard.logError(errorMsg);
      }
    }
  }

  // Place a pyramiding order
  async placePyramidOrder(
    pos,
    sym,
    qtyToAdd,
    offsetCents,
    targetPrice,
    levelIndex
  ) {
    const side = pos.side;
    const strat = side === 'buy' ? config.longStrategy : config.shortStrategy;
    const limitPrice =
      side === 'buy'
        ? targetPrice + offsetCents / 100
        : targetPrice - offsetCents / 100;

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${sym}. Cannot place ${side} pyramid order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      pos.isProcessing = false;
      return;
    }

    const order = {
      symbol: sym,
      qty: qtyToAdd.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('PYRAMID'),
    };

    const orderMessage = `Placing pyramid order: ${JSON.stringify(
      order
    )} for ${sym}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Pyramid order placed for ${qtyToAdd} shares of ${sym} at $${limitPrice.toFixed(
        2
      )}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol: sym,
        type: 'pyramid',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
        pyramidLevel: levelIndex,
      };

      pos.executedPyramidLevels.push(levelIndex);
    } catch (err) {
      const errorMessage = `Error placing pyramid order for ${sym}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    } finally {
      pos.isProcessing = false;
    }
  }

  // Close a position with a market order (implemented as limit order for control)
  async closePositionMarketOrder(sym) {
    const pos = this.positions[sym];
    if (!pos) {
      const warnMessage = `No position found for ${sym} when attempting to close.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    const qty = pos.qty;
    if (qty <= 0) {
      const warnMessage = `Position qty ${qty} for ${sym}, nothing to close.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    const side = pos.side === 'buy' ? 'sell' : 'buy';
    const strat =
      pos.side === 'buy' ? config.longStrategy : config.shortStrategy;
    const limitOffsetCents = strat.limitOffsetCents || 0;

    let limitPrice;
    if (pos.side === 'buy') {
      // Long close: use currentBid - offset
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    } else {
      // Short close: use currentAsk + offset
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
    }

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${sym}. Cannot place ${side} close order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      return;
    }

    const order = {
      symbol: sym,
      qty: qty.toFixed(0),
      side,
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
      const successMessage = `Limit order placed to close position in ${sym}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol: sym,
        type: 'close',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
      };
    } catch (err) {
      const errorMessage = `Error placing close order for ${sym}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  // Poll and update order statuses
  async pollOrderStatuses() {
    if (this.isPolling) return;
    this.isPolling = true;

    const { orderTimeouts } = config;
    try {
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open' })
      );
      this.dashboard.updateOrders(openOrders);

      const openOrderIds = new Set(openOrders.map((o) => o.id));
      const now = Date.now();

      for (const orderId in this.orderTracking) {
        const trackedOrder = this.orderTracking[orderId];

        if (!openOrderIds.has(orderId)) {
          // Order is no longer open
          delete this.orderTracking[orderId];
          if (trackedOrder.type === 'entry') {
            const entry = this.watchlist[trackedOrder.symbol];
            if (entry) {
              entry.hasPendingEntryOrder = false;
              entry.isHODFrozen = false;
              entry.candidateHOD = null;
              entry.candidateLOD = null;
            }
          }
          continue;
        }

        const elapsed = now - trackedOrder.placedAt;
        let timeoutMs = orderTimeouts[trackedOrder.type];
        if (!timeoutMs) timeoutMs = 4000; // Default timeout

        if (timeoutMs && elapsed > timeoutMs) {
          // Cancel the order due to timeout
          await this.cancelOrder(orderId, trackedOrder.symbol);

          if (trackedOrder.type === 'close') {
            await this.closePositionMarketOrder(trackedOrder.symbol);
          }

          if (trackedOrder.type === 'entry') {
            const entry = this.watchlist[trackedOrder.symbol];
            if (entry) {
              entry.hasPendingEntryOrder = false;
              entry.isHODFrozen = false;
              entry.candidateHOD = null;
              entry.candidateLOD = null;

              // If it's a short entry, remove symbol from watchlist on failure
              if (entry.side === 'short') {
                this.removeSymbolFromWatchlist(trackedOrder.symbol);
              }
            }
          }
        }
      }

      // Handle partial fills
      for (const order of openOrders) {
        const trackedOrder = this.orderTracking[order.id];
        if (!trackedOrder) continue;

        const filledQty = parseFloat(order.filled_qty || '0');
        if (filledQty > 0) {
          trackedOrder.filledQty = filledQty;

          const pos = this.positions[trackedOrder.symbol];
          if (pos) {
            if (
              trackedOrder.type === 'limit' ||
              trackedOrder.type === 'close'
            ) {
              pos.qty -= filledQty;
              pos.qty = Math.max(pos.qty, 0);
              const fillMsg = `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining: ${pos.qty}`;
              logger.info(fillMsg);
              this.dashboard.logInfo(fillMsg);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);
              this.dashboard.updatePositions(Object.values(this.positions));

              if (pos.qty <= 0) {
                this.removePosition(trackedOrder.symbol);
              }
            } else if (trackedOrder.type === 'pyramid') {
              pos.qty += filledQty;
              const newAvg =
                (pos.avgEntryPrice * pos.initialQty +
                  filledQty * parseFloat(order.limit_price)) /
                (pos.initialQty + filledQty);
              pos.avgEntryPrice = newAvg;

              const fillMsg = `Pyramid order ${
                order.id
              } filled ${filledQty} qty for ${trackedOrder.symbol}. New qty: ${
                pos.qty
              }, Avg Entry: $${pos.avgEntryPrice.toFixed(2)}`;
              logger.info(fillMsg);
              this.dashboard.logInfo(fillMsg);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);
              this.dashboard.updatePositions(Object.values(this.positions));

              if (trackedOrder.pyramidLevel !== undefined) {
                pos.executedPyramidLevels.push(trackedOrder.pyramidLevel);
              }
              pos.isProcessing = false;
            } else if (trackedOrder.type === 'entry') {
              pos.qty += filledQty;
              const newAvg =
                (pos.avgEntryPrice * pos.initialQty +
                  filledQty * parseFloat(order.limit_price)) /
                (pos.initialQty + filledQty);
              pos.avgEntryPrice = newAvg;

              const fillMsg = `Entry order ${
                order.id
              } filled ${filledQty} qty for ${trackedOrder.symbol}. New qty: ${
                pos.qty
              }, Avg Entry: $${pos.avgEntryPrice.toFixed(2)}`;
              logger.info(fillMsg);
              this.dashboard.logInfo(fillMsg);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);
              this.dashboard.updatePositions(Object.values(this.positions));

              const entry = this.watchlist[trackedOrder.symbol];
              if (entry) {
                entry.hasPendingEntryOrder = false;
                entry.isHODFrozen = false;
                // Do not reset candidateHOD/LOD here to allow for pyramiding or future entries
              }
            }
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

  // Cancel an order
  async cancelOrder(orderId, sym) {
    try {
      await this.retryOperation(() => this.limitedCancelOrder(orderId));
      logger.info(`Order ${orderId} canceled for ${sym}.`);
      this.dashboard.logInfo(`Order ${orderId} canceled for ${sym}.`);
      delete this.orderTracking[orderId];
    } catch (err) {
      const errorMsg = `Error canceling order ${orderId} for ${sym}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  // Refresh positions from Alpaca and sync with internal state
  async refreshPositions() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      const latestPositions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      const latestPositionMap = {};
      latestPositions.forEach((position) => {
        latestPositionMap[position.symbol.toUpperCase()] = position;
      });

      for (const sym in this.positions) {
        const upperSym = sym.toUpperCase();
        if (latestPositionMap[upperSym]) {
          const latestQty = Math.abs(
            parseFloat(latestPositionMap[upperSym].qty)
          );
          const latestAvgEntryPrice = parseFloat(
            latestPositionMap[upperSym].avg_entry_price
          );
          const pos = this.positions[upperSym];

          pos.qty = latestQty;
          pos.avgEntryPrice = latestAvgEntryPrice;
          pos.currentBid =
            parseFloat(latestPositionMap[upperSym].current_price) - 0.01;
          pos.currentAsk =
            parseFloat(latestPositionMap[upperSym].current_price) + 0.01;
          pos.currentPrice = parseFloat(
            latestPositionMap[upperSym].current_price
          );
          pos.profitCents = (
            (pos.currentPrice - pos.avgEntryPrice) *
            100 *
            (pos.side === 'buy' ? 1 : -1)
          ).toFixed(2);

          if (latestQty === 0) {
            this.removePosition(upperSym);
            if (this.watchlist[upperSym]) {
              this.watchlist[upperSym].candidateHOD = null;
              this.watchlist[upperSym].candidateLOD = null;
            }
          }
        } else {
          // Position no longer exists
          this.removePosition(sym);
          if (this.watchlist[sym]) {
            this.watchlist[sym].candidateHOD = null;
            this.watchlist[sym].candidateLOD = null;
          }
        }
      }

      // Add any new positions that weren't previously tracked
      latestPositions.forEach((position) => {
        const sym = position.symbol.toUpperCase();
        if (!this.positions[sym]) {
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

      // Update watchlist's hasPosition flags
      for (const sym in this.watchlist) {
        this.watchlist[sym].hasPosition = !!this.positions[sym];
      }
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  // Retry mechanism with exponential backoff
  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (
        err.code === 'ENOTFOUND' ||
        (err.response &&
          (err.response.status === 429 ||
            (err.response.status >= 500 && err.response.status < 600)))
      ) {
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        let message = '';

        if (err.code === 'ENOTFOUND') {
          message = `DNS resolution failed. Retrying in ${totalDelay.toFixed(
            0
          )}ms...`;
        } else if (err.response && err.response.status === 429) {
          message = `Rate limit hit. Retrying in ${totalDelay.toFixed(0)}ms...`;
        } else if (
          err.response &&
          err.response.status >= 500 &&
          err.response.status < 600
        ) {
          message = `Server error ${
            err.response.status
          }. Retrying in ${totalDelay.toFixed(0)}ms...`;
        }

        logger.warn(message);
        this.dashboard.logWarning(message);
        await this.sleep(totalDelay);
        return this.retryOperation(operation, retries - 1, delay * 2);
      }
      throw err;
    }
  }

  // Sleep helper
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Generate unique client order ID
  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  // Remove a symbol from the watchlist
  removeSymbolFromWatchlist(sym) {
    const entry = this.watchlist[sym];
    if (!entry) return;
    if (!this.positions[sym]) {
      if (entry.isSubscribedToTrade) this.polygon.unsubscribeTrade(sym);
      this.polygon.unsubscribeQuote(sym);
      delete this.watchlist[sym];
      const message = `Symbol ${sym} removed from watchlist.`;
      logger.info(message);
      this.dashboard.logInfo(message);
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }
}

module.exports = OrderManager;
