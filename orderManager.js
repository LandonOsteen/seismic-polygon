const { alpaca } = require('./alpaca'); // Still required for order execution with Alpaca
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

    // Polygon callbacks
    this.polygon.onTrade = async (symbol, price) => {
      await this.onTradeUpdate(symbol, price);
    };

    this.polygon.onQuote = async (symbol, bidPrice, askPrice) => {
      await this.onQuoteUpdate(symbol, bidPrice, askPrice);
    };

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

  overrideHOD(symbol, newHod) {
    const upper = symbol.toUpperCase();
    if (this.watchlist[upper]) {
      this.watchlist[upper].highOfDay = newHod;
      this.watchlist[upper].overriddenHod = true;
      this.dashboard.logInfo(
        `HOD for ${upper} overridden to $${newHod.toFixed(2)}`
      );
      logger.info(`HOD for ${upper} overridden to $${newHod.toFixed(2)}`);
      this.dashboard.updateWatchlist(this.watchlist);
    } else {
      this.dashboard.logWarning(
        `Cannot override HOD for ${upper}. Not in watchlist.`
      );
    }
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
      const { minAccumulatedVolume, minOneMinuteRange } =
        config.strategySettings;

      for (const gainer of gainers) {
        const symbol = gainer.ticker.toUpperCase();
        if (symbol.includes('.')) continue;

        const gapPerc = gainer.todaysChangePerc;
        if (gapPerc < config.strategySettings.gapPercentageRequirement)
          continue;

        // P = ask price, p = bid price per updated logic
        const ask = gainer.lastQuote.P || 0;
        const bid = gainer.lastQuote.p || 0;
        const spread = ask - bid;
        if (spread > 0.1) continue; // skip if spread more than 10 cents

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

        // Use the configured minimum range and accumulated volume thresholds
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

    // Default dynamic stop before any targets hit
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
      stopPrice,
      stopCents,
      stopDescription: dynamicStop
        ? `Stop ${stopCents}¢ ${
            stopCents > 0 ? 'above' : stopCents < 0 ? 'below' : 'at'
          } avg price`
        : 'N/A',
      stopTriggered: false,
      pyramidLevelsHit: 0,
      totalPyramidLevels: config.orderSettings.pyramidLevels.length,
      trailingStopActive: false,
      trailingStopPrice: null,
      trailingStopMaxPrice: null,
      trailingStopLastUpdatePrice: null,
      initialHOD: null,
      usingInitialStop: false,
      tradeIntervals: [],
      trailingStopIntervalHandle: null,
      lowestIntervalLow: null,
    };

    const message = `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`;
    logger.info(message);
    this.dashboard.logInfo(message);

    this.polygon.subscribe(symbol);
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
        this.polygon.unsubscribe(symbol);
      }

      this.dashboard.updatePositions(Object.values(this.positions));

      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPosition = false;
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }
  }

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];

    // Subscribe to trades if within 20 cents of HOD
    if (w && !w.overriddenHod && w.highOfDay && w.highOfDay - askPrice <= 0.2) {
      this.polygon.subscribeTrades(upperSymbol);
    }

    const pos = this.positions[upperSymbol];
    if (pos && pos.isActive) {
      // Update position prices from polygon quotes
      this.updatePositionPricesFromQuote(pos, bidPrice, askPrice);
      this.evaluateStopsAndTargets(pos, upperSymbol);
    }

    // Update HOD if price sets a new HOD
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

    // Attempt entry when a trade prints above HOD + offset
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
            triggerPrice,
            w.highOfDay
          );
        }
      }
    }

    // For trailing stop intervals after targets are hit
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

  evaluateStopsAndTargets(pos, symbol) {
    const side = pos.side;

    // Initial stop below HOD before first target hit
    if (pos.usingInitialStop && pos.profitTargetsHit < 1) {
      const stopPrice = pos.stopPrice;
      if (
        (side === 'buy' && pos.currentBid <= stopPrice) ||
        (side === 'sell' && pos.currentAsk >= stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMsg = `Initial stop below HOD triggered for ${symbol}. Closing position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        this.closePositionMarketOrder(symbol);
        return;
      }
    } else {
      // After first target hit, use dynamic stop
      if (!pos.stopTriggered && pos.stopPrice !== null) {
        if (
          (side === 'buy' && pos.currentBid <= pos.stopPrice) ||
          (side === 'sell' && pos.currentAsk >= pos.stopPrice)
        ) {
          pos.stopTriggered = true;
          const stopMsg = `Stop condition met for ${symbol}. Closing position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(symbol);
          return;
        }
      }
    }

    // Check profit targets
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
          this.placeIOCOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          ).then(() => {
            pos.profitTargetsHit += 1;

            if (pos.profitTargetsHit === 1) {
              // Switch to dynamic stops
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
                const stopPriceMessage = `Adjusted stop price for ${symbol} to $${pos.stopPrice.toFixed(
                  2
                )} after hitting ${pos.profitTargetsHit} profit targets.`;
                this.dashboard.logInfo(stopPriceMessage);
              }
            }

            // If all targets are hit, start trailing stop interval logic
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
      // All targets hit, trailing stop logic
      if (pos.trailingStopActive && pos.qty > 0) {
        if (pos.side === 'buy' && pos.currentPrice < pos.trailingStopPrice) {
          const stopMsg = `Trailing stop hit for ${symbol} at $${pos.trailingStopPrice.toFixed(
            2
          )}. Closing remaining position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(symbol);
        } else if (
          pos.side === 'sell' &&
          pos.currentPrice > pos.trailingStopPrice
        ) {
          const stopMsg = `Trailing stop hit for short ${symbol} at $${pos.trailingStopPrice.toFixed(
            2
          )}. Closing remaining position.`;
          logger.info(stopMsg);
          this.dashboard.logWarning(stopMsg);
          this.closePositionMarketOrder(symbol);
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
    if (pos.tradeIntervals.length === 0) return;
    const intervalLow = Math.min(...pos.tradeIntervals);
    pos.tradeIntervals = []; // reset for next interval

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

  async placeEntryOrder(symbol, qty, side, targetPrice, initialHOD) {
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

    const orderMessage = `Placing breakout entry order: ${JSON.stringify(
      order
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

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
        triggerPrice: targetPrice,
        entryOffsetUsed: entryLimitOffsetCents,
        initialHOD,
      };
    } catch (err) {
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      const errorMsg = `Error placing entry order for ${symbol}: ${err.message}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  async placePyramidOrder(pos, qtyToAdd, offsetCents) {
    const symbol = pos.symbol;
    const side = pos.side;

    const limitPrice =
      side === 'buy'
        ? pos.currentAsk + offsetCents / 100
        : pos.currentBid - offsetCents / 100;

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

    const orderMessage = `Attempting to place pyramid order: ${JSON.stringify(
      order
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Pyramid order placed for ${qtyToAdd} shares of ${symbol}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

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

  async placeIOCOrder(symbol, qty, side) {
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

    const orderMessage = `Attempting to place limit IOC order: ${JSON.stringify(
      order
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Placed limit IOC order for ${qty} shares of ${symbol}. Order ID: ${result.id}`;
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
      const errorMessage = `Error placing limit order for ${symbol}: ${
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
            await this.closePositionMarketOrder(trackedOrder.symbol);
          }
        }
      }

      // Update partial fills
      for (const order of openOrders) {
        const trackedOrder = this.orderTracking[order.id];
        if (trackedOrder) {
          const filledQty = parseFloat(order.filled_qty || '0');
          trackedOrder.filledQty = filledQty;

          const pos = this.positions[trackedOrder.symbol];
          if (pos && filledQty > 0) {
            if (trackedOrder.type === 'ioc' || trackedOrder.type === 'close') {
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

              // If this was the entry fill, set initial stop below initialHOD
              if (
                trackedOrder.type === 'entry' &&
                trackedOrder.initialHOD !== undefined &&
                pos.qty > 0
              ) {
                const initialStopBelowCents =
                  config.strategySettings.initialStopBelowHodCents || 3;
                if (pos.side === 'buy') {
                  pos.stopPrice =
                    trackedOrder.initialHOD - initialStopBelowCents / 100;
                } else {
                  pos.stopPrice =
                    trackedOrder.initialHOD + initialStopBelowCents / 100;
                }
                pos.stopDescription = `Initial stop ${initialStopBelowCents}¢ below HOD $${trackedOrder.initialHOD.toFixed(
                  2
                )}`;
                pos.initialHOD = trackedOrder.initialHOD;
                pos.usingInitialStop = true;
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

  async closePositionMarketOrder(symbol) {
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
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (
        err.response &&
        (err.response.status === 429 ||
          (err.response.status >= 500 && err.response.status < 600))
      ) {
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        let message = '';

        if (err.response.status === 429) {
          message = `Rate limit hit. Retrying in ${totalDelay.toFixed(0)}ms...`;
        } else {
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

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }
}

module.exports = OrderManager;
