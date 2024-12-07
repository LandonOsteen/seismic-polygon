const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const Bottleneck = require('bottleneck');
const PolygonRestClient = require('./polygonRestClient');
const moment = require('moment-timezone');

class OrderManager {
  constructor(dashboard, polygon) {
    this.positions = {};
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.orderTracking = {};

    this.isRefreshing = false;
    this.isPolling = false;

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

    this.restClient = new PolygonRestClient();

    this.watchlist = {};
    this.topGainers = {};

    // Initialize override sets from config
    this.overrideAddList = new Set(
      config.overrideAddSymbols.map((sym) => sym.toUpperCase())
    );
    this.overrideRemoveList = new Set(
      config.overrideRemoveSymbols.map((sym) => sym.toUpperCase())
    );

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
  }

  /**
   * Adds a symbol to the override add list (whitelist).
   * This symbol will always be included in the watchlist.
   */
  overrideAddSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideAddList.add(upperSymbol);
    logger.info(`Symbol ${upperSymbol} added to override add list.`);
    this.dashboard.logInfo(`Symbol ${upperSymbol} added to override add list.`);
    this.applyOverridesToWatchlist();
  }

  /**
   * Removes a symbol from the override add list.
   */
  clearOverrideAddSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideAddList.delete(upperSymbol);
    logger.info(`Symbol ${upperSymbol} removed from override add list.`);
    this.dashboard.logInfo(
      `Symbol ${upperSymbol} removed from override add list.`
    );
    this.applyOverridesToWatchlist();
  }

  /**
   * Adds a symbol to the override remove list (blacklist).
   * This symbol will always be excluded from the watchlist.
   */
  overrideRemoveSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideRemoveList.add(upperSymbol);
    logger.info(`Symbol ${upperSymbol} added to override remove list.`);
    this.dashboard.logInfo(
      `Symbol ${upperSymbol} added to override remove list.`
    );
    this.applyOverridesToWatchlist();
  }

  /**
   * Removes a symbol from the override remove list.
   */
  clearOverrideRemoveSymbol(symbol) {
    const upperSymbol = symbol.toUpperCase();
    this.overrideRemoveList.delete(upperSymbol);
    logger.info(`Symbol ${upperSymbol} removed from override remove list.`);
    this.dashboard.logInfo(
      `Symbol ${upperSymbol} removed from override remove list.`
    );
    this.applyOverridesToWatchlist();
  }

  /**
   * Applies manual overrides to the watchlist:
   * 1. Removes symbols listed in overrideRemoveList.
   * 2. Adds symbols listed in overrideAddList.
   */
  applyOverridesToWatchlist() {
    // Remove all symbols in overrideRemoveList from the watchlist
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

    // Add all symbols in overrideAddList to the watchlist if not already present
    for (const symbol of this.overrideAddList) {
      if (!this.watchlist[symbol]) {
        // Optionally fetch HOD if needed:
        // const hod = await this.restClient.getIntradayHigh(symbol);
        const hod = null; // If you prefer not fetching now, can do later.
        this.watchlist[symbol] = {
          highOfDay: hod,
          lastEntryTime: null,
          hasPosition: !!this.positions[symbol],
        };
        this.polygon.subscribe(symbol);
        this.dashboard.logInfo(
          `Symbol ${symbol} added to watchlist due to override add list.`
        );
      }
    }

    this.dashboard.updateWatchlist(this.watchlist);
  }

  /**
   * Initialize existing positions by fetching them from Alpaca.
   */
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

  /**
   * Initializes the watchlist by fetching top gainers and applying normal filters and overrides.
   */
  async initializeWatchlist() {
    try {
      const gainers = await this.restClient.getGainersOrLosers(
        'gainers',
        false
      );
      this.topGainers = {};

      const currentVolumeRequirement = this.getCurrentVolumeRequirement();

      for (const gainer of gainers) {
        const symbol = gainer.ticker.toUpperCase();
        if (symbol.includes('.')) continue;

        const prevClose = gainer.prevDay?.c || 0;
        const currentClose = gainer.day?.c || 0;
        if (prevClose <= 0) continue;

        const gapPerc = ((currentClose - prevClose) / prevClose) * 100;
        if (gapPerc < config.strategySettings.gapPercentageRequirement)
          continue;
        if (
          currentClose < config.strategySettings.priceRange.min ||
          currentClose > config.strategySettings.priceRange.max
        )
          continue;

        // Check volume now
        const tickerDetails = await this.restClient.getTickerDetails(symbol);
        if (
          !tickerDetails ||
          !tickerDetails.financials ||
          !tickerDetails.financials.latest
        )
          continue;
        const volume = tickerDetails.financials.latest.volume || 0;

        this.topGainers[symbol] = {
          symbol,
          dayClose: currentClose,
          prevClose,
          volume,
        };

        if (volume >= currentVolumeRequirement) {
          // Volume met, add to watchlist immediately
          await this.addSymbolToWatchlist(symbol);
        }
      }

      // Apply manual overrides after normal watchlist population
      this.applyOverridesToWatchlist();

      // Remove symbols not in top gainers or overrideAddList from the watchlist
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

  /**
   * Adds a symbol to the watchlist and subscribes to its quotes.
   * @param {string} symbol - Ticker symbol.
   */
  async addSymbolToWatchlist(symbol) {
    const hod = await this.restClient.getIntradayHigh(symbol);
    if (!this.watchlist[symbol]) {
      this.watchlist[symbol] = {
        highOfDay: hod,
        lastEntryTime: null,
        hasPosition: !!this.positions[symbol],
      };
      this.polygon.subscribe(symbol);
    } else {
      // Update HOD if symbol already existed in watchlist
      this.watchlist[symbol].highOfDay = hod;
      this.watchlist[symbol].hasPosition = !!this.positions[symbol];
    }
  }

  /**
   * Removes a symbol from the watchlist and unsubscribes from quotes if no position exists.
   * @param {string} symbol - Ticker symbol.
   */
  removeSymbolFromWatchlist(symbol) {
    if (this.watchlist[symbol] && !this.positions[symbol]) {
      this.polygon.unsubscribe(symbol);
      delete this.watchlist[symbol];
      this.dashboard.logInfo(`Symbol ${symbol} removed from watchlist.`);
    }
  }

  /**
   * Determines the current volume requirement based on time of day.
   * @returns {number} Volume requirement in shares.
   */
  getCurrentVolumeRequirement() {
    const now = moment().tz(config.timeZone);
    const hour = now.hour();
    const minute = now.minute();

    const { baseVolumeRequirement, morningVolumeRequirement } =
      config.strategySettings;

    // Pre-market: before 9:30 AM
    if (hour < 9 || (hour === 9 && minute < 30)) {
      return baseVolumeRequirement;
    }

    // From 9:30 AM to 11:00 AM
    if (
      (hour === 9 && minute >= 30) ||
      hour === 10 ||
      (hour === 11 && minute === 0)
    ) {
      return morningVolumeRequirement;
    }

    // After 11:00 AM
    if (hour > 11 || (hour === 11 && minute > 0)) {
      return baseVolumeRequirement;
    }

    return baseVolumeRequirement;
  }

  /**
   * Calculates the dynamic stop price based on profit targets hit.
   * @param {number} profitTargetsHit - Number of profit targets hit.
   * @param {number} avgEntryPrice - Average entry price.
   * @param {string} side - 'buy' or 'sell'.
   * @returns {object|null} { stopPrice, stopCents } or null if not applicable.
   */
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

  /**
   * Adds a position to the internal tracking system.
   * @param {object} position - Position object from Alpaca.
   */
  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = position.side === 'long' ? 'buy' : 'sell';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    const dynamicStop = this.calculateDynamicStopPrice(0, avgEntryPrice, side);
    const stopPrice = dynamicStop ? dynamicStop.stopPrice : null;
    const stopCents = dynamicStop ? dynamicStop.stopCents : null;
    const stopDescription = dynamicStop
      ? `Stop ${stopCents}¢ ${
          stopCents > 0 ? 'above' : stopCents < 0 ? 'below' : 'at'
        } avg price`
      : 'N/A';

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

  /**
   * Removes a position from the internal tracking system.
   * @param {string} symbol - Ticker symbol.
   */
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

  /**
   * Handles incoming quote updates for symbols.
   * @param {string} symbol - Ticker symbol.
   * @param {number} bidPrice - Current bid price.
   * @param {number} askPrice - Current ask price.
   */
  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const upperSymbol = symbol.toUpperCase();
    const pos = this.positions[upperSymbol];
    if (pos && pos.isActive) {
      await this.handlePositionQuoteUpdate(
        pos,
        upperSymbol,
        bidPrice,
        askPrice
      );
    }

    // Check if symbol is a top gainer but not in watchlist due to volume threshold
    if (
      this.topGainers[upperSymbol] &&
      !this.watchlist[upperSymbol] &&
      !this.positions[upperSymbol]
    ) {
      // Re-check volume in real-time
      const tickerDetails = await this.restClient.getTickerDetails(upperSymbol);
      if (
        tickerDetails &&
        tickerDetails.financials &&
        tickerDetails.financials.latest
      ) {
        const currentVolume = tickerDetails.financials.latest.volume || 0;
        const currentVolumeRequirement = this.getCurrentVolumeRequirement();
        if (currentVolume >= currentVolumeRequirement) {
          // Now volume is met, add symbol to watchlist immediately
          await this.addSymbolToWatchlist(upperSymbol);
          this.dashboard.logInfo(
            `Symbol ${upperSymbol} volume now meets threshold, added to watchlist.`
          );
          this.dashboard.updateWatchlist(this.watchlist);
        }
      }
    }

    // Handle watchlist symbols (checking entry conditions, updating HOD, etc.)
    if (this.watchlist[upperSymbol]) {
      const w = this.watchlist[upperSymbol];
      const { initialEntryOffsetCents, initialShareSize } =
        config.strategySettings;

      const currentPrice = askPrice;
      // Update HOD if currentPrice exceeds known HOD
      if (currentPrice > w.highOfDay) {
        const newHod = await this.restClient.getIntradayHigh(upperSymbol);
        if (newHod && newHod > w.highOfDay) {
          w.highOfDay = newHod;
          this.dashboard.logInfo(
            `HOD updated for ${upperSymbol}: $${newHod.toFixed(2)}`
          );
          this.dashboard.updateWatchlist(this.watchlist);
        }
      }

      // Check if we should place an anticipation entry order (2¢ below HOD)
      if (
        !w.hasPosition &&
        currentPrice >= w.highOfDay - 0.02 &&
        currentPrice < w.highOfDay
      ) {
        const now = Date.now();
        const cooldown = 3000; // 3-second cooldown
        const canPlaceOrder =
          !w.lastEntryTime || now - w.lastEntryTime > cooldown;

        if (canPlaceOrder) {
          const targetPrice = w.highOfDay + initialEntryOffsetCents / 100;
          this.dashboard.logInfo(
            `Anticipation entry for ${upperSymbol}: targetPrice=$${targetPrice.toFixed(
              2
            )}, HOD=$${w.highOfDay.toFixed(2)}`
          );
          await this.placeEntryOrder(
            upperSymbol,
            initialShareSize,
            'buy',
            targetPrice
          );
          w.lastEntryTime = Date.now();
        }
      }
    }
  }

  /**
   * Handles quote updates for active positions (checking profit targets, trailing stops, etc.)
   * @param {object} pos - Position object.
   * @param {string} symbol - Ticker symbol.
   * @param {number} bidPrice - Current bid price.
   * @param {number} askPrice - Current ask price.
   */
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

    // Check stop conditions
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
        qtyToClose = Math.min(qtyToClose, pos.qty);

        if (qtyToClose > 0) {
          await this.placeIOCOrder(
            symbol,
            qtyToClose,
            side === 'buy' ? 'sell' : 'buy'
          );
          pos.profitTargetsHit += 1;

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
          }
        }

        pos.isProcessing = false;
        this.dashboard.updatePositions(Object.values(this.positions));
      }
    }

    // Pyramiding levels
    const pyramidLevels = config.orderSettings.pyramidLevels;
    if (pos.pyramidLevelsHit < pyramidLevels.length) {
      const nextPyramidLevel = pyramidLevels[pos.pyramidLevelsHit];
      if (parseFloat(pos.profitCents) >= nextPyramidLevel.addInCents) {
        if (!pos.isProcessingPyramid) {
          pos.isProcessingPyramid = true;
          let qtyToAdd = Math.floor(
            pos.qty * (nextPyramidLevel.percentToAdd / 100)
          );
          if (qtyToAdd >= 1) {
            await this.placePyramidOrder(
              pos,
              qtyToAdd,
              nextPyramidLevel.offsetCents
            );
            pos.pyramidLevelsHit += 1;
          } else {
            const warnMessage = `Quantity to add < 1 for ${symbol}.`;
            logger.warn(warnMessage);
            this.dashboard.logWarning(warnMessage);
          }
          pos.isProcessingPyramid = false;
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }

    // Trailing stop activation once all profit targets are hit
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

      const initMsg = `Trailing stop activated for ${symbol} at $${pos.trailingStopPrice.toFixed(
        2
      )} (initial offset ${offsetCents}¢).`;
      logger.info(initMsg);
      this.dashboard.logInfo(initMsg);
    }

    if (pos.trailingStopActive && pos.qty > 0) {
      this.updateTrailingStop(pos, symbol, currentPrice);
    }
  }

  /**
   * Updates the trailing stop price as the price moves in increments.
   * @param {object} pos - Position object.
   * @param {string} symbol - Ticker symbol.
   * @param {number} currentPrice - Current price.
   */
  updateTrailingStop(pos, symbol, currentPrice) {
    const incrementCents = config.strategySettings.trailingStopIncrementCents;
    const increment = incrementCents / 100;

    if (pos.side === 'buy') {
      if (currentPrice > pos.trailingStopMaxPrice) {
        const priceIncrease = currentPrice - pos.trailingStopLastUpdatePrice;
        if (priceIncrease >= increment) {
          const incrementsToRaise = Math.floor(priceIncrease / increment);
          pos.trailingStopPrice += incrementsToRaise * increment;
          pos.trailingStopLastUpdatePrice += incrementsToRaise * increment;

          const updateMsg = `Trailing stop for ${symbol} updated to $${pos.trailingStopPrice.toFixed(
            2
          )}. Current Price: $${currentPrice.toFixed(2)}`;
          logger.info(updateMsg);
          this.dashboard.logInfo(updateMsg);
        }
        pos.trailingStopMaxPrice = currentPrice;
      }

      if (currentPrice < pos.trailingStopPrice) {
        const stopMsg = `Trailing stop hit for ${symbol}. Closing remaining position.`;
        logger.info(stopMsg);
        this.dashboard.logWarning(stopMsg);
        this.closePositionMarketOrder(symbol);
      }
    }
    // For short positions, implement inverted logic if needed
  }

  /**
   * Places an entry order at a specified limit price.
   * @param {string} symbol - Ticker symbol.
   * @param {number} qty - Quantity.
   * @param {string} side - 'buy' or 'sell'.
   * @param {number} price - Limit price.
   */
  async placeEntryOrder(symbol, qty, side, price) {
    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: price.toFixed(2),
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
      const successMessage = `Entry order placed for ${qty} shares of ${symbol} at $${price.toFixed(
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
      };
    } catch (err) {
      const errorMessage = `Error placing entry order for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      logger.error(errorMessage);
      this.dashboard.logError(errorMessage);
    }
  }

  /**
   * Places a pyramid order to add shares at a specified offset.
   * @param {object} pos - Position object.
   * @param {number} qtyToAdd - Quantity to add.
   * @param {number} offsetCents - Price offset in cents.
   */
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

  /**
   * Places an IOC (Immediate-Or-Cancel) limit order.
   * @param {string} symbol - Ticker symbol.
   * @param {number} qty - Quantity.
   * @param {string} side - 'buy' or 'sell'.
   */
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

    const orderMessage = `Attempting to place limit order: ${JSON.stringify(
      order
    )}`;
    logger.info(orderMessage);
    this.dashboard.logInfo(orderMessage);

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      const successMessage = `Placed limit order for ${qty} shares of ${symbol}. Order ID: ${result.id}`;
      logger.info(successMessage);
      this.dashboard.logInfo(successMessage);

      this.orderTracking[result.id] = {
        symbol,
        type: 'ioc',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
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

  /**
   * Polls open orders and updates their statuses.
   */
  async pollOrderStatuses() {
    if (this.isPolling) return;
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
                if (pos.qty <= 0) this.removePosition(trackedOrder.symbol);
              } else if (
                trackedOrder.type === 'pyramid' ||
                trackedOrder.type === 'entry'
              ) {
                pos.qty += filledQty;
                const totalCost =
                  pos.avgEntryPrice * (pos.qty - filledQty) +
                  filledQty * parseFloat(order.limit_price || pos.currentPrice);
                pos.avgEntryPrice = totalCost / pos.qty;

                const fillMessage = `Order ${
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

  /**
   * Closes a position by placing a limit order.
   * @param {string} symbol - Ticker symbol to close.
   */
  async closePositionMarketOrder(symbol) {
    const pos = this.positions[symbol];
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

  /**
   * Refreshes positions by fetching the latest positions from Alpaca.
   */
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

  /**
   * Retries an async operation with exponential backoff in case of rate limits.
   * @param {Function} operation - Async operation function.
   * @param {number} retries - Number of retries.
   * @param {number} delay - Initial delay in ms.
   */
  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (err.response && err.response.status === 429) {
        // Rate limit error
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

  /**
   * Pauses execution for the specified milliseconds.
   * @param {number} ms - Milliseconds to sleep.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generates a unique client order ID with an optional prefix.
   * @param {string} prefix - Prefix for the order ID.
   */
  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }
}

module.exports = OrderManager;
