const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const Bottleneck = require('bottleneck');
const PolygonRestClient = require('./polygonRestClient');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

class OrderQueue {
  constructor() {
    this.queue = [];
  }

  addOrder(order, priority) {
    this.queue.push({ order, priority });
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  getNextOrder() {
    return this.queue.shift();
  }

  isEmpty() {
    return this.queue.length === 0;
  }
}

class OrderManager {
  constructor(dashboard, polygon) {
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.positions = {};
    this.watchlist = {};
    this.orderTracking = {};
    this.restClient = new PolygonRestClient();

    this.overrideAddList = new Set(
      (config.overrideAddSymbols || []).map((sym) => sym.toUpperCase())
    );
    this.overrideRemoveList = new Set(
      (config.overrideRemoveSymbols || []).map((sym) => sym.toUpperCase())
    );

    // Store latest polygon quotes for stop checks
    this.latestQuotes = {};

    this.limiter = new Bottleneck({
      minTime: 350,
      maxConcurrent: 1,
    });

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

    this.isRefreshing = false;
    this.isPolling = false;

    this.orderQueue = new OrderQueue();
    this.processingOrder = false;

    this.initializeExistingPositions();
    this.initializeWatchlist();

    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(
      () => this.refreshPositions(),
      config.pollingIntervals.positionRefresh
    );
    setInterval(
      () => this.initializeWatchlist(),
      config.pollingIntervals.watchlistRefresh
    );
    setInterval(
      () => this.reloadDynamicOverrides(),
      config.pollingIntervals.watchlistRefresh
    );
    setInterval(
      () => this.saveSystemState(),
      config.statePersistence.saveInterval
    );
  }

  async loadSystemState() {
    const statePath = config.statePersistence.stateFilePath;
    if (fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      this.positions = data.positions || {};
      this.watchlist = data.watchlist || {};
      this.orderTracking = data.orderTracking || {};
      this.dashboard.logInfo('Loaded previous state from disk.');
      logger.info('Loaded previous state from disk.');
    }
  }

  async saveSystemState() {
    const state = {
      positions: this.positions,
      watchlist: this.watchlist,
      orderTracking: this.orderTracking,
    };
    fs.writeFileSync(
      config.statePersistence.stateFilePath,
      JSON.stringify(state, null, 2)
    );
    this.dashboard.logInfo('Saved current state to disk.');
    logger.info('Saved current state to disk.');
  }

  async processOrderQueue() {
    if (this.processingOrder) return;
    this.processingOrder = true;
    while (!this.orderQueue.isEmpty()) {
      const { order, priority } = this.orderQueue.getNextOrder();
      try {
        const result = await this.retryOperation(() =>
          this.limitedCreateOrder(order)
        );
        const successMessage = `Order placed [${order.client_order_id}] for ${
          order.symbol
        }: ${JSON.stringify(order)}`;
        logger.info(successMessage);
        this.dashboard.logInfo(successMessage);

        this.orderTracking[result.id] = {
          symbol: order.symbol,
          type: order.client_order_id.includes('CLOSE')
            ? 'close'
            : order.client_order_id.includes('ENTRY')
            ? 'entry'
            : order.client_order_id.includes('PYRAMID')
            ? 'pyramid'
            : 'limit',
          qty: parseFloat(order.qty),
          side: order.side,
          filledQty: 0,
          placedAt: Date.now(),
        };

        if (this.orderTracking[result.id].type === 'entry') {
          this.orderTracking[result.id].triggerPrice = parseFloat(
            order.limit_price
          );
        }

        await this.refreshPositions();
      } catch (err) {
        const errorMessage = `Error placing order [${
          order.client_order_id
        }] for ${order.symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`;
        logger.error(errorMessage);
        this.dashboard.logError(errorMessage);
      }
    }
    this.processingOrder = false;
  }

  enqueueOrder(order, priority) {
    this.orderQueue.addOrder(order, priority);
    this.processOrderQueue();
  }

