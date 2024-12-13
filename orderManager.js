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
    this.positions = {};
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.orderTracking = {};

    this.isRefreshing = false;
    this.isPolling = false;

    this.overrideAddList = new Set(
      (config.overrideAddSymbols || []).map((sym) => sym.toUpperCase())
    );
    this.overrideRemoveList = new Set(
      (config.overrideRemoveSymbols || []).map((sym) => sym.toUpperCase())
    );

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

    this.restClient = new PolygonRestClient();

    this.watchlist = {};
    this.topGainers = {};

    this.orderQueue = [];
    this.isOrderProcessing = false;

    // Bind methods to ensure correct 'this' context
    this.onTradeUpdate = this.onTradeUpdate.bind(this);
    this.onQuoteUpdate = this.onQuoteUpdate.bind(this);

    this.polygon.onTrade = this.onTradeUpdate;
    this.polygon.onQuote = this.onQuoteUpdate;

    this.initializeExistingPositions().then(() => {
      this.updateAllPositionsStops();
      this.enforceStopsAtStartup(); // Enforce stops immediately after initialization
    });
    this.initializeWatchlist();

    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(() => {
      this.refreshPositions().then(() => {
        this.updateAllPositionsStops();
        this.enforceStopsAtStartup(); // Enforce stops after refreshing positions
      });
    }, config.pollingIntervals.positionRefresh);
    setInterval(
      () => this.initializeWatchlist(),
      config.pollingIntervals.watchlistRefresh
    );
    setInterval(
      () => this.reloadDynamicOverrides(),
      config.pollingIntervals.watchlistRefresh
    );

    if (
      this.dashboard &&
      typeof this.dashboard.setOrderTracking === 'function'
    ) {
      this.dashboard.setOrderTracking(this.orderTracking);
    }

    process.on('unhandledRejection', (reason, promise) => {
      const errorMsg = `Unhandled Rejection at: ${promise}, reason: ${reason}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    });
  }

  // Enrich the watchlist with breakoutTriggerPrice and subscription info
  enrichWatchlistData() {
    const initialEntryOffsetCents =
      config.strategySettings.initialEntryOffsetCents || 0;
    for (const symbol in this.watchlist) {
      const w = this.watchlist[symbol];

      // If no position and no pending entry and we have a HOD, show breakout trigger price
      let breakoutTriggerPrice = 'N/A';
      if (!w.hasPosition && !w.hasPendingEntryOrder && w.highOfDay) {
        breakoutTriggerPrice = (
          w.highOfDay +
          initialEntryOffsetCents / 100
        ).toFixed(2);
      }

      // Determine subscription statuses
      const quoteSubscribed = this.polygon.subscribedSymbols.has(symbol)
        ? 'Y'
        : 'N';
      const tradeSubscribed = this.polygon.subscribedTradeSymbols.has(symbol)
        ? 'Y'
        : 'N';

      w.breakoutTriggerPrice = breakoutTriggerPrice;
      w.quoteSubscribed = quoteSubscribed;
      w.tradeSubscribed = tradeSubscribed;
    }
  }

  updateAllPositionsStops() {
    for (const symbol in this.positions) {
      const pos = this.positions[symbol];
      const dynamicStop = this.calculateDynamicStopPrice(
        pos.profitTargetsHit,
        pos.avgEntryPrice,
        pos.side
      );
      if (dynamicStop) {
        pos.stopPrice = dynamicStop.stopPrice;
        pos.stopCents = dynamicStop.stopCents;
        pos.stopDescription = `Stop ${pos.stopCents}¢ ${
          pos.stopCents > 0 ? 'above' : pos.stopCents < 0 ? 'below' : 'at'
        } avg price`;
      } else {
        pos.stopPrice = null;
        pos.stopCents = null;
        pos.stopDescription = 'N/A';
      }
    }
    this.dashboard.updatePositions(Object.values(this.positions));
  }

  async subscribeTradesForSymbol(symbol) {
    this.polygon.subscribeTrades(symbol);
    this.enrichWatchlistData();
    this.dashboard.updateWatchlist(this.watchlist);
  }

  enqueueOrder({
    symbol,
    qty,
    side,
    type,
    limit_price,
    extended_hours = true,
    stopPriority = false,
    clientOrderPrefix,
  }) {
    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type,
      time_in_force: 'day',
      extended_hours,
      client_order_id: this.generateClientOrderId(clientOrderPrefix),
    };

    if (limit_price !== undefined) {
      order.limit_price = limit_price.toFixed(2);
    }

    if (stopPriority) {
      this.orderQueue.unshift(order);
    } else {
      this.orderQueue.push(order);
    }

    this.dashboard.logInfo(
      `Order enqueued: ${JSON.stringify(order)} (stopPriority: ${stopPriority})`
    );
    logger.info(
      `Order enqueued: ${JSON.stringify(order)} (stopPriority: ${stopPriority})`
    );

    this.processOrderQueue();
  }

  async processOrderQueue() {
    if (this.isOrderProcessing || this.orderQueue.length === 0) return;

    this.isOrderProcessing = true;
    const order = this.orderQueue.shift();

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Order placed: ${order.side.toUpperCase()} ${
        order.qty
      } ${order.symbol} at ${order.limit_price || 'MARKET'} | ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      let orderType = 'limit';
      if (order.client_order_id.includes('ENTRY')) orderType = 'entry';
      else if (order.client_order_id.includes('PYRAMID')) orderType = 'pyramid';
      else if (order.client_order_id.includes('CLOSE')) orderType = 'close';

      this.orderTracking[result.id] = {
        symbol: order.symbol,
        type: orderType,
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
      };
    } catch (err) {
      const errorMsg = `Error placing order for ${order.symbol}: ${err.message}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    } finally {
      this.isOrderProcessing = false;
      if (this.orderQueue.length > 0) {
        this.processOrderQueue();
      }
    }
  }

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
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

  overrideHOD(symbol, newHod) {
    // HOD logic removed, but if user tries to override, we can still set watchlist highOfDay
    const upper = symbol.toUpperCase();
    if (this.watchlist[upper]) {
      this.watchlist[upper].highOfDay = newHod;
      this.watchlist[upper].overriddenHod = true;
      this.dashboard.logInfo(
        `HOD for ${upper} overridden to $${newHod.toFixed(2)}`
      );
      logger.info(`HOD for ${upper} overridden to $${newHod.toFixed(2)}`);
      this.enrichWatchlistData();
      this.dashboard.updateWatchlist(this.watchlist);
    } else {
      this.dashboard.logWarning(
        `Cannot override HOD for ${upper}. Not in watchlist.`
      );
    }
  }

  overrideAddSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideAddList.add(upperSymbol);
    logger.info(`Symbol ${upperSymbol} added to override add list.`);
    this.dashboard.logInfo(`Symbol ${upperSymbol} added to override add list.`);
    this.applyOverridesToWatchlist();
  }

  clearOverrideAddSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideAddList.delete(upperSymbol);
    logger.info(`Symbol ${upperSymbol} removed from override add list.`);
    this.dashboard.logInfo(
      `Symbol ${upperSymbol} removed from override add list.`
    );
    this.applyOverridesToWatchlist();
  }

  overrideRemoveSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideRemoveList.add(upperSymbol);
    logger.info(`Symbol ${upperSymbol} added to override remove list.`);
    this.dashboard.logInfo(
      `Symbol ${upperSymbol} added to override remove list.`
    );
    this.applyOverridesToWatchlist();
  }

  clearOverrideRemoveSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideRemoveList.delete(upperSymbol);
    logger.info(`Symbol ${upperSymbol} removed from override remove list.`);
    this.dashboard.logInfo(
      `Symbol ${upperSymbol} removed from override remove list.`
    );
    this.applyOverridesToWatchlist();
  }

  applyOverridesToWatchlist() {
    for (const symbol of this.overrideRemoveList) {
      if (this.watchlist[symbol]) {
        if (!this.positions[symbol]) {
          this.polygon.unsubscribe(symbol);
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
        };
        this.polygon.subscribe(symbol);
        this.dashboard.logInfo(
          `Symbol ${symbol} added to watchlist due to override add list.`
        );
      }
    }

    // After changes, enrich and update to show correct columns
    this.enrichWatchlistData();
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
      this.topGainers = {};

      const currentVolumeRequirement = this.getCurrentVolumeRequirement();
      const { minAccumulatedVolume, minOneMinuteRange, maxSpreadCents } =
        config.strategySettings;
      const maxSpread = maxSpreadCents / 100;

      for (const gainer of gainers) {
        const symbol = gainer.ticker.toUpperCase();
        if (symbol.includes('.')) continue;

        const gapPerc = gainer.todaysChangePerc;
        if (gapPerc < config.strategySettings.gapPercentageRequirement)
          continue;

        const ask = gainer.lastQuote.P || 0;
        const bid = gainer.lastQuote.p || 0;
        const spread = ask - bid;
        if (spread > maxSpread) continue;

        const currentPrice = bid;
        if (
          currentPrice < config.strategySettings.priceRange.min ||
          currentPrice > config.strategySettings.priceRange.max
        )
          continue;

        const volume = gainer.min.v || 0;
        const accumulatedVolume = gainer.min.av || 0;
        const high1m = gainer.min.h || 0;
        const low1m = gainer.min.l || 0;
        const range = high1m - low1m;

        if (range < minOneMinuteRange) continue;
        if (volume < currentVolumeRequirement) continue;
        if (accumulatedVolume < minAccumulatedVolume) continue;

        this.topGainers[symbol] = {
          symbol,
          dayClose: currentPrice,
          gapPerc,
          volume,
          accumulatedVolume,
        };

        await this.addSymbolToWatchlist(symbol);
      }

      this.applyOverridesToWatchlist();

      for (const symbol in this.watchlist) {
        if (!this.topGainers[symbol] && !this.overrideAddList.has(symbol)) {
          this.removeSymbolFromWatchlist(symbol);
        }
      }

      this.enrichWatchlistData();
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
        };
        this.polygon.subscribe(symbol);
      } else {
        this.watchlist[symbol].highOfDay = hod;
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
        if (this.watchlist[symbol].hasPendingEntryOrder === undefined) {
          this.watchlist[symbol].hasPendingEntryOrder = false;
        }
      }
      this.enrichWatchlistData();
      this.dashboard.updateWatchlist(this.watchlist);
    } catch (err) {
      const errorMsg = `Error adding symbol ${symbol} to watchlist: ${err.message}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  removeSymbolFromWatchlist(symbol) {
    if (this.watchlist[symbol] && !this.positions[symbol]) {
      this.polygon.unsubscribe(symbol);
      delete this.watchlist[symbol];
      this.dashboard.logInfo(`Symbol ${symbol} removed from watchlist.`);
      this.enrichWatchlistData();
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

  // Dynamic stops now are the only mechanism from the start
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
      return null;
    }
  }

  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = position.side === 'long' ? 'buy' : 'sell';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    // Immediately set initial stop based on profitTargetsHit=0 scenario
    const dynamicStop = this.calculateDynamicStopPrice(0, avgEntryPrice, side);
    let stopPrice = null;
    let stopCents = null;
    let stopDescription = 'N/A';
    if (dynamicStop) {
      stopPrice = dynamicStop.stopPrice;
      stopCents = dynamicStop.stopCents;
      stopDescription = `Stop ${stopCents}¢ ${
        stopCents > 0 ? 'above' : stopCents < 0 ? 'below' : 'at'
      } avg price`;
    }

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
      stopPrice,
      stopCents,
      stopDescription,
      stopTriggered: false,
      pyramidLevelsHit: 0,
      totalPyramidLevels: config.orderSettings.pyramidLevels.length,
      trailingStopActive: false,
      trailingStopPrice: null,
      trailingStopMaxPrice: null,
      trailingStopLastUpdatePrice: null,
      tradeIntervals: [],
      trailingStopIntervalHandle: null,
      lowestIntervalLow: null,
      stopClosureIntervalHandle: null, // New handle for continuous closure attempts
    };

    const message = `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`;
    logger.info(message);
    this.dashboard.logInfo(message);

    this.polygon.subscribe(symbol);
    this.dashboard.updatePositions(Object.values(this.positions));

    if (this.watchlist[symbol]) {
      this.watchlist[symbol].hasPosition = true;
      this.enrichWatchlistData();
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  async removePosition(symbol) {
    const pos = this.positions[symbol];
    if (pos) {
      if (pos.trailingStopIntervalHandle) {
        clearInterval(pos.trailingStopIntervalHandle);
        pos.trailingStopIntervalHandle = null;
      }

      // Clear stop closure interval if active
      if (pos.stopClosureIntervalHandle) {
        clearInterval(pos.stopClosureIntervalHandle);
        pos.stopClosureIntervalHandle = null;
      }

      delete this.positions[symbol];
      const message = `Position removed: ${symbol}`;
      logger.info(message);
      this.dashboard.logInfo(message);

      if (!this.watchlist[symbol]) {
        this.polygon.unsubscribe(symbol);
      } else {
        // We can still update HOD if we want, but no HOD stops now
        try {
          const newHod = await this.restClient.getIntradayHigh(symbol);
          this.watchlist[symbol].highOfDay = newHod;
          this.dashboard.logInfo(
            `HOD updated to $${newHod.toFixed(
              2
            )} for ${symbol} immediately after position close.`
          );
          this.dashboard.updateWatchlist(this.watchlist);
        } catch (err) {
          const errorMsg = `Error updating HOD for ${symbol} after position close: ${err.message}`;
          logger.error(errorMsg);
          this.dashboard.logError(errorMsg);
        }
      }

      this.dashboard.updatePositions(Object.values(this.positions));

      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPosition = false;
        this.enrichWatchlistData();
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }
  }

  // New method to enforce stops at startup
  enforceStopsAtStartup() {
    for (const symbol in this.positions) {
      const pos = this.positions[symbol];
      if (!pos.stopTriggered && pos.stopPrice !== null) {
        const currentPrice =
          pos.side === 'buy' ? pos.currentBid : pos.currentAsk;
        // If already beyond stop price, trigger immediate closure attempts
        if (
          (pos.side === 'buy' && currentPrice <= pos.stopPrice) ||
          (pos.side === 'sell' && currentPrice >= pos.stopPrice)
        ) {
          pos.stopTriggered = true;
          const stopMsg = `Startup check: Stop condition met for ${symbol}. Closing position. Price=$${currentPrice.toFixed(
            2
          )} Stop=$${pos.stopPrice.toFixed(2)}`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(symbol, true);
          this.ensurePositionClosed(symbol);
        }
      }
    }
  }

  ensurePositionClosed(symbol) {
    const pos = this.positions[symbol];
    if (!pos) return; // No position, no need to ensure closure

    // If already have an interval trying to close, don't start another
    if (pos.stopClosureIntervalHandle) return;

    // Attempt closure every 500ms until closed
    pos.stopClosureIntervalHandle = setInterval(async () => {
      const currentPos = this.positions[symbol];
      if (!currentPos || currentPos.qty <= 0) {
        // Position closed, stop interval
        if (pos.stopClosureIntervalHandle) {
          clearInterval(pos.stopClosureIntervalHandle);
          pos.stopClosureIntervalHandle = null;
        }
        return;
      }

      const side = currentPos.side === 'buy' ? 'sell' : 'buy';
      const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
      let limitPrice;
      if (side === 'buy') {
        limitPrice = currentPos.currentAsk + limitOffsetCents / 100;
      } else {
        limitPrice = currentPos.currentBid - limitOffsetCents / 100;
      }

      if (!limitPrice || limitPrice <= 0 || isNaN(limitPrice)) {
        logger.warn(
          `Invalid limit price while continuously trying to close ${symbol}. Will try again.`
        );
        return;
      }

      try {
        await this.retryOperation(
          () =>
            new Promise((resolve, reject) => {
              this.enqueueOrder({
                symbol,
                qty: currentPos.qty,
                side,
                type: 'limit',
                limit_price: limitPrice,
                extended_hours: true,
                stopPriority: true,
                clientOrderPrefix: 'CLOSE',
              });
              // enqueueOrder does not throw, but processOrderQueue handles placement
              resolve();
            })
        );
      } catch (err) {
        // If error, log and try again at next interval
        logger.error(`Error re-attempting close for ${symbol}: ${err.message}`);
        this.dashboard.logError(
          `Error re-attempting close for ${symbol}: ${err.message}`
        );
      }
    }, 500); // attempt closure every 500ms
  }

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];

    if (w && w.highOfDay && w.highOfDay - askPrice <= 0.2) {
      // Subscribe to trades if close to HOD and update watchlist
      this.subscribeTradesForSymbol(upperSymbol);
    }

    const pos = this.positions[upperSymbol];
    if (pos && pos.isActive) {
      this.updatePositionPricesFromQuote(pos, bidPrice, askPrice);
      this.evaluateStopsAndTargets(pos, upperSymbol);
    }

    if (
      w &&
      !w.hasPosition &&
      !w.hasPendingEntryOrder &&
      askPrice > w.highOfDay &&
      !w.overriddenHod
    ) {
      try {
        const newHod = await this.restClient.getIntradayHigh(upperSymbol);
        if (newHod && newHod > w.highOfDay) {
          w.highOfDay = newHod;
          this.dashboard.logInfo(
            `HOD updated for ${upperSymbol}: $${newHod.toFixed(2)}`
          );
          this.enrichWatchlistData();
          this.dashboard.updateWatchlist(this.watchlist);
        }
      } catch (err) {
        const errorMsg = `Error updating HOD for ${upperSymbol}: ${err.message}`;
        logger.error(errorMsg);
        this.dashboard.logError(errorMsg);
      }
    }
  }

  async onTradeUpdate(symbol, tradePrice) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];

    if (w && !w.hasPosition && !w.hasPendingEntryOrder && w.highOfDay) {
      const triggerPrice =
        w.highOfDay + config.strategySettings.initialEntryOffsetCents / 100;
      if (tradePrice > triggerPrice) {
        const { initialShareSize, openingOrderCooldownSeconds } =
          config.strategySettings;
        const openingOrderCooldownMs = openingOrderCooldownSeconds * 1000;

        const now = Date.now();
        const canPlaceOrder =
          (!w.lastEntryTime ||
            now - w.lastEntryTime > openingOrderCooldownMs) &&
          !this.positions[upperSymbol] &&
          !this.hasPendingOpeningOrder(upperSymbol);

        if (canPlaceOrder) {
          w.lastEntryTime = now;
          w.hasPendingEntryOrder = true;
          this.dashboard.logInfo(
            `Trade above HOD+offset detected for ${upperSymbol}: Trade=$${tradePrice.toFixed(
              2
            )}, HOD=$${w.highOfDay.toFixed(2)}`
          );
          await this.placeEntryOrder(
            upperSymbol,
            initialShareSize,
            'buy',
            triggerPrice
          );
        }
      }
    }

    const pos = this.positions[upperSymbol];
    if (pos && pos.isActive && pos.trailingStopActive) {
      this.recordTradeForTrailingStop(pos, tradePrice);
    }
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

  updatePositionPricesFromQuote(pos, bidPrice, askPrice) {
    const side = pos.side;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
    pos.currentBid = bidPrice;
    pos.currentAsk = askPrice;
    pos.currentPrice = currentPrice;
    pos.profitCents = (
      (currentPrice - pos.avgEntryPrice) *
      100 *
      (side === 'buy' ? 1 : -1)
    ).toFixed(2);
  }

  async closePositionMarketOrder(symbol, retryOnFail = false, attempts = 3) {
    const pos = this.positions[symbol];
    if (!pos) {
      const warnMessage = `Attempted to close position for ${symbol} but no position found.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    const qty = pos.qty;
    if (qty <= 0) {
      const warnMessage = `Attempted to close position for ${symbol} with qty ${qty}.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    const side = pos.side === 'buy' ? 'sell' : 'buy';
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

    const closeMessage = `Enqueuing close position order for ${symbol} Qty: ${qty} Side: ${side} Limit: $${limitPrice.toFixed(
      2
    )}`;
    logger.info(closeMessage);
    this.dashboard.logInfo(closeMessage);

    const placeClose = async (remainingAttempts) => {
      try {
        await this.retryOperation(
          () =>
            new Promise((resolve, reject) => {
              this.enqueueOrder({
                symbol,
                qty,
                side,
                type: 'limit',
                limit_price: limitPrice,
                extended_hours: true,
                stopPriority: true,
                clientOrderPrefix: 'CLOSE',
              });
              // enqueueOrder does not throw, resolve immediately
              resolve();
            })
        );
      } catch (err) {
        logger.error(
          `Failed to enqueue close order for ${symbol}: ${err.message}`
        );
        this.dashboard.logError(
          `Failed to enqueue close order for ${symbol}: ${err.message}`
        );
        if (retryOnFail && remainingAttempts > 1) {
          logger.warn(`Retrying close position order for ${symbol}...`);
          await placeClose(remainingAttempts - 1);
        }
      }
    };

    await placeClose(attempts);
  }

  evaluateStopsAndTargets(pos, symbol) {
    const side = pos.side;

    if (!pos.stopTriggered && pos.stopPrice !== null) {
      const currentPrice = side === 'buy' ? pos.currentBid : pos.currentAsk;
      if (
        (side === 'buy' && currentPrice <= pos.stopPrice) ||
        (side === 'sell' && currentPrice >= pos.stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${symbol}. Closing position. Price=$${currentPrice.toFixed(
          2
        )} Stop=$${pos.stopPrice.toFixed(2)}`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        this.closePositionMarketOrder(symbol, true); // Attempt immediate close
        this.ensurePositionClosed(symbol); // Start continuous closure attempts
        return;
      }
    }

    const profitTargets = config.orderSettings.profitTargets;
    if (pos.profitTargetsHit < profitTargets.length) {
      const target = profitTargets[pos.profitTargetsHit];
      if (
        !pos.isProcessing &&
        parseFloat(pos.profitCents) >= target.targetCents
      ) {
        pos.isProcessing = true;
        const targetMessage = `Profit target hit for ${symbol}: +${pos.profitCents}¢ >= +${target.targetCents}¢`;
        logger.info(targetMessage);
        this.dashboard.logInfo(targetMessage);

        let qtyToClose = Math.floor(pos.qty * (target.percentToClose / 100));
        qtyToClose = Math.min(qtyToClose, pos.qty);

        if (qtyToClose > 0) {
          this.placeLimitOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          ).then(() => {
            pos.profitTargetsHit += 1;

            // After hitting a profit target, recalc stop from dynamic stops
            const dynamicStop = this.calculateDynamicStopPrice(
              pos.profitTargetsHit,
              pos.avgEntryPrice,
              pos.side
            );
            if (dynamicStop) {
              pos.stopPrice = dynamicStop.stopPrice;
              pos.stopCents = dynamicStop.stopCents;
              pos.stopDescription = `Stop ${pos.stopCents}¢ ${
                pos.stopCents > 0 ? 'above' : pos.stopCents < 0 ? 'below' : 'at'
              } avg price`;
              const stopPriceMessage = `Adjusted stop price for ${symbol} to $${pos.stopPrice.toFixed(
                2
              )} after hitting ${pos.profitTargetsHit} profit targets.`;
              this.dashboard.logInfo(stopPriceMessage);
            } else {
              pos.stopPrice = null;
              pos.stopCents = null;
              pos.stopDescription = 'N/A';
            }

            if (
              pos.profitTargetsHit >= profitTargets.length &&
              pos.qty > 0 &&
              !pos.trailingStopActive
            ) {
              this.activateTradeIntervalTrailingStop(pos, symbol);
            }

            pos.isProcessing = false;
            this.dashboard.updatePositions(Object.values(this.positions));
          });
        } else {
          pos.isProcessing = false;
        }
      }
    } else {
      if (pos.trailingStopActive && pos.qty > 0) {
        if (pos.side === 'buy' && pos.currentPrice < pos.trailingStopPrice) {
          const stopMsg = `Trailing stop hit for ${symbol} at $${pos.trailingStopPrice.toFixed(
            2
          )}. Closing remaining position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(symbol, true);
          this.ensurePositionClosed(symbol);
        } else if (
          pos.side === 'sell' &&
          pos.currentPrice > pos.trailingStopPrice
        ) {
          const stopMsg = `Trailing stop hit for short ${symbol} at $${pos.trailingStopPrice.toFixed(
            2
          )}. Closing remaining position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(symbol, true);
          this.ensurePositionClosed(symbol);
        }
      }
    }
  }

  activateTradeIntervalTrailingStop(pos, symbol) {
    pos.trailingStopActive = true;
    pos.tradeIntervals = [];
    pos.lowestIntervalLow = null;

    const intervalSec = config.strategySettings.trailingStopIntervalSeconds;
    pos.trailingStopIntervalHandle = setInterval(() => {
      this.updateIntervalTrailingStop(pos, symbol);
    }, intervalSec * 1000);

    this.dashboard.logInfo(
      `Trailing stop (interval-based) activated for ${symbol}. Tracking ${intervalSec}-second lows.`
    );
  }

  recordTradeForTrailingStop(pos, tradePrice) {
    pos.tradeIntervals.push(tradePrice);
  }

  updateIntervalTrailingStop(pos, symbol) {
    if (pos.tradeIntervals.length === 0) {
      if (pos.lowestIntervalLow === null) {
        pos.trailingStopPrice = pos.avgEntryPrice;
        pos.stopDescription = `TRAILSTOP @ BREAKEVEN ($${pos.avgEntryPrice.toFixed(
          2
        )}) due to no trades.`;
        this.dashboard.logInfo(
          `No trades for ${symbol} in interval. Fallback to breakeven trailing stop at $${pos.avgEntryPrice.toFixed(
            2
          )}`
        );
        this.dashboard.updatePositions(Object.values(this.positions));
      }
      return;
    }

    const intervalLow = Math.min(...pos.tradeIntervals);
    pos.tradeIntervals = [];

    if (pos.lowestIntervalLow === null || intervalLow < pos.lowestIntervalLow) {
      pos.lowestIntervalLow = intervalLow;
      pos.trailingStopPrice = intervalLow;
      pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(
        2
      )} (Interval Low Based)`;
      this.dashboard.logInfo(
        `New interval low for ${symbol}: $${intervalLow.toFixed(
          2
        )}. Trailing stop updated.`
      );
      this.dashboard.updatePositions(Object.values(this.positions));
    }
  }

  async placeEntryOrder(symbol, qty, side, targetPrice) {
    if (this.positions[symbol]) {
      const msg = `Cannot place entry order for ${symbol} - position already exists.`;
      this.dashboard.logInfo(msg);
      logger.info(msg);
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      return;
    }
    if (this.hasPendingOpeningOrder(symbol)) {
      const msg = `Cannot place entry order for ${symbol} - pending opening order exists.`;
      this.dashboard.logInfo(msg);
      logger.info(msg);
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      return;
    }

    const entryLimitOffsetCents =
      config.strategySettings.entryLimitOffsetCents || 0;
    let limitPrice = targetPrice;
    if (side === 'buy') {
      limitPrice = targetPrice + entryLimitOffsetCents / 100;
    } else {
      limitPrice = targetPrice - entryLimitOffsetCents / 100;
    }

    const orderMessage = `Placing breakout entry order for ${symbol} at $${limitPrice.toFixed(
      2
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    this.enqueueOrder({
      symbol,
      qty,
      side,
      type: 'limit',
      limit_price: limitPrice,
      extended_hours: true,
      stopPriority: false,
      clientOrderPrefix: 'ENTRY',
    });
  }

  async placePyramidOrder(pos, qtyToAdd, offsetCents) {
    const symbol = pos.symbol;
    const side = pos.side;

    const limitPrice =
      side === 'buy'
        ? pos.currentAsk + offsetCents / 100
        : pos.currentBid - offsetCents / 100;

    const orderMessage = `Attempting to place pyramid order for ${symbol} at $${limitPrice.toFixed(
      2
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    this.enqueueOrder({
      symbol,
      qty: qtyToAdd,
      side,
      type: 'limit',
      limit_price: limitPrice,
      extended_hours: true,
      stopPriority: false,
      clientOrderPrefix: 'PYRAMID',
    });
  }

  async placeLimitOrder(symbol, qty, side) {
    qty = Math.abs(qty);
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

    const orderMessage = `Attempting to place limit order for ${symbol} at $${limitPrice.toFixed(
      2
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    this.enqueueOrder({
      symbol,
      qty,
      side,
      type: 'limit',
      limit_price: limitPrice,
      extended_hours: true,
      stopPriority: false,
      clientOrderPrefix: 'LIMIT',
    });
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
          delete this.orderTracking[orderId];
          continue;
        }

        const elapsed = now - trackedOrder.placedAt;
        let timeoutMs = null;

        if (trackedOrder.type === 'pyramid') {
          timeoutMs = orderTimeouts.pyramid;
        } else if (trackedOrder.type === 'close') {
          timeoutMs = orderTimeouts.close;
        } else if (trackedOrder.type === 'limit') {
          timeoutMs = orderTimeouts.limit;
        } else if (trackedOrder.type === 'entry') {
          timeoutMs = orderTimeouts.entry;
        }

        if (timeoutMs && elapsed > timeoutMs) {
          await this.cancelOrder(orderId, trackedOrder.symbol);
          if (trackedOrder.type === 'close') {
            await this.closePositionMarketOrder(trackedOrder.symbol, true);
            // Also ensure position closure if necessary
            if (
              this.positions[trackedOrder.symbol] &&
              this.positions[trackedOrder.symbol].stopTriggered
            ) {
              this.ensurePositionClosed(trackedOrder.symbol);
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
              const fillMessage = `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`;
              logger.info(fillMessage);
              this.dashboard.logInfo(fillMessage);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);

              if (pos.qty <= 0) this.removePosition(trackedOrder.symbol);
              this.dashboard.updatePositions(Object.values(this.positions));
            } else if (
              trackedOrder.type === 'pyramid' ||
              trackedOrder.type === 'entry'
            ) {
              const oldQty = pos.qty;
              const fillPrice = parseFloat(
                order.limit_price || pos.currentPrice
              );
              const totalCost =
                pos.avgEntryPrice * oldQty + filledQty * fillPrice;
              pos.qty = oldQty + filledQty;
              pos.avgEntryPrice = totalCost / pos.qty;

              const fillMessage = `Order ${
                order.id
              } filled ${filledQty} qty for ${trackedOrder.symbol}. New qty: ${
                pos.qty
              }, New Avg Entry Price: $${pos.avgEntryPrice.toFixed(2)}`;
              logger.info(fillMessage);
              this.dashboard.logInfo(fillMessage);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);

              // Recalc stops after entry fill
              const dynamicStop = this.calculateDynamicStopPrice(
                pos.profitTargetsHit,
                pos.avgEntryPrice,
                pos.side
              );
              if (dynamicStop) {
                pos.stopPrice = dynamicStop.stopPrice;
                pos.stopCents = dynamicStop.stopCents;
                pos.stopDescription = `Stop ${pos.stopCents}¢ ${
                  pos.stopCents > 0
                    ? 'above'
                    : pos.stopCents < 0
                    ? 'below'
                    : 'at'
                } avg price`;
              } else {
                pos.stopPrice = null;
                pos.stopCents = null;
                pos.stopDescription = 'N/A';
              }

              this.dashboard.updatePositions(Object.values(this.positions));
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
            100 *
            (pos.side === 'buy' ? 1 : -1)
          ).toFixed(2);

          if (pos.qty === 0) {
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
      this.enrichWatchlistData();
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (
        err.code === 'ECONNRESET' ||
        (err.response &&
          (err.response.status === 429 ||
            (err.response.status >= 500 && err.response.status < 600)))
      ) {
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        let message = '';

        if (err.code === 'ECONNRESET') {
          message = `ECONNRESET encountered. Retrying in ${totalDelay.toFixed(
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = OrderManager;
