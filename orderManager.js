// orderManager.js
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

    // Set initial override lists from config
    this.overrideAddList = new Set(
      (config.overrideAddSymbols || []).map((sym) => sym.toUpperCase())
    );
    this.overrideRemoveList = new Set(
      (config.overrideRemoveSymbols || []).map((sym) => sym.toUpperCase())
    );

    // Rate limiter for API calls
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

    // Periodically reload dynamic configuration for overrides
    setInterval(
      () => this.reloadDynamicOverrides(),
      config.pollingIntervals.watchlistRefresh
    );

    // Allow dashboard to access orderTracking for display
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

  // Reload dynamic overrides from a separate config file if present
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

  // Methods to manage override add/remove lists
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

  // Apply override add/remove lists to the watchlist
  applyOverridesToWatchlist() {
    // Remove all symbols in overrideRemoveList from the watchlist
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

    // Add all symbols in overrideAddList to the watchlist if not already present
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
        };
        this.polygon.subscribeQuote(symbol);
        this.dashboard.logInfo(
          `Symbol ${symbol} added to watchlist due to override add list.`
        );
      }
    }

    this.dashboard.updateWatchlist(this.watchlist);
  }

  // Initialize existing positions at startup
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

  // Initialize the watchlist based on gainers and filters
  async initializeWatchlist() {
    try {
      const gainers = await this.restClient.getGainersOrLosers(
        'gainers',
        false
      );
      this.topGainers = {};

      const currentVolumeRequirement = this.getCurrentVolumeRequirement();
      const { maxSpreadCents, minCandleRangeCents } = config.watchlistFilters;

      for (const gainer of gainers) {
        const symbol = gainer.ticker.toUpperCase();
        if (symbol.includes('.')) continue;

        const gapPerc = gainer.todaysChangePerc;
        if (gapPerc < config.strategySettings.gapPercentageRequirement)
          continue;

        const currentPrice = gainer.lastQuote.P || 0;
        if (
          currentPrice < config.strategySettings.priceRange.min ||
          currentPrice > config.strategySettings.priceRange.max
        )
          continue;

        const askPrice = gainer.lastQuote.P;
        const bidPrice = gainer.lastQuote.p;
        if (askPrice === undefined || bidPrice === undefined) continue;

        const spread = askPrice - bidPrice;
        if (spread > maxSpreadCents / 100) continue;

        const minData = gainer.min;
        if (!minData || minData.h === undefined || minData.l === undefined)
          continue;

        const candleRange = minData.h - minData.l;
        if (candleRange < minCandleRangeCents / 100) continue;

        const volume = minData.av || 0;
        this.topGainers[symbol] = {
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

  // Add a symbol to the watchlist and subscribe to its quotes
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
        };
        this.polygon.subscribeQuote(symbol);
      } else {
        this.watchlist[symbol].highOfDay = hod;
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
        if (this.watchlist[symbol].hasPendingEntryOrder === undefined) {
          this.watchlist[symbol].hasPendingEntryOrder = false;
          this.watchlist[symbol].isHODFrozen = false;
          this.watchlist[symbol].executedPyramidLevels = [];
        }
      }
      this.dashboard.updateWatchlist(this.watchlist);
    } catch (err) {
      const errorMsg = `Error adding symbol ${symbol} to watchlist: ${err.message}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  // Remove a symbol from the watchlist and unsubscribe from its data streams
  removeSymbolFromWatchlist(symbol) {
    if (this.watchlist[symbol] && !this.positions[symbol]) {
      this.polygon.unsubscribeTrade(symbol);
      this.polygon.unsubscribeQuote(symbol);
      delete this.watchlist[symbol];
      this.dashboard.logInfo(`Symbol ${symbol} removed from watchlist.`);
      this.dashboard.updateWatchlist(this.watchlist);
    }
  }

  // Determine the current volume requirement based on time of day
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

  // Handle quote updates from Polygon
  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];
    const pos = this.positions[upperSymbol];

    // If we have a position, update trailing stop and handle exit if needed
    if (pos && pos.isActive) {
      await this.handlePositionQuoteUpdate(
        pos,
        upperSymbol,
        bidPrice,
        askPrice
      );
    }

    // If symbol meets volume threshold and not on watchlist, add it dynamically
    if (
      this.topGainers[upperSymbol] &&
      !this.watchlist[upperSymbol] &&
      !this.positions[upperSymbol]
    ) {
      const currentVolumeRequirement = this.getCurrentVolumeRequirement();
      const volume = this.topGainers[upperSymbol].volume;
      if (volume >= currentVolumeRequirement) {
        await this.addSymbolToWatchlist(upperSymbol);
        this.dashboard.logInfo(
          `Symbol ${upperSymbol} volume now meets threshold, added to watchlist.`
        );
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }

    if (w) {
      const {
        initialEntryOffsetCents,
        initialShareSize,
        openingOrderCooldownSeconds,
        tradeProximityCents,
      } = config.strategySettings;

      const openingOrderCooldownMs = openingOrderCooldownSeconds * 1000;
      const currentPrice = askPrice;

      // Update HOD if better price and not frozen
      if (currentPrice > w.highOfDay && !w.isHODFrozen) {
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

      // Manage Trade-Level Subscription
      const distanceToHODCents = (w.highOfDay - currentPrice) * 100;
      if (distanceToHODCents <= tradeProximityCents && !w.isSubscribedToTrade) {
        this.polygon.subscribeTrade(upperSymbol);
        w.isSubscribedToTrade = true;
        this.dashboard.logInfo(
          `Subscribed to trade-level data for ${upperSymbol} (within ${tradeProximityCents} cents of HOD).`
        );
      } else if (
        distanceToHODCents > tradeProximityCents &&
        w.isSubscribedToTrade
      ) {
        this.polygon.unsubscribeTrade(upperSymbol);
        w.isSubscribedToTrade = false;
        this.dashboard.logInfo(
          `Unsubscribed from trade-level data for ${upperSymbol} (beyond ${tradeProximityCents} cents of HOD).`
        );
      }

      // Attempt entry if conditions met (HOD + offset)
      if (
        !w.hasPosition &&
        currentPrice >= w.highOfDay + initialEntryOffsetCents / 100
      ) {
        const now = Date.now();
        const canPlaceOrder =
          (!w.lastEntryTime ||
            now - w.lastEntryTime > openingOrderCooldownMs) &&
          !this.positions[upperSymbol] &&
          !this.hasPendingOpeningOrder(upperSymbol) &&
          !w.hasPendingEntryOrder;

        if (canPlaceOrder) {
          w.lastEntryTime = Date.now();
          w.hasPendingEntryOrder = true;
          w.isHODFrozen = true; // Freeze HOD

          const targetPrice = w.highOfDay + initialEntryOffsetCents / 100;

          this.dashboard.logInfo(
            `Anticipation entry for ${upperSymbol}: targetPrice=$${targetPrice.toFixed(
              2
            )}, HOD=$${w.highOfDay.toFixed(2)}`
          );

          try {
            await this.placeEntryOrder(
              upperSymbol,
              initialShareSize,
              'buy',
              targetPrice
            );
          } catch (err) {
            w.hasPendingEntryOrder = false;
            w.isHODFrozen = false;
            const errorMsg = `Error placing entry order for ${upperSymbol}: ${err.message}`;
            logger.error(errorMsg);
            this.dashboard.logError(errorMsg);
          }
        }
      }
    }
  }

  // Handle trade updates related to positions
  async onTradeUpdate(symbol, price, size, timestamp) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];

    if (!w) return;

    // If a trade prints above HOD, enter immediately
    if (price > w.highOfDay) {
      this.dashboard.logInfo(
        `Trade breakout detected for ${upperSymbol} at $${price.toFixed(2)}`
      );
      await this.placeEntryOrder(
        upperSymbol,
        config.strategySettings.initialShareSize,
        'buy',
        price
      );

      this.polygon.unsubscribeTrade(upperSymbol);
      w.isSubscribedToTrade = false;
      this.dashboard.logInfo(
        `Unsubscribed from trade-level data for ${upperSymbol} after breakout.`
      );
    }
  }

  // Check if there's a pending opening order for a symbol
  hasPendingOpeningOrder(symbol) {
    for (const orderId in this.orderTracking) {
      const o = this.orderTracking[orderId];
      if (o.symbol === symbol && o.type === 'entry') {
        return true;
      }
    }
    return false;
  }

  // Handle quote updates related to positions
  async handlePositionQuoteUpdate(pos, symbol, bidPrice, askPrice) {
    const side = pos.side;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
    pos.currentBid = bidPrice;
    pos.currentAsk = askPrice;
    pos.currentPrice = currentPrice;

    // Calculate profit in cents to display
    pos.profitCents = (
      (currentPrice - pos.avgEntryPrice) *
      100 *
      (side === 'buy' ? 1 : -1)
    ).toFixed(2);
    const message = `Symbol: ${symbol} | Profit: ${
      pos.profitCents
    }¢ | Current Price: $${currentPrice.toFixed(2)}`;
    this.dashboard.logInfo(message);

    // 1. Check Stop Conditions First
    if (!pos.stopTriggered) {
      const stopTriggered =
        (side === 'buy' && bidPrice <= pos.stopPrice) ||
        (side === 'sell' && askPrice >= pos.stopPrice);

      if (stopTriggered) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${symbol}. Closing position immediately.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        pos.isProcessing = false; // Clear any processing state to handle stop
        await this.closePositionMarketOrder(symbol);
        return; // Stop processing here since stop takes priority
      }
    }

    // 2. Handle Trailing Stop Logic
    if (!pos.trailingStopActive && pos.qty > 0) {
      // Activate trailing stop immediately upon position open
      pos.trailingStopActive = true;
      pos.trailingStopMaxPrice = currentPrice;
      pos.trailingStopLastUpdatePrice = currentPrice;
      const offsetCents =
        config.strategySettings.initialTrailingStopOffsetCents;
      pos.trailingStopPrice = pos.trailingStopMaxPrice - offsetCents / 100;
      pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(2)}`;
      const initMsg = `Trailing stop activated for ${symbol} at $${pos.trailingStopPrice.toFixed(
        2
      )}. Will close if price falls below this level.`;
      logger.info(initMsg);
      this.dashboard.logInfo(initMsg);
      this.dashboard.updatePositions(Object.values(this.positions));
    }

    if (pos.trailingStopActive && pos.qty > 0) {
      this.updateTrailingStop(pos, symbol, currentPrice);
    }

    // 3. Check and Execute Pyramiding if Not Processing
    if (!pos.isProcessing && pos.qty > 0 && pos.side === 'buy') {
      await this.checkAndExecutePyramiding(pos, symbol, currentPrice);
    }
  }

  // Update the trailing stop based on current price
  async updateTrailingStop(pos, symbol, currentPrice) {
    const incrementCents = config.strategySettings.trailingStopIncrementCents;
    const increment = incrementCents / 100;

    if (pos.side === 'buy') {
      // If new price sets a new max
      if (currentPrice > (pos.trailingStopMaxPrice || currentPrice)) {
        const priceIncrease =
          currentPrice - (pos.trailingStopLastUpdatePrice || currentPrice);
        if (priceIncrease >= increment) {
          const incrementsToRaise = Math.floor(priceIncrease / increment);
          pos.trailingStopPrice += incrementsToRaise * increment;
          pos.trailingStopLastUpdatePrice += incrementsToRaise * increment;
          pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(
            2
          )}`;

          const updateMsg = `Trailing stop for ${symbol} raised to $${pos.trailingStopPrice.toFixed(
            2
          )}. Current Price: $${currentPrice.toFixed(2)}`;
          logger.info(updateMsg);
          this.dashboard.logInfo(updateMsg);
          this.dashboard.updatePositions(Object.values(this.positions));
        }
        pos.trailingStopMaxPrice = currentPrice;
      }

      // If current price falls below trailing stop, close position
      if (currentPrice < pos.trailingStopPrice) {
        const stopMsg = `Trailing stop hit for ${symbol} at $${pos.trailingStopPrice.toFixed(
          2
        )}. Closing entire position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
      }
    }
  }

  // Check and execute pyramiding based on configuration
  async checkAndExecutePyramiding(pos, symbol, currentPrice) {
    const pyramidLevels = config.orderSettings.pyramidLevels;

    for (let i = 0; i < pyramidLevels.length; i++) {
      const level = pyramidLevels[i];

      // Check if this pyramid level has already been executed
      if (pos.executedPyramidLevels.includes(i)) {
        continue; // Skip already executed levels
      }

      const requiredPriceIncrease = level.priceIncreaseCents / 100;
      const targetPrice = pos.avgEntryPrice + requiredPriceIncrease;

      // For long positions, check if currentPrice >= targetPrice
      if (pos.side === 'buy' && currentPrice >= targetPrice) {
        // Set isProcessing to prevent multiple pyramid orders simultaneously
        pos.isProcessing = true;

        const qtyToAdd = Math.floor(
          (pos.initialQty * level.percentToAdd) / 100
        );
        if (qtyToAdd > 0) {
          await this.placePyramidOrder(
            pos,
            symbol,
            qtyToAdd,
            level.offsetCents,
            targetPrice,
            i
          );
        } else {
          pos.isProcessing = false; // No shares to add, reset processing
        }
      }
    }
  }

  // Place a pyramid order to add shares to an existing position
  async placePyramidOrder(
    pos,
    symbol,
    qtyToAdd,
    offsetCents,
    targetPrice,
    levelIndex
  ) {
    const side = pos.side;

    let limitPrice;
    if (side === 'buy') {
      limitPrice = targetPrice + offsetCents / 100;
    } else {
      limitPrice = targetPrice - offsetCents / 100;
    }

    // Ensure that limitPrice is positive
    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${symbol}. Cannot place ${side} order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
      pos.isProcessing = false;
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

    const orderMessage = `Attempting to place pyramid order: ${JSON.stringify(
      order
    )} | Target Price: $${targetPrice.toFixed(
      2
    )} | Limit Price: $${limitPrice.toFixed(2)}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Pyramid order placed for ${qtyToAdd} shares of ${symbol} at $${limitPrice.toFixed(
        2
      )}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'pyramid',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
        pyramidLevel: levelIndex,
      };

      // Mark this pyramid level as executed to prevent re-triggering
      pos.executedPyramidLevels.push(levelIndex);
      this.dashboard.updatePositions(Object.values(this.positions));
    } catch (err) {
      const errorMessage = `Error placing pyramid order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    } finally {
      // Reset isProcessing regardless of success or failure
      pos.isProcessing = false;
    }
  }

  // Place an entry order when breakout occurs
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
    let limitPrice = targetPrice + entryLimitOffsetCents / 100; // For a buy

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${symbol}. Cannot place entry order.`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
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

    const orderMessage = `Placing entry order: ${JSON.stringify(order)}`;
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
      };

      this.polygon.subscribeTrade(symbol);
      this.watchlist[symbol].isSubscribedToTrade = true;
    } catch (err) {
      if (this.watchlist[symbol])
        this.watchlist[symbol].hasPendingEntryOrder = false;
      const errorMsg = `Error placing entry order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    }
  }

  // Close a position using a limit order
  async closePositionMarketOrder(symbol) {
    const pos = this.positions[symbol];
    if (!pos) {
      const warnMessage = `No position found for ${symbol} when attempting to close.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    const qty = pos.qty;
    if (qty <= 0) {
      const warnMessage = `Position qty ${qty} for ${symbol}, nothing to close.`;
      logger.warn(warnMessage);
      this.dashboard.logWarning(warnMessage);
      return;
    }

    const side = pos.side === 'buy' ? 'sell' : 'buy';
    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    let limitPrice;

    if (side === 'sell') {
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    } else {
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
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
      const errorMessage = `Error placing close order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  // Poll and update order statuses, handle fills and timeouts
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
          // Order no longer open
          delete this.orderTracking[orderId];

          if (trackedOrder.type === 'entry') {
            // Reset the pending entry order flag and unfreeze HOD
            if (this.watchlist[trackedOrder.symbol]) {
              this.watchlist[trackedOrder.symbol].hasPendingEntryOrder = false;
              this.watchlist[trackedOrder.symbol].isHODFrozen = false;
            }
          }

          continue;
        }

        const elapsed = now - trackedOrder.placedAt;
        let timeoutMs = null;

        if (trackedOrder.type === 'limit') {
          timeoutMs = orderTimeouts.limit;
        } else if (trackedOrder.type === 'pyramid') {
          timeoutMs = orderTimeouts.pyramid;
        } else if (trackedOrder.type === 'close') {
          timeoutMs = orderTimeouts.close;
        } else if (trackedOrder.type === 'entry') {
          timeoutMs = orderTimeouts.entry;
        }

        if (timeoutMs && elapsed > timeoutMs) {
          // Timeout reached, cancel order
          await this.cancelOrder(orderId, trackedOrder.symbol);

          if (trackedOrder.type === 'close') {
            await this.closePositionMarketOrder(trackedOrder.symbol);
          }

          if (trackedOrder.type === 'entry') {
            // Reset the pending entry order flag and unfreeze HOD
            if (this.watchlist[trackedOrder.symbol]) {
              this.watchlist[trackedOrder.symbol].hasPendingEntryOrder = false;
              this.watchlist[trackedOrder.symbol].isHODFrozen = false;
            }
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
            if (
              trackedOrder.type === 'limit' ||
              trackedOrder.type === 'close'
            ) {
              pos.qty -= filledQty;
              pos.qty = Math.max(pos.qty, 0);
              const fillMessage = `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`;
              logger.info(fillMessage);
              this.dashboard.logInfo(fillMessage);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);

              this.dashboard.updatePositions(Object.values(this.positions));
              if (pos.qty <= 0) this.removePosition(trackedOrder.symbol);
            } else if (trackedOrder.type === 'pyramid') {
              // Update position avgEntryPrice and qty
              pos.qty += filledQty;
              const totalCost =
                pos.avgEntryPrice * pos.initialQty +
                filledQty * parseFloat(order.limit_price || pos.currentPrice);
              pos.avgEntryPrice = totalCost / pos.qty;

              const fillMessage = `Pyramid order ${
                order.id
              } filled ${filledQty} qty for ${trackedOrder.symbol}. New qty: ${
                pos.qty
              }, Avg Entry Price: $${pos.avgEntryPrice.toFixed(2)}`;
              logger.info(fillMessage);
              this.dashboard.logInfo(fillMessage);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);

              this.dashboard.updatePositions(Object.values(this.positions));

              // Mark pyramid level as executed
              if (trackedOrder.pyramidLevel !== undefined) {
                pos.executedPyramidLevels.push(trackedOrder.pyramidLevel);
              }

              // Reset isProcessing flag if this was a pyramid order
              pos.isProcessing = false;
            } else if (trackedOrder.type === 'entry') {
              // Update position details if entry order filled
              pos.qty += filledQty;
              pos.avgEntryPrice =
                (pos.avgEntryPrice * (pos.qty - filledQty) +
                  filledQty *
                    parseFloat(order.limit_price || pos.currentPrice)) /
                pos.qty;

              const fillMessage = `Entry order ${
                order.id
              } filled ${filledQty} qty for ${trackedOrder.symbol}. New qty: ${
                pos.qty
              }, Avg Entry Price: $${pos.avgEntryPrice.toFixed(2)}`;
              logger.info(fillMessage);
              this.dashboard.logInfo(fillMessage);

              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);

              this.dashboard.updatePositions(Object.values(this.positions));

              // Reset the pending entry order flag and unfreeze HOD
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
    } catch (err) {
      const errorMessage = `Error polling order statuses: ${err.message}`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    } finally {
      this.isPolling = false;
    }
  }

  // Cancel an order by ID
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

  // Refresh positions by fetching the latest data from Alpaca
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

          if (pos.trailingStopActive) {
            // Ensure description shows TRAILSTOP
            pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(
              2
            )}`;
          }

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
    }
  }

  // Retry operation with exponential backoff
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
      // For other errors, do not retry
      throw err;
    }
  }

  // Sleep utility
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Generate unique client order IDs
  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  // Add a new position to the system
  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = position.side === 'long' ? 'buy' : 'sell';
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
      isActive: true,
      stopPrice: initialStopPrice,
      stopCents: initialStopOffsetCents,
      stopDescription: `Initial Stop @ $${initialStopPrice.toFixed(
        2
      )} (${initialStopOffsetCents}¢ below HOD)`,
      stopTriggered: false,
      trailingStopActive: false,
      trailingStopPrice: null,
      trailingStopMaxPrice: null,
      trailingStopLastUpdatePrice: null,
      executedPyramidLevels: [], // Initialize executed pyramid levels
      totalPyramidLevels: config.orderSettings.pyramidLevels.length,
      isProcessing: false, // Initialize processing flag
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

  // Remove a position entirely
  removePosition(symbol) {
    delete this.positions[symbol];
    this.dashboard.logInfo(`Position for ${symbol} removed.`);
    this.dashboard.updatePositions(Object.values(this.positions));
  }
}

module.exports = OrderManager;