  reloadDynamicOverrides() {
    const dynamicConfigPath = path.join(__dirname, 'dynamicConfig.json');
    try {
      if (fs.existsSync(dynamicConfigPath)) {
        const data = fs.readFileSync(dynamicConfigPath, 'utf-8');
        const dynamicConfig = JSON.parse(data);

        const newAddSymbols = (dynamicConfig.overrideAddSymbols || []).map(
          (s) => s.toUpperCase()
        );
        const newRemoveSymbols = (
          dynamicConfig.overrideRemoveSymbols || []
        ).map((s) => s.toUpperCase());

        this.overrideAddList = new Set(newAddSymbols);
        this.overrideRemoveList = new Set(newRemoveSymbols);

        this.dashboard.logInfo(
          'Dynamic config reloaded. Updated override add/remove symbols.'
        );
        logger.info('Dynamic config reloaded. Updated override symbols.');
        this.applyOverridesToWatchlist();
      }
    } catch (err) {
      const msg = `Error reloading dynamic config: ${err.message}`;
      logger.error(msg);
      this.dashboard.logError(msg);
    }
  }

  applyOverridesToWatchlist() {
    for (const symbol of this.overrideRemoveList) {
      if (this.watchlist[symbol]) {
        if (!this.positions[symbol]) {
          this.polygon.unsubscribeTrade(symbol);
          this.polygon.unsubscribeQuote(symbol);
        }
        delete this.watchlist[symbol];
        this.dashboard.logInfo(
          `Symbol ${symbol} removed from watchlist due to override remove list.`
        );
      }
    }

    for (const symbol of this.overrideAddList) {
      if (!this.watchlist[symbol]) {
        const hod = null;
        this.watchlist[symbol] = {
          highOfDay: hod,
          lastEntryTime: null,
          hasPosition: !!this.positions[symbol],
          hasPendingEntryOrder: false,
          isHODFrozen: false,
          executedPyramidLevels: [],
          isSubscribedToTrade: false,
          isHalted: false,
          lastHaltTime: null,
        };
        this.polygon.subscribeQuote(symbol);
        this.dashboard.logInfo(
          `Symbol ${symbol} added to watchlist due to override add list.`
        );
      }
    }

    this.dashboard.updateWatchlist(this.watchlist);
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

  async initializeWatchlist() {
    try {
      const gainers = await this.restClient.getGainersOrLosers(
        'gainers',
        false
      );
      const currentVolumeRequirement = this.getCurrentVolumeRequirement();
      const topGainers = {};

      for (const g of gainers) {
        const symbol = g.ticker.toUpperCase();
        if (symbol.includes('.')) continue;

        const gapPerc = g.todaysChangePerc;
        if (gapPerc < config.strategySettings.gapPercentageRequirement)
          continue;

        const currentPrice = g.lastQuote.P || 0;
        if (
          currentPrice < config.strategySettings.priceRange.min ||
          currentPrice > config.strategySettings.priceRange.max
        )
          continue;

        const volume = g.min.v || 0;
        topGainers[symbol] = {
          symbol,
          dayClose: currentPrice,
          gapPerc,
          volume,
        };

        if (volume >= currentVolumeRequirement) {
          await this.addSymbolToWatchlist(symbol);
        }
      }

      this.applyOverridesToWatchlist();

      for (const symbol in this.watchlist) {
        if (!topGainers[symbol] && !this.overrideAddList.has(symbol)) {
          this.removeSymbolFromWatchlist(symbol);
        }
      }

      this.dashboard.updateWatchlist(this.watchlist);
      this.dashboard.logInfo(
        `Watchlist updated. Monitoring ${
          Object.keys(this.watchlist).length
        } symbols.`
      );
    } catch (err) {
      const msg = `Error updating watchlist: ${err.message}`;
      logger.error(msg);
      this.dashboard.logError(msg);
    }
  }

  async addSymbolToWatchlist(symbol) {
    try {
      const hod = await this.restClient.getIntradayHigh(symbol);
      if (!this.watchlist[symbol]) {
        this.watchlist[symbol] = {
          highOfDay: hod,
          lastEntryTime: null,
          hasPosition: !!this.positions[symbol],
          hasPendingEntryOrder: false,
          isHODFrozen: false,
          executedPyramidLevels: [],
          isSubscribedToTrade: false,
          isHalted: false,
          lastHaltTime: null,
        };
        this.polygon.subscribeQuote(symbol);
      } else {
        this.watchlist[symbol].highOfDay = hod;
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
      }
      this.dashboard.updateWatchlist(this.watchlist);
    } catch (err) {
      const errorMsg = `Error adding symbol ${symbol} to watchlist: ${err.message}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  removeSymbolFromWatchlist(symbol) {
    if (this.watchlist[symbol] && !this.positions[symbol]) {
      this.polygon.unsubscribeTrade(symbol);
      this.polygon.unsubscribeQuote(symbol);
      delete this.watchlist[symbol];
      this.dashboard.logInfo(`Symbol ${symbol} removed from watchlist.`);
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  getCurrentVolumeRequirement() {
    const now = moment().tz(config.timeZone);
    const hour = now.hour();
    const minute = now.minute();
    const { baseVolumeRequirement, morningVolumeRequirement } =
      config.strategySettings;

    if (hour < 9 || (hour === 9 && minute < 30)) {
      return baseVolumeRequirement;
    }

    if (
      (hour === 9 && minute >= 30) ||
      hour === 10 ||
      (hour === 11 && minute === 0)
    ) {
      return morningVolumeRequirement;
    }

    if (hour > 11 || (hour === 11 && minute > 0)) {
      return baseVolumeRequirement;
    }

    return baseVolumeRequirement;
  }

  /**
   * Add a position. Before any profit targets are hit, the initial stop is set based on HOD.
   * After hitting the first profit target, subsequent stops reference the avgEntryPrice.
   */
  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = 'buy'; // Only long side supported
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    const w = this.watchlist[symbol];
    if (!w) {
      const msg = `Watchlist entry missing for ${symbol} while adding position.`;
      logger.warn(msg);
      this.dashboard.logWarning(msg);
      return;
    }

    const hod = w.highOfDay;
    if (!hod) {
      const msg = `High of Day missing for ${symbol} while adding position.`;
      logger.warn(msg);
      this.dashboard.logWarning(msg);
      return;
    }

    const initialStopOffsetCents =
      config.strategySettings.initialStopOffsetCents;
    const initialStopPrice = hod - initialStopOffsetCents / 100;

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
      attemptHOD: hod,
      stopPrice: initialStopPrice,
      stopCents: initialStopOffsetCents,
      stopDescription: `Initial Stop @ $${initialStopPrice.toFixed(
        2
      )} (${initialStopOffsetCents}¢ below HOD)`,
      stopTriggered: false,
      executedPyramidLevels: [],
      totalPyramidLevels: config.orderSettings.pyramidLevels.length,
      trailingStopActive: false,
      trailingStopPrice: null,
      trailingStopMaxPrice: null,
      trailingStopLastUpdatePrice: null,
    };

    const message = `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice} | Initial Stop: $${initialStopPrice.toFixed(
      2
    )}`;
    logger.info(message);
    this.dashboard.logInfo(message);

    this.polygon.subscribeQuote(symbol);
    this.dashboard.updatePositions(Object.values(this.positions));

    if (this.watchlist[symbol]) {
      this.watchlist[symbol].hasPosition = true;
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  removePosition(symbol) {
    if (this.positions[symbol]) {
      delete this.positions[symbol];
      const message = `Position removed: ${symbol}`;
      logger.info(message);
      this.dashboard.logInfo(message);

      if (!this.watchlist[symbol]) {
        this.polygon.unsubscribeTrade(symbol);
        this.polygon.unsubscribeQuote(symbol);
      }

      this.dashboard.updatePositions(Object.values(this.positions));

      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPosition = false;
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }
  }

  async updateHaltStatus(symbol) {
    const snapshot = await this.restClient.getTickerDetails(symbol);
    if (snapshot && snapshot.market_status === 'halted') {
      if (!this.watchlist[symbol].isHalted) {
        this.watchlist[symbol].isHalted = true;
        this.watchlist[symbol].lastHaltTime = Date.now();
        this.dashboard.logInfo(`${symbol} is halted.`);
      }
    } else {
      if (this.watchlist[symbol].isHalted) {
        this.watchlist[symbol].isHalted = false;
        this.dashboard.logInfo(`${symbol} resumed trading.`);
      }
    }
  }

  async fetchRecentBars(symbol, timeframe, limit) {
    const now = new Date().toISOString();
    const from = moment().subtract(30, 'minutes').toISOString();
    try {
      const bars = await alpaca.getBars(timeframe, [symbol], {
        start: from,
        end: now,
        limit: limit,
      });
      return bars[symbol] || [];
    } catch (err) {
      logger.error(`Error fetching bars for ${symbol}: ${err.message}`);
      return [];
    }
  }

  async canEnterPosition(symbol, currentPrice) {
    const bars = await this.fetchRecentBars(symbol, '5Min', 5);
    if (!bars || bars.length === 0) return false;

    const recentBar = bars[bars.length - 1];
    const range = recentBar.high - recentBar.low;

    const above10 = currentPrice > 10;
    const minRange = above10
      ? config.strategySettings.highPriceVolatilityThreshold
      : config.strategySettings.lowPriceVolatilityThreshold;

    if (range < minRange) {
      this.dashboard.logInfo(
        `${symbol}: Insufficient recent 5-min range (${range.toFixed(
          2
        )}) for entry. Skipping.`
      );
      return false;
    }

    return true;
  }

  onQuote = async (symbol, bidPrice, askPrice) => {
    // Store the latest polygon quote for stop checks
    this.latestQuotes[symbol] = { bidPrice, askPrice };

    await this.onQuoteUpdate(symbol, bidPrice, askPrice);
  };

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const w = this.watchlist[symbol];
    if (!w) return;

    await this.updateHaltStatus(symbol);
    if (w.isHalted) {
      return;
    }

    const currentPrice = askPrice;
    if (currentPrice > w.highOfDay && !w.isHODFrozen) {
      try {
        const newHod = await this.restClient.getIntradayHigh(symbol);
        if (newHod && newHod > w.highOfDay) {
          w.highOfDay = newHod;
          this.dashboard.logInfo(
            `HOD updated for ${symbol}: $${newHod.toFixed(2)}`
          );
          this.dashboard.updateWatchlist(this.watchlist);
        }
      } catch (err) {
        const errorMsg = `Error updating HOD for ${symbol}: ${err.message}`;
        logger.error(errorMsg);
        this.dashboard.logError(errorMsg);
      }
    }

    const distanceToHODCents = (w.highOfDay - currentPrice) * 100;
    if (distanceToHODCents <= 20 && !w.isSubscribedToTrade) {
      this.polygon.subscribeTrade(symbol);
      w.isSubscribedToTrade = true;
      this.dashboard.logInfo(`Subscribed to trade-level data for ${symbol}.`);
    } else if (distanceToHODCents > 20 && w.isSubscribedToTrade) {
      this.polygon.unsubscribeTrade(symbol);
      w.isSubscribedToTrade = false;
      this.dashboard.logInfo(
        `Unsubscribed from trade-level data for ${symbol}.`
      );
    }

    if (w.isHalted) return;
    if (
      w.lastHaltTime &&
      Date.now() - w.lastHaltTime <
        config.strategySettings.allowedAfterHaltCooldownSeconds * 1000
    ) {
      return;
    }

    // Check stops on each quote update using polygon's live bid/ask
    const pos = this.positions[symbol];
    if (pos) {
      await this.checkStopCondition(pos, symbol);
    }

    if (!w.hasPosition && currentPrice >= w.highOfDay) {
      const now = Date.now();
      const openingOrderCooldownMs =
        config.strategySettings.openingOrderCooldownSeconds * 1000;
      const canPlaceOrder =
        (!w.lastEntryTime || now - w.lastEntryTime > openingOrderCooldownMs) &&
        !this.positions[symbol] &&
        !this.hasPendingOpeningOrder(symbol) &&
        !w.hasPendingEntryOrder;

      if (canPlaceOrder) {
        const canEnter = await this.canEnterPosition(symbol, currentPrice);
        if (!canEnter) return;

        w.lastEntryTime = Date.now();
        w.hasPendingEntryOrder = true;
        w.isHODFrozen = true;
        const targetPrice = w.highOfDay;
        this.dashboard.logInfo(
          `Anticipation entry for ${symbol}: targetPrice=$${targetPrice.toFixed(
            2
          )}, HOD=$${w.highOfDay.toFixed(2)}`
        );
        await this.placeEntryOrder(
          symbol,
          config.strategySettings.initialShareSize,
          'buy',
          targetPrice
        );
      }
    }
  }

  async onTradeUpdate(symbol, price, size, timestamp) {
    // Optional trade-level logic
  }

  hasPendingOpeningOrder(symbol) {
    for (const orderId in this.orderTracking) {
      const o = this.orderTracking[orderId];
      if (o.symbol === symbol && o.type === 'entry') {
        return true;
      }
    }
    return false;
  }

  syncProfitTargetsOnStartup(pos) {
    const profitTargets = config.orderSettings.profitTargets;
    const currentProfitCents = parseFloat(pos.profitCents);

    let newlyHitTargets = 0;
    for (let i = 0; i < profitTargets.length; i++) {
      const target = profitTargets[i];
      if (currentProfitCents >= target.targetCents) {
        newlyHitTargets = i + 1;
      } else {
        break;
      }
    }

    if (newlyHitTargets > pos.profitTargetsHit) {
      this.dashboard.logInfo(
        `Position ${
          pos.symbol
        }: Current profit ${currentProfitCents}¢ surpasses ${
          newlyHitTargets - pos.profitTargetsHit
        } previously unhit profit targets. Synchronizing state...`
      );
      pos.profitTargetsHit = newlyHitTargets;

      const dynamicStop = this.calculateDynamicStopPrice(
        pos.profitTargetsHit,
        pos.avgEntryPrice
      );
      if (dynamicStop) {
        pos.stopPrice = dynamicStop.stopPrice;
        pos.stopCents = dynamicStop.stopCents;
        pos.stopDescription = `Stop adjusted @ $${pos.stopPrice.toFixed(
          2
        )} after syncing profit targets`;
        this.dashboard.logInfo(
          `Adjusted stop price for ${pos.symbol} to $${pos.stopPrice.toFixed(
            2
          )} after syncing.`
        );
      }

      const totalTargets = profitTargets.length;
      if (
        pos.profitTargetsHit >= totalTargets &&
        pos.qty > 0 &&
        !pos.trailingStopActive
      ) {
        pos.trailingStopActive = true;
        pos.trailingStopMaxPrice = pos.currentPrice;
        pos.trailingStopLastUpdatePrice = pos.currentPrice;
        const offsetCents =
          config.strategySettings.initialTrailingStopOffsetCents;
        pos.trailingStopPrice = pos.trailingStopMaxPrice - offsetCents / 100;
        pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(
          2
        )}`;
        const initMsg = `Trailing stop activated for ${
          pos.symbol
        } at $${pos.trailingStopPrice.toFixed(2)} after syncing.`;
        this.dashboard.logInfo(initMsg);
      }
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
        latestPositionMap[position.symbol.toUpperCase()] = position;
      });

