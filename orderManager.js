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

    // Allow dashboard to access orderTracking for display purposes
    if (
      this.dashboard &&
      typeof this.dashboard.setOrderTracking === 'function'
    ) {
      this.dashboard.setOrderTracking(this.orderTracking);
    }

    // Add Global Unhandled Rejection Handler
    process.on('unhandledRejection', (reason, promise) => {
      const errorMsg = `Unhandled Rejection at: ${promise}, reason: ${reason}`;
      logger.error(errorMsg);
      this.dashboard.logError(errorMsg);
    });
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

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];
    const pos = this.positions[upperSymbol];

    if (pos && pos.isActive) {
      await this.handlePositionQuoteUpdate(
        pos,
        upperSymbol,
        bidPrice,
        askPrice
      );
    }

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

      // Update HOD if currentPrice exceeds known HOD and HOD is not frozen
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

      // Manage Trade-Level Subscription using tradeProximityCents
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
          `Unsubscribed from trade-level data for ${upperSymbol} (moved beyond ${tradeProximityCents} cents of HOD).`
        );
      }

      // Attempt anticipation entry order if conditions met:
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

          const targetPrice = w.highOfDay + initialEntryOffsetCents / 100;
          w.isHODFrozen = true; // Freeze HOD during pending entry

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
            w.isHODFrozen = false; // Unfreeze HOD if order fails
            const errorMsg = `Error placing entry order for ${upperSymbol}: ${err.message}`;
            logger.error(errorMsg);
            this.dashboard.logError(errorMsg);
          }
        }
      }
    }
  }

  async onTradeUpdate(symbol, price, size, timestamp) {
    const upperSymbol = symbol.toUpperCase();
    const w = this.watchlist[upperSymbol];

    if (!w) return;

    // Check if the trade price exceeds HOD
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

      // After placing the entry order, unsubscribe from trade-level data
      this.polygon.unsubscribeTrade(upperSymbol);
      w.isSubscribedToTrade = false;
      this.dashboard.logInfo(
        `Unsubscribed from trade-level data for ${upperSymbol} after breakout.`
      );
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

  async handlePositionQuoteUpdate(pos, symbol, bidPrice, askPrice) {
    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
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

    // Stop conditions
    if (!pos.stopTriggered) {
      if (
        (side === 'buy' && bidPrice <= pos.stopPrice) ||
        (side === 'sell' && askPrice >= pos.stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${symbol}. Closing position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
        return;
      }
    }

    // Profit targets
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
        qtyToClose = Math.min(qtyToClose, pos.qty); // Ensure not exceeding available shares

        if (qtyToClose > 0) {
          await this.placeLimitOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
          pos.profitTargetsHit += 1;

          // Calculate and update dynamic stop
          const dynamicStop = this.calculateDynamicStopPrice(
            pos.profitTargetsHit,
            pos.avgEntryPrice,
            pos.side
          );
          if (dynamicStop) {
            pos.stopPrice = dynamicStop.stopPrice;
            pos.stopCents = dynamicStop.stopCents;
            pos.stopDescription = `Stop ${pos.stopCents}¢ ${
              pos.stopCents > 0 ? 'below' : pos.stopCents < 0 ? 'above' : 'at'
            } avg price`;
            const stopPriceMessage = `Adjusted stop price for ${symbol} to $${pos.stopPrice.toFixed(
              2
            )} after hitting ${pos.profitTargetsHit} profit targets.`;
            this.dashboard.logInfo(stopPriceMessage);
          }

          // Handle Pyramiding (now decoupled from profit targets)
          await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

          pos.isProcessing = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }

    // Implement Separate Pyramiding Based on Price
    await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

    // Check if final profit target hit, start trailing stop
    if (
      pos.profitTargetsHit >= profitTargets.length &&
      pos.qty > 0 &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      pos.trailingStopMaxPrice = currentPrice;
      pos.trailingStopLastUpdatePrice = currentPrice;

      const offsetCents =
        config.strategySettings.initialTrailingStopOffsetCents;
      pos.trailingStopPrice = pos.trailingStopMaxPrice - offsetCents / 100;
      pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(2)}`;

      const initMsg = `Trailing stop activated for ${symbol} at $${pos.trailingStopPrice.toFixed(
        2
      )}. Monitoring for price drops below this level.`;
      logger.info(initMsg);
      this.dashboard.logInfo(initMsg);

      this.dashboard.updatePositions(Object.values(this.positions));
    }

    // If trailing stop is active, update it
    if (pos.trailingStopActive && pos.qty > 0) {
      this.updateTrailingStop(pos, symbol, currentPrice);
    }
  }

  async checkAndExecutePyramiding(pos, symbol, currentPrice) {
    const pyramidLevels = config.orderSettings.pyramidLevels;

    for (let i = 0; i < pyramidLevels.length; i++) {
      const level = pyramidLevels[i];

      // Check if this pyramid level has already been hit
      if (pos.executedPyramidLevels && pos.executedPyramidLevels.includes(i)) {
        continue; // Skip already executed levels
      }

      const requiredPriceIncrease = level.priceIncreaseCents / 100;
      const targetPrice = pos.avgEntryPrice + requiredPriceIncrease;

      // For long positions, check if currentPrice >= targetPrice
      if (pos.side === 'buy' && currentPrice >= targetPrice) {
        // Execute pyramid order
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
          // Mark this pyramid level as executed
          if (!pos.executedPyramidLevels) pos.executedPyramidLevels = [];
          pos.executedPyramidLevels.push(i);
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }

      // For short positions, similar logic can be implemented
      // if (pos.side === 'sell' && currentPrice <= targetPrice) {
      //   // Execute pyramid order
      // }
    }
  }

  async placePyramidOrder(pos, qtyToAdd, offsetCents, targetPrice, levelIndex) {
    const symbol = pos.symbol;
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
      return;
    }

    const order = {
      symbol,
      qty: qtyToAdd.toFixed(0),
      side,
      type: 'limit', // Changed from 'ioc' to 'limit'
      time_in_force: 'day', // Ensure DAY limit orders for extended hours
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
        type: 'pyramid', // Changed from 'ioc' to 'pyramid'
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
        pyramidLevel: levelIndex, // Track which pyramid level this order belongs to
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

  async placeLimitOrder(symbol, qty, side) {
    const pos = this.positions[symbol];
    if (!pos) {
      const msg = `Cannot place limit order for ${symbol} - no active position.`;
      this.dashboard.logInfo(msg);
      logger.info(msg);
      return;
    }

    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    let limitPrice;

    if (side === 'buy') {
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
    } else {
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    }

    // Ensure that limitPrice is positive
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
      time_in_force: 'day', // Ensure DAY limit orders for extended hours
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('LIMIT'),
    };

    const orderMessage = `Attempting to place limit order: ${JSON.stringify(
      order
    )} | Limit Price: $${limitPrice.toFixed(2)}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Limit order placed for ${qty} shares of ${symbol} at $${limitPrice.toFixed(
        2
      )}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'limit', // Changed from 'ioc' to 'limit'
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

    // Ensure that limitPrice is positive
    if (limitPrice <= 0 || isNaN(limitPrice)) {
      const errorMessage = `Invalid limit price for ${symbol}. Cannot place ${side} order.`;
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
      time_in_force: 'day', // Ensure DAY limit orders for extended hours
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('ENTRY'),
    };

    const orderMessage = `Attempting to place breakout anticipation entry order: ${JSON.stringify(
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
      };

      // Subscribe to trade-level data since we're near HOD
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
              pos.qty = Math.max(pos.qty, 0); // Ensure non-negative
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

              this.dashboard.updatePositions(Object.values(this.positions));

              if (trackedOrder.type === 'entry') {
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

    // Ensure that limitPrice is positive
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
      type: 'limit', // Changed from 'ioc' to 'limit'
      time_in_force: 'day', // Ensure DAY limit orders for extended hours
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
        type: 'close', // Changed from 'ioc' to 'close'
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

  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (
        err.code === 'ENOTFOUND' || // Handle DNS errors
        (err.response &&
          (err.response.status === 429 ||
            (err.response.status >= 500 && err.response.status < 600)))
      ) {
        // Retry on 429 and 5xx errors or DNS errors
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  async handlePositionQuoteUpdate(pos, symbol, bidPrice, askPrice) {
    // This function has been updated to handle LIMIT orders instead of IOC orders
    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
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

    // Stop conditions based on current stopPrice
    if (!pos.stopTriggered) {
      if (
        (side === 'buy' && bidPrice <= pos.stopPrice) ||
        (side === 'sell' && askPrice >= pos.stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${symbol}. Closing position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
        return;
      }
    }

    // Profit targets
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
        qtyToClose = Math.min(qtyToClose, pos.qty); // Ensure not exceeding available shares

        if (qtyToClose > 0) {
          await this.placeLimitOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
          pos.profitTargetsHit += 1;

          // Calculate and update dynamic stop
          const dynamicStop = this.calculateDynamicStopPrice(
            pos.profitTargetsHit,
            pos.avgEntryPrice,
            pos.side
          );
          if (dynamicStop) {
            pos.stopPrice = dynamicStop.stopPrice;
            pos.stopCents = dynamicStop.stopCents;
            pos.stopDescription = `Stop ${pos.stopCents}¢ ${
              pos.stopCents > 0 ? 'below' : pos.stopCents < 0 ? 'above' : 'at'
            } avg price`;
            const stopPriceMessage = `Adjusted stop price for ${symbol} to $${pos.stopPrice.toFixed(
              2
            )} after hitting ${pos.profitTargetsHit} profit targets.`;
            this.dashboard.logInfo(stopPriceMessage);
          }

          // Handle Pyramiding (now decoupled from profit targets)
          await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

          pos.isProcessing = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }

    // Implement Separate Pyramiding Based on Price
    await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

    // Check if final profit target hit, start trailing stop
    if (
      pos.profitTargetsHit >= profitTargets.length &&
      pos.qty > 0 &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      pos.trailingStopMaxPrice = currentPrice;
      pos.trailingStopLastUpdatePrice = currentPrice;

      const offsetCents =
        config.strategySettings.initialTrailingStopOffsetCents;
      pos.trailingStopPrice = pos.trailingStopMaxPrice - offsetCents / 100;
      pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(2)}`;

      const initMsg = `Trailing stop activated for ${symbol} at $${pos.trailingStopPrice.toFixed(
        2
      )}. Monitoring for price drops below this level.`;
      logger.info(initMsg);
      this.dashboard.logInfo(initMsg);

      this.dashboard.updatePositions(Object.values(this.positions));
    }

    // If trailing stop is active, update it
    if (pos.trailingStopActive && pos.qty > 0) {
      this.updateTrailingStop(pos, symbol, currentPrice);
    }
  }

  async updateTrailingStop(pos, symbol, currentPrice) {
    const incrementCents = config.strategySettings.trailingStopIncrementCents;
    const increment = incrementCents / 100;

    if (pos.side === 'buy') {
      // If new price sets a new max
      if (currentPrice > pos.trailingStopMaxPrice) {
        const priceIncrease = currentPrice - pos.trailingStopLastUpdatePrice;
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

      // If current price falls below trailing stop price, close position
      if (currentPrice < pos.trailingStopPrice) {
        const stopMsg = `Trailing stop hit for ${symbol} at $${pos.trailingStopPrice.toFixed(
          2
        )}. Closing remaining position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
      }
    }
  }

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

    // Retrieve HOD from watchlist
    const hod = w.highOfDay;
    if (!hod) {
      const msg = `High of Day missing for ${symbol} while adding position.`;
      logger.warn(msg);
      this.dashboard.logWarning(msg);
      return;
    }

    // Calculate initial stop based on HOD minus offset cents
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
      initialHOD: hod, // Store initial HOD for stop calculation
      stopPrice: initialStopPrice, // Set initial stop price based on HOD
      stopCents: initialStopOffsetCents,
      stopDescription: `Initial Stop @ $${initialStopPrice.toFixed(
        2
      )} (${initialStopOffsetCents}¢ below HOD)`,
      stopTriggered: false,
      executedPyramidLevels: [], // Initialize executed pyramid levels
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

  async handlePositionQuoteUpdate(pos, symbol, bidPrice, askPrice) {
    // This function has been updated to handle LIMIT orders instead of IOC orders
    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
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

    // Stop conditions based on current stopPrice
    if (!pos.stopTriggered) {
      if (
        (side === 'buy' && bidPrice <= pos.stopPrice) ||
        (side === 'sell' && askPrice >= pos.stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${symbol}. Closing position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
        return;
      }
    }

    // Profit targets
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
        qtyToClose = Math.min(qtyToClose, pos.qty); // Ensure not exceeding available shares

        if (qtyToClose > 0) {
          await this.placeLimitOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
          pos.profitTargetsHit += 1;

          // Calculate and update dynamic stop
          const dynamicStop = this.calculateDynamicStopPrice(
            pos.profitTargetsHit,
            pos.avgEntryPrice,
            pos.side
          );
          if (dynamicStop) {
            pos.stopPrice = dynamicStop.stopPrice;
            pos.stopCents = dynamicStop.stopCents;
            pos.stopDescription = `Stop ${pos.stopCents}¢ ${
              pos.stopCents > 0 ? 'below' : pos.stopCents < 0 ? 'above' : 'at'
            } avg price`;
            const stopPriceMessage = `Adjusted stop price for ${symbol} to $${pos.stopPrice.toFixed(
              2
            )} after hitting ${pos.profitTargetsHit} profit targets.`;
            this.dashboard.logInfo(stopPriceMessage);
          }

          // Handle Pyramiding (now decoupled from profit targets)
          await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

          pos.isProcessing = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }

    // Implement Separate Pyramiding Based on Price
    await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

    // Check if final profit target hit, start trailing stop
    if (
      pos.profitTargetsHit >= profitTargets.length &&
      pos.qty > 0 &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      pos.trailingStopMaxPrice = currentPrice;
      pos.trailingStopLastUpdatePrice = currentPrice;

      const offsetCents =
        config.strategySettings.initialTrailingStopOffsetCents;
      pos.trailingStopPrice = pos.trailingStopMaxPrice - offsetCents / 100;
      pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(2)}`;

      const initMsg = `Trailing stop activated for ${symbol} at $${pos.trailingStopPrice.toFixed(
        2
      )}. Monitoring for price drops below this level.`;
      logger.info(initMsg);
      this.dashboard.logInfo(initMsg);

      this.dashboard.updatePositions(Object.values(this.positions));
    }

    // If trailing stop is active, update it
    if (pos.trailingStopActive && pos.qty > 0) {
      this.updateTrailingStop(pos, symbol, currentPrice);
    }
  }

  async updateTrailingStop(pos, symbol, currentPrice) {
    const incrementCents = config.strategySettings.trailingStopIncrementCents;
    const increment = incrementCents / 100;

    if (pos.side === 'buy') {
      // If new price sets a new max
      if (currentPrice > pos.trailingStopMaxPrice) {
        const priceIncrease = currentPrice - pos.trailingStopLastUpdatePrice;
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

      // If current price falls below trailing stop price, close position
      if (currentPrice < pos.trailingStopPrice) {
        const stopMsg = `Trailing stop hit for ${symbol} at $${pos.trailingStopPrice.toFixed(
          2
        )}. Closing remaining position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
      }
    }
  }

  async handlePositionQuoteUpdate(pos, symbol, bidPrice, askPrice) {
    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;
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

    // Stop conditions based on current stopPrice
    if (!pos.stopTriggered) {
      if (
        (side === 'buy' && bidPrice <= pos.stopPrice) ||
        (side === 'sell' && askPrice >= pos.stopPrice)
      ) {
        pos.stopTriggered = true;
        const stopMsg = `Stop condition met for ${symbol}. Closing position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        await this.closePositionMarketOrder(symbol);
        return;
      }
    }

    // Profit targets
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
        qtyToClose = Math.min(qtyToClose, pos.qty); // Ensure not exceeding available shares

        if (qtyToClose > 0) {
          await this.placeLimitOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
          pos.profitTargetsHit += 1;

          // Calculate and update dynamic stop
          const dynamicStop = this.calculateDynamicStopPrice(
            pos.profitTargetsHit,
            pos.avgEntryPrice,
            pos.side
          );
          if (dynamicStop) {
            pos.stopPrice = dynamicStop.stopPrice;
            pos.stopCents = dynamicStop.stopCents;
            pos.stopDescription = `Stop ${pos.stopCents}¢ ${
              pos.stopCents > 0 ? 'below' : pos.stopCents < 0 ? 'above' : 'at'
            } avg price`;
            const stopPriceMessage = `Adjusted stop price for ${symbol} to $${pos.stopPrice.toFixed(
              2
            )} after hitting ${pos.profitTargetsHit} profit targets.`;
            this.dashboard.logInfo(stopPriceMessage);
          }

          // Handle Pyramiding (now decoupled from profit targets)
          await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

          pos.isProcessing = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }

    // Implement Separate Pyramiding Based on Price
    await this.checkAndExecutePyramiding(pos, symbol, currentPrice);

    // Check if final profit target hit, start trailing stop
    if (
      pos.profitTargetsHit >= profitTargets.length &&
      pos.qty > 0 &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      pos.trailingStopMaxPrice = currentPrice;
      pos.trailingStopLastUpdatePrice = currentPrice;

      const offsetCents =
        config.strategySettings.initialTrailingStopOffsetCents;
      pos.trailingStopPrice = pos.trailingStopMaxPrice - offsetCents / 100;
      pos.stopDescription = `TRAILSTOP @ $${pos.trailingStopPrice.toFixed(2)}`;

      const initMsg = `Trailing stop activated for ${symbol} at $${pos.trailingStopPrice.toFixed(
        2
      )}. Monitoring for price drops below this level.`;
      logger.info(initMsg);
      this.dashboard.logInfo(initMsg);

      this.dashboard.updatePositions(Object.values(this.positions));
    }

    // If trailing stop is active, update it
    if (pos.trailingStopActive && pos.qty > 0) {
      this.updateTrailingStop(pos, symbol, currentPrice);
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
          // Order is no longer open
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
              pos.qty = Math.max(pos.qty, 0); // Ensure non-negative
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

              this.dashboard.updatePositions(Object.values(this.positions));

              if (trackedOrder.type === 'entry') {
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

    // Ensure that limitPrice is positive
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
      type: 'limit', // Changed from 'ioc' to 'limit'
      time_in_force: 'day', // Ensure DAY limit orders for extended hours
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
        type: 'close', // Changed from 'ioc' to 'close'
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

  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (
        err.code === 'ENOTFOUND' || // Handle DNS errors
        (err.response &&
          (err.response.status === 429 ||
            (err.response.status >= 500 && err.response.status < 600)))
      ) {
        // Retry on 429 and 5xx errors or DNS errors
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  async checkAndExecutePyramiding(pos, symbol, currentPrice) {
    const pyramidLevels = config.orderSettings.pyramidLevels;

    for (let i = 0; i < pyramidLevels.length; i++) {
      const level = pyramidLevels[i];

      // Check if this pyramid level has already been hit
      if (pos.executedPyramidLevels && pos.executedPyramidLevels.includes(i)) {
        continue; // Skip already executed levels
      }

      const requiredPriceIncrease = level.priceIncreaseCents / 100;
      const targetPrice = pos.avgEntryPrice + requiredPriceIncrease;

      // For long positions, check if currentPrice >= targetPrice
      if (pos.side === 'buy' && currentPrice >= targetPrice) {
        // Execute pyramid order
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
          // Mark this pyramid level as executed
          if (!pos.executedPyramidLevels) pos.executedPyramidLevels = [];
          pos.executedPyramidLevels.push(i);
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }

      // For short positions, similar logic can be implemented
      // if (pos.side === 'sell' && currentPrice <= targetPrice) {
      //   // Execute pyramid order
      // }
    }
  }

  async handlePositionQuoteUpdate(pos, symbol, bidPrice, askPrice) {
    // This function is now integrated within handlePositionQuoteUpdate to avoid duplication
    // You can remove this function if it's redundant
  }
}

module.exports = OrderManager;
