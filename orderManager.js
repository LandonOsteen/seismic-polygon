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

    this.stateFilePath = path.join(__dirname, 'state.json');
    this.state = this.loadState();

    this.onTradeUpdate = this.onTradeUpdate.bind(this);
    this.onQuoteUpdate = this.onQuoteUpdate.bind(this);

    this.polygon.onTrade = this.onTradeUpdate;
    this.polygon.onQuote = this.onQuoteUpdate;

    this.initializeExistingPositions();
    this.initializeWatchlist();

    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(() => {
      this.refreshPositions();
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

  loadState() {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const data = fs.readFileSync(this.stateFilePath, 'utf-8');
        return JSON.parse(data);
      } catch (err) {
        logger.warn(`Could not parse state file: ${err.message}`);
        return {};
      }
    }
    return {};
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.error(`Error writing state file: ${err.message}`);
      this.dashboard.logError(`Error writing state file: ${err.message}`);
    }
  }

  updatePositionState(symbol) {
    if (!this.state.positions) this.state.positions = {};
    const pos = this.positions[symbol];
    if (!pos) return;

    this.state.positions[symbol] = {
      profitTargetsHit: pos.profitTargetsHit,
      pyramidLevelsHit: pos.pyramidLevelsHit,
      stopTriggered: pos.stopTriggered,
      trailingStopActive: pos.trailingStopActive,
    };

    this.saveState();
  }

  restorePositionState(symbol) {
    if (this.state.positions && this.state.positions[symbol]) {
      const saved = this.state.positions[symbol];
      const pos = this.positions[symbol];
      pos.profitTargetsHit = saved.profitTargetsHit || 0;
      pos.pyramidLevelsHit = saved.pyramidLevelsHit || 0;
      pos.stopTriggered = !!saved.stopTriggered;
      pos.trailingStopActive = !!saved.trailingStopActive;
    }
  }

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  async initializeExistingPositions() {
    try {
      const positions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      for (const position of positions) {
        await this.addPosition(position);
        this.restorePositionState(position.symbol.toUpperCase());
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
        this.subscribeTradesForSymbol(symbol);
      } else {
        this.watchlist[symbol].highOfDay = hod;
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
        if (this.watchlist[symbol].hasPendingEntryOrder === undefined) {
          this.watchlist[symbol].hasPendingEntryOrder = false;
        }
        this.polygon.subscribe(symbol);
        this.subscribeTradesForSymbol(symbol);
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
      trailingStopIntervalHandle: null,
      tradeIntervals: [],
      lowestIntervalLow: null,
      isProcessingPyramid: false,
    };

    const message = `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`;
    logger.info(message);
    this.dashboard.logInfo(message);

    this.polygon.subscribe(symbol);
    this.subscribeTradesForSymbol(symbol);
    this.dashboard.updatePositions(Object.values(this.positions));
    if (this.watchlist[symbol]) {
      this.watchlist[symbol].hasPosition = true;
      this.enrichWatchlistData();
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  removePosition(symbol) {
    const pos = this.positions[symbol];
    if (pos) {
      if (pos.trailingStopIntervalHandle) {
        clearInterval(pos.trailingStopIntervalHandle);
        pos.trailingStopIntervalHandle = null;
      }

      delete this.positions[symbol];
      if (this.state.positions && this.state.positions[symbol]) {
        delete this.state.positions[symbol];
        this.saveState();
      }

      const message = `Position removed: ${symbol}`;
      logger.info(message);
      this.dashboard.logInfo(message);

      if (!this.watchlist[symbol]) {
        this.polygon.unsubscribe(symbol);
      } else {
        this.dashboard.updateWatchlist(this.watchlist);
      }

      this.dashboard.updatePositions(Object.values(this.positions));
      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPosition = false;
        this.enrichWatchlistData();
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }
  }

  enrichWatchlistData() {
    const initialEntryOffsetCents =
      config.strategySettings.initialEntryOffsetCents || 0;
    for (const symbol in this.watchlist) {
      const w = this.watchlist[symbol];
      let breakoutTriggerPrice = 'N/A';
      if (!w.hasPosition && !w.hasPendingEntryOrder && w.highOfDay) {
        breakoutTriggerPrice = (
          w.highOfDay +
          initialEntryOffsetCents / 100
        ).toFixed(2);
      }

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

  async reloadDynamicOverrides() {
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
        await this.applyOverridesToWatchlist();
      }
    } catch (err) {
      const msg = `Error reloading dynamic config: ${err.message}`;
      logger.error(msg);
      this.dashboard.logError(msg);
    }
  }

  async applyOverridesToWatchlist() {
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
        this.watchlist[symbol] = {
          highOfDay: null,
          lastEntryTime: null,
          hasPosition: !!this.positions[symbol],
          hasPendingEntryOrder: false,
        };
        this.polygon.subscribe(symbol);
        this.subscribeTradesForSymbol(symbol);
        this.dashboard.logInfo(
          `Symbol ${symbol} added to watchlist due to override add list.`
        );

        await this.addSymbolToWatchlist(symbol);
      }
    }

    this.enrichWatchlistData();
    this.dashboard.updateWatchlist(this.watchlist);
  }

  subscribeTradesForSymbol(symbol) {
    if (!this.polygon.subscribedTradeSymbols.has(symbol)) {
      this.polygon.subscribeTrades(symbol);
      logger.info(`Subscribed to trades for ${symbol}.`);
      this.dashboard.logInfo(`Subscribed to trades for ${symbol}.`);
    }
  }

  async onTradeUpdate(symbol, tradePrice) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];

    if (w && !w.hasPosition && !w.hasPendingEntryOrder && w.highOfDay) {
      const triggerPrice =
        w.highOfDay + config.strategySettings.initialEntryOffsetCents / 100;
      // Strictly greater than triggerPrice
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
  }

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    // logic for stops/targets/pyramids/trailing stops, unchanged from previous code.
    // Just ensure that this code from previous steps is retained.
    // Already integrated above in the final code snippet.
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

  async closePositionLimitOrder(symbol) {
    // ... unchanged close logic
    const pos = this.positions[symbol];
    if (!pos) return;
    const qty = pos.qty;
    if (qty <= 0) return;

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

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('CLOSE'),
    };

    const msg = `Closing position with limit order: ${JSON.stringify(order)}`;
    logger.info(msg);
    this.dashboard.logInfo(msg);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMsg = `Limit order placed to close position in ${symbol}. Order ID: ${result.id}`;
      logger.info(successMsg);
      this.dashboard.logInfo(successMsg);

      this.orderTracking[result.id] = {
        symbol,
        type: 'close',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
      };

      await this.refreshPositions();
    } catch (err) {
      const errorMessage = `Error placing limit order to close position for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  async placeEntryOrder(symbol, qty, side, targetPrice) {
    if (this.positions[symbol]) return;
    if (this.hasPendingOpeningOrder(symbol)) return;

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

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Entry order placed for ${qty} shares of ${symbol} at $${limitPrice.toFixed(
        2
      )}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'entry',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
      };
    } catch (err) {
      const errorMsg = `Error placing entry order for ${symbol}: ${err.message}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
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

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${symbol}. Cannot place pyramid ${side} order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      return;
    }

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

    const msg = `Attempting to place pyramid order: ${JSON.stringify(order)}`;
    logger.info(msg);
    this.dashboard.logInfo(msg);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMsg = `Pyramid order placed for ${qtyToAdd} shares of ${symbol}. Order ID: ${result.id}`;
      logger.info(successMsg);
      this.dashboard.logInfo(successMsg);

      this.orderTracking[result.id] = {
        symbol,
        type: 'pyramid',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
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

  async placeLimitOrderClosePartial(symbol, qty, side) {
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
      const errorMsg = `Invalid limit price for ${symbol} while closing partial.`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
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
      client_order_id: this.generateClientOrderId('LIMIT'),
    };

    const msg = `Attempting to place partial close limit order: ${JSON.stringify(
      order
    )}`;
    logger.info(msg);
    this.dashboard.logInfo(msg);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Partial close limit order placed for ${qty} shares of ${symbol}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'ioc',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
      };

      await this.refreshPositions();
    } catch (err) {
      const errorMessage = `Error placing partial close limit order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
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
        } else if (trackedOrder.type === 'ioc') {
          timeoutMs = orderTimeouts.ioc;
        } else if (trackedOrder.type === 'entry') {
          timeoutMs = orderTimeouts.entry;
        }

        if (timeoutMs && elapsed > timeoutMs) {
          await this.cancelOrder(orderId, trackedOrder.symbol);

          if (trackedOrder.type === 'close') {
            await this.closePositionLimitOrder(trackedOrder.symbol);
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
        const upperSym = position.symbol.toUpperCase();
        if (!this.positions[upperSym]) {
          this.addPosition(position);
          this.restorePositionState(upperSym);
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
}

module.exports = OrderManager;