      for (const symbol in this.positions) {
        const upperSymbol = symbol.toUpperCase();
        if (latestPositionMap[upperSymbol]) {
          const latestQty = Math.abs(
            parseFloat(latestPositionMap[upperSymbol].qty)
          );
          const latestAvgEntryPrice = parseFloat(
            latestPositionMap[upperSymbol].avg_entry_price
          );
          const pos = this.positions[upperSymbol];

          pos.qty = latestQty;
          pos.avgEntryPrice = latestAvgEntryPrice;
          pos.currentBid =
            parseFloat(latestPositionMap[upperSymbol].current_price) - 0.01;
          pos.currentAsk =
            parseFloat(latestPositionMap[upperSymbol].current_price) + 0.01;
          pos.currentPrice = parseFloat(
            latestPositionMap[upperSymbol].current_price
          );
          pos.profitCents = (
            (pos.currentPrice - pos.avgEntryPrice) *
            100
          ).toFixed(2);

          if (pos.trailingStopActive) {
            pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(
              2
            )}`;
          }

          // Sync profit targets if price already surpassed some on restart
          this.syncProfitTargetsOnStartup(pos);

          if (latestQty === 0) {
            this.removePosition(upperSymbol);
          }
        } else {
          this.removePosition(symbol);
        }
      }

      latestPositions.forEach((position) => {
        const symbol = position.symbol.toUpperCase();
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

      for (const symbol in this.watchlist) {
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
      }
      this.dashboard.updateWatchlist(this.watchlist);

      // After refreshing, check stop conditions immediately
      await this.checkAllPositionsStops();
    }
  }

  /**
   * Checks stop conditions for all positions after refresh using the best available price data.
   */
  async checkAllPositionsStops() {
    for (const symbol in this.positions) {
      const pos = this.positions[symbol];
      await this.checkStopCondition(pos, symbol);
    }
  }

  /**
   * Checks if a position has breached its stop threshold and closes it immediately if so.
   * Uses Polygon's live quotes if available; otherwise falls back to pos.currentPrice from Alpaca as a fallback at startup.
   */
  async checkStopCondition(pos, symbol) {
    let evaluationPrice;

    // Prefer polygon quotes if available
    if (this.latestQuotes[symbol]) {
      // For longs, stop checks are typically done on the bid price to ensure we can execute a close at that price or better
      evaluationPrice = this.latestQuotes[symbol].bidPrice;
    } else {
      // Fallback to Alpaca's last known currentPrice if no polygon quote is available yet (e.g., at startup)
      evaluationPrice = pos.currentPrice;
    }

    if (!evaluationPrice || isNaN(evaluationPrice)) return;

    // If stop conditions are met, close position immediately
    if (
      pos.side === 'buy' &&
      evaluationPrice <= pos.stopPrice &&
      !pos.stopTriggered
    ) {
      pos.stopTriggered = true;
      const stopMsg = `Stop condition met for ${symbol}. Closing position at $${evaluationPrice.toFixed(
        2
      )} <= stopPrice $${pos.stopPrice.toFixed(2)}.`;
      logger.info(stopMsg);
      this.dashboard.logWarning(stopMsg);
      await this.closePositionMarketOrder(symbol);
    }
  }

  async cancelOrder(orderId, symbol) {
    try {
      await this.retryOperation(() => this.limitedCancelOrder(orderId));
      logger.info(`Order ${orderId} canceled for ${symbol}.`);
      this.dashboard.logInfo(`Order ${orderId} canceled for ${symbol}.`);
      delete this.orderTracking[orderId];
    } catch (err) {
      const errorMsg = `Error canceling order ${orderId} for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  async closePositionMarketOrder(symbol) {
    const pos = this.positions[symbol];
    if (!pos || pos.qty <= 0) return;

    const side = 'sell';
    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    let limitPrice = pos.currentBid - limitOffsetCents / 100;
    if (limitPrice <= 0 || isNaN(limitPrice)) return;

    const order = {
      symbol,
      qty: pos.qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('CLOSE'),
    };

    this.enqueueOrder(order, 1);
  }

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
          if (trackedOrder.type === 'entry') {
            if (this.watchlist[trackedOrder.symbol]) {
              this.watchlist[trackedOrder.symbol].hasPendingEntryOrder = false;
              this.watchlist[trackedOrder.symbol].isHODFrozen = false;
            }
          }

          delete this.orderTracking[orderId];
          continue;
        }

        const elapsed = now - trackedOrder.placedAt;
        let timeoutMs = orderTimeouts[trackedOrder.type] || orderTimeouts.limit;

        if (timeoutMs && elapsed > timeoutMs) {
          await this.cancelOrder(orderId, trackedOrder.symbol);
          if (trackedOrder.type === 'close') {
            await this.closePositionMarketOrder(trackedOrder.symbol);
          }
          if (trackedOrder.type === 'entry') {
            if (this.watchlist[trackedOrder.symbol]) {
              this.watchlist[trackedOrder.symbol].hasPendingEntryOrder = false;
              this.watchlist[trackedOrder.symbol].isHODFrozen = false;
            }
          }
        }
      }

      for (const order of openOrders) {
        const trackedOrder = this.orderTracking[order.id];
        if (trackedOrder) {
          const filledQty = parseFloat(order.filled_qty || '0');
          trackedOrder.filledQty = filledQty;

          const pos = this.positions[trackedOrder.symbol];
          if (pos && filledQty > 0) {
            if (
              trackedOrder.type === 'limit' ||
              trackedOrder.type === 'close'
            ) {
              pos.qty -= filledQty;
              pos.qty = Math.max(pos.qty, 0);
              if (pos.qty <= 0) this.removePosition(trackedOrder.symbol);
              this.dashboard.updatePositions(Object.values(this.positions));
            } else if (
              trackedOrder.type === 'pyramid' ||
              trackedOrder.type === 'entry'
            ) {
              const oldQty = pos.qty;
              pos.qty = oldQty + filledQty;
              const totalCost =
                pos.avgEntryPrice * oldQty +
                filledQty * parseFloat(order.limit_price || pos.currentPrice);
              pos.avgEntryPrice = totalCost / pos.qty;

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100
              ).toFixed(2);
              this.dashboard.updatePositions(Object.values(this.positions));

              if (trackedOrder.type === 'entry') {
                if (this.watchlist[trackedOrder.symbol]) {
                  this.watchlist[
                    trackedOrder.symbol
                  ].hasPendingEntryOrder = false;
                  this.watchlist[trackedOrder.symbol].isHODFrozen = false;
                }
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

  calculateDynamicStopPrice(profitTargetsHit, avgEntryPrice) {
    const dynamicStops = config.orderSettings.dynamicStops
      .filter((ds) => ds.profitTargetsHit <= profitTargetsHit)
      .sort((a, b) => b.profitTargetsHit - a.profitTargetsHit);

    if (dynamicStops.length > 0) {
      const dynamicStop = dynamicStops[0];
      const stopCents = dynamicStop.stopCents;
      const stopPrice = avgEntryPrice - stopCents / 100;
      return { stopPrice, stopCents };
    } else {
      return null;
    }
  }

  async checkAndExecutePyramiding(pos, symbol, currentPrice) {
    const pyramidLevels = config.orderSettings.pyramidLevels;
    for (let i = 0; i < pyramidLevels.length; i++) {
      const level = pyramidLevels[i];
      if (pos.executedPyramidLevels.includes(i)) continue;

      const requiredPriceIncrease = level.priceIncreaseCents / 100;
      const targetPrice = pos.avgEntryPrice + requiredPriceIncrease;
      if (pos.side === 'buy' && currentPrice >= targetPrice) {
        const qtyToAdd = Math.floor(
          (pos.initialQty * level.percentToAdd) / 100
        );
        if (qtyToAdd > 0) {
          await this.placePyramidOrder(
            pos,
            qtyToAdd,
            level.offsetCents,
            targetPrice,
            i
          );
          pos.executedPyramidLevels.push(i);
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }
  }

  async placePyramidOrder(pos, qtyToAdd, offsetCents, targetPrice, levelIndex) {
    const symbol = pos.symbol;
    const side = 'buy';
    let limitPrice = targetPrice + offsetCents / 100;
    if (limitPrice <= 0 || isNaN(limitPrice)) return;

    const order = {
      symbol,
      qty: qtyToAdd.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('PYRAMID'),
    };

    this.dashboard.logInfo(`Queueing pyramid order for ${symbol}...`);
    this.enqueueOrder(order, 2);
  }

  async placeLimitOrder(symbol, qty, side) {
    const pos = this.positions[symbol];
    if (!pos) return;
    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    let limitPrice =
      side === 'buy'
        ? pos.currentAsk + limitOffsetCents / 100
        : pos.currentBid - limitOffsetCents / 100;

    if (limitPrice <= 0 || isNaN(limitPrice)) return;

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('LIMIT'),
    };

    this.enqueueOrder(order, 2);
  }

  async placeEntryOrder(symbol, qty, side, targetPrice) {
    if (this.positions[symbol]) {
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      return;
    }
    if (this.hasPendingOpeningOrder(symbol)) {
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      return;
    }

    const entryLimitOffsetCents =
      config.strategySettings.entryLimitOffsetCents || 0;
    let limitPrice = targetPrice + entryLimitOffsetCents / 100;
    if (limitPrice <= 0 || isNaN(limitPrice)) {
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      return;
    }

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('ENTRY'),
    };

    this.watchlist[symbol].hasPendingEntryOrder = true;
    this.enqueueOrder(order, 3);
  }

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
        let message = `Retrying in ${totalDelay.toFixed(0)}ms...`;
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

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }
}

module.exports = OrderManager;
