const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const Bottleneck = require('bottleneck');
const PolygonRestClient = require('./polygonRestClient');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

class OrderManager {
  constructor(dashboard, polygon) {
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.positions = {};
    this.orderTracking = {};
    this.watchlist = {};
    this.tiers = [];

    this.isRefreshing = false;
    this.isPolling = false;
    this.isUpdatingWatchlist = false;

    this.restClient = new PolygonRestClient();

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

    this.loadTiers();
    this.loadWatchlistFromFile();
    setInterval(
      () => this.loadWatchlistFromFile(),
      config.pollingIntervals.watchlistRefresh
    );
    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(
      () => this.refreshPositions(),
      config.pollingIntervals.positionRefresh
    );

    this.initializeExistingPositions();

    polygon.onTrade = (symbol, price, timestamp) => {
      this.onTradeUpdate(symbol, price);
    };
  }

  loadTiers() {
    const tiersPath = path.join(__dirname, 'tiers.json');
    if (fs.existsSync(tiersPath)) {
      const data = JSON.parse(fs.readFileSync(tiersPath, 'utf-8'));
      if (data && Array.isArray(data.tiers)) {
        this.tiers = data.tiers;
        logger.info(`Loaded ${this.tiers.length} tiers.`);
        this.dashboard.logInfo(`Loaded ${this.tiers.length} tiers.`);
      } else {
        logger.warn(
          'tiers.json found, but "tiers" property is not an array. Using empty tiers.'
        );
        this.dashboard.logWarning('Invalid tiers format, using empty tiers.');
        this.tiers = [];
      }
    } else {
      logger.warn(`No tiers.json found, using defaults.`);
      this.dashboard.logWarning(`No tiers.json found, using defaults.`);
      this.tiers = [];
    }
  }

  async loadWatchlistFromFile() {
    if (this.isUpdatingWatchlist) return;
    this.isUpdatingWatchlist = true;

    try {
      const watchlistPath = path.join(__dirname, 'watchlist.json');
      if (!fs.existsSync(watchlistPath)) {
        logger.warn(`No watchlist.json found.`);
        this.dashboard.logWarning(`No watchlist.json found.`);
        this.isUpdatingWatchlist = false;
        return;
      }

      const data = fs.readFileSync(watchlistPath, 'utf-8');
      const json = JSON.parse(data);
      const newSymbols = json.symbols.map((s) => s.symbol.toUpperCase());

      // Remove old symbols not in new watchlist and without positions
      for (const symbol in this.watchlist) {
        if (!newSymbols.includes(symbol) && !this.positions[symbol]) {
          this.removeSymbolFromWatchlist(symbol);
        }
      }

      // Add or update new symbols
      for (const symbol of newSymbols) {
        if (!this.watchlist[symbol]) {
          this.watchlist[symbol] = {
            highOfDay: null,
            candidateHOD: null,
            tier: null,
            lastEntryTime: null,
            hasPosition: !!this.positions[symbol],
            hasPendingEntryOrder: false,
            isHODFrozen: false,
            executedPyramidLevels: [],
            isSubscribedToTrade: false,
          };

          this.polygon.subscribe(symbol);
          this.polygon.subscribeTrade(symbol);

          const hod = await this.restClient.getIntradayHighFromAgg(symbol);
          if (hod) {
            this.watchlist[symbol].highOfDay = hod;
            this.assignTierToSymbol(symbol, hod);
          }
        } else {
          const w = this.watchlist[symbol];
          if (!w.highOfDay) {
            const hod = await this.restClient.getIntradayHighFromAgg(symbol);
            if (hod) {
              w.highOfDay = hod;
              this.assignTierToSymbol(symbol, hod);
            }
          }
        }
      }

      this.dashboard.updateWatchlist(this.watchlist);
    } catch (err) {
      this.dashboard.logError(`Error loading watchlist: ${err.message}`);
    } finally {
      this.isUpdatingWatchlist = false;
    }
  }

  assignTierToSymbol(symbol, hod) {
    let chosenTier = null;
    if (this.tiers && Array.isArray(this.tiers)) {
      for (const tier of this.tiers) {
        const [min, max] = tier.range;
        if (hod >= min && hod <= max) {
          chosenTier = tier;
          break;
        }
      }
    }

    // If no tier found, fallback to config
    if (!chosenTier) {
      chosenTier = {
        name: 'Default',
        hodOffsetCents: config.orderSettings.hodOffsetCents,
        entryLimitOffsetCents: config.orderSettings.entryLimitOffsetCents,
        initialEntryQty: config.orderSettings.initialEntryQty,
        stopOffsetCents: config.orderSettings.stopOffsetCents,
        pyramidOffsetCents: config.orderSettings.pyramidOffsetCents,
        profitTargets: config.orderSettings.profitTargets,
        dynamicStops: config.orderSettings.dynamicStops,
        pyramidLevels: config.orderSettings.pyramidLevels,
        trailingStopOffsetCents: config.orderSettings.trailingStopOffsetCents,
        initialEntryOffsetCents: config.orderSettings.initialEntryOffsetCents,
      };
      this.dashboard.logInfo(
        `No tier matched for hod=${hod.toFixed(
          2
        )}. Using fallback tier (config defaults).`
      );
    } else {
      // Ensure chosenTier has all the properties needed:
      // If your tiers always have these properties, this might not be necessary,
      // but it's good practice to ensure all fields are present.
      if (!chosenTier.hodOffsetCents)
        chosenTier.hodOffsetCents = config.orderSettings.hodOffsetCents;
      if (!chosenTier.entryLimitOffsetCents)
        chosenTier.entryLimitOffsetCents =
          config.orderSettings.entryLimitOffsetCents;
      if (!chosenTier.initialEntryQty)
        chosenTier.initialEntryQty = config.orderSettings.initialEntryQty;
      if (!chosenTier.stopOffsetCents)
        chosenTier.stopOffsetCents = config.orderSettings.stopOffsetCents;
      if (!chosenTier.pyramidOffsetCents)
        chosenTier.pyramidOffsetCents = config.orderSettings.pyramidOffsetCents;
      if (!chosenTier.profitTargets)
        chosenTier.profitTargets = config.orderSettings.profitTargets;
      if (!chosenTier.dynamicStops)
        chosenTier.dynamicStops = config.orderSettings.dynamicStops;
      if (!chosenTier.pyramidLevels)
        chosenTier.pyramidLevels = config.orderSettings.pyramidLevels;
      if (!chosenTier.trailingStopOffsetCents)
        chosenTier.trailingStopOffsetCents =
          config.orderSettings.trailingStopOffsetCents;
      if (!chosenTier.initialEntryOffsetCents)
        chosenTier.initialEntryOffsetCents =
          config.orderSettings.initialEntryOffsetCents;

      // Assign a name if not present
      if (!chosenTier.name)
        chosenTier.name = `Range [${chosenTier.range[0]}, ${chosenTier.range[1]}]`;
    }

    this.watchlist[symbol].tier = chosenTier;
    this.dashboard.logInfo(`Assigned ${symbol} to tier: ${chosenTier.name}`);
  }

  removeSymbolFromWatchlist(symbol) {
    if (this.watchlist[symbol]) {
      if (!this.positions[symbol]) {
        this.polygon.unsubscribe(symbol);
        this.polygon.unsubscribeTrade(symbol);
      }
      delete this.watchlist[symbol];
      this.dashboard.logInfo(`Removed ${symbol} from watchlist.`);
      this.dashboard.updateWatchlist(this.watchlist);
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
      if (
        retries > 0 &&
        (err.code === 'ENOTFOUND' ||
          (err.response &&
            (err.response.status === 429 ||
              (err.response.status >= 500 && err.response.status < 600))))
      ) {
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        logger.warn(
          `Retryable error: ${err.message}. Retrying in ${totalDelay}ms.`
        );
        this.dashboard.logWarning(
          `Retryable error: ${err.message}. Retrying...`
        );
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
      }
      this.dashboard.updatePositions(Object.values(this.positions));
    } catch (err) {
      this.dashboard.logError(
        `Error initializing existing positions: ${err.message}`
      );
    }
  }

  getTierSettingsForSymbol(symbol) {
    const w = this.watchlist[symbol];
    if (w && w.tier) return w.tier;
    // fallback if no tier assigned yet
    return {
      hodOffsetCents: config.orderSettings.hodOffsetCents,
      entryLimitOffsetCents: config.orderSettings.entryLimitOffsetCents,
      initialEntryQty: config.orderSettings.initialEntryQty,
      stopOffsetCents: config.orderSettings.stopOffsetCents,
      pyramidOffsetCents: config.orderSettings.pyramidOffsetCents,
      profitTargets: config.orderSettings.profitTargets,
      dynamicStops: config.orderSettings.dynamicStops,
      pyramidLevels: config.orderSettings.pyramidLevels,
      trailingStopOffsetCents: config.orderSettings.trailingStopOffsetCents,
      initialEntryOffsetCents: config.orderSettings.initialEntryOffsetCents,
    };
  }

  calculateDynamicStopPrice(pos) {
    const tier = this.getTierSettingsForSymbol(pos.symbol);
    const ds = tier.dynamicStops || [];
    const matched = ds
      .filter((d) => d.profitTargetsHit <= pos.profitTargetsHit)
      .sort((a, b) => b.profitTargetsHit - a.profitTargetsHit);
    if (matched.length > 0) {
      const chosenStop = matched[0];
      const sideMult = pos.side === 'buy' ? 1 : -1;
      const stopPrice =
        pos.avgEntryPrice + (chosenStop.stopCents / 100) * sideMult;
      return { stopPrice: stopPrice, stopCents: chosenStop.stopCents };
    }
    return null;
  }

  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = position.side === 'long' ? 'buy' : 'sell';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    if (!this.watchlist[symbol]) {
      this.watchlist[symbol] = {
        highOfDay: null,
        candidateHOD: null,
        tier: null,
        lastEntryTime: null,
        hasPosition: true,
        hasPendingEntryOrder: false,
        isHODFrozen: false,
        executedPyramidLevels: [],
        isSubscribedToTrade: false,
      };
      this.polygon.subscribe(symbol);
      this.polygon.subscribeTrade(symbol);
      const hod = await this.restClient.getIntradayHighFromAgg(symbol);
      if (hod) {
        this.watchlist[symbol].highOfDay = hod;
        this.assignTierToSymbol(symbol, hod);
      }
    } else {
      this.watchlist[symbol].hasPosition = true;
    }

    const posObj = {
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
      stopPrice: null,
      stopCents: null,
      stopDescription: 'N/A',
      stopTriggered: false,
      pyramidLevelsHit: 0,
      isActive: true,
      isProcessing: false,
      trailingStopActive: false,
      trailingStopPrice: null,
      highestPriceSeen: parseFloat(position.current_price),
      trailingStopOrderSent: false,
    };

    const tier = this.getTierSettingsForSymbol(symbol);
    posObj.totalProfitTargets = (tier.profitTargets || []).length;
    posObj.totalPyramidLevels = (tier.pyramidLevels || []).length;

    const dynamicStop = this.calculateDynamicStopPrice(posObj);
    if (dynamicStop) {
      posObj.stopPrice = dynamicStop.stopPrice;
      posObj.stopCents = dynamicStop.stopCents;
      posObj.stopDescription = `Stop ${posObj.stopCents}¢ ${
        posObj.stopCents > 0 ? 'above' : posObj.stopCents < 0 ? 'below' : 'at'
      } avg price`;
    }

    this.positions[symbol] = posObj;
    this.dashboard.logInfo(
      `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
    );
    this.dashboard.updatePositions(Object.values(this.positions));
    this.dashboard.updateWatchlist(this.watchlist);
  }

  removePosition(symbol) {
    if (this.positions[symbol]) {
      delete this.positions[symbol];
      this.dashboard.logInfo(`Position for ${symbol} removed.`);
      this.dashboard.updatePositions(Object.values(this.positions));
      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPosition = false;
        this.watchlist[symbol].candidateHOD = null;
      }
    }
  }

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const pos = this.positions[symbol];
    if (!pos || !pos.isActive) return;

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

    this.dashboard.logInfo(
      `Symbol: ${symbol} | Profit: ${
        pos.profitCents
      }¢ | Current: $${currentPrice.toFixed(2)}`
    );

    // Check trailing stop if active
    if (pos.trailingStopActive && side === 'buy') {
      if (currentPrice > pos.highestPriceSeen) {
        pos.highestPriceSeen = currentPrice;
        const tier = this.getTierSettingsForSymbol(symbol);
        const offset = tier.trailingStopOffsetCents / 100;
        pos.trailingStopPrice = pos.highestPriceSeen - offset;
      }

      if (
        !pos.stopTriggered &&
        !pos.trailingStopOrderSent &&
        pos.trailingStopPrice &&
        bidPrice <= pos.trailingStopPrice
      ) {
        pos.stopTriggered = true;
        pos.trailingStopOrderSent = true;
        this.dashboard.logWarning(
          `Trailing stop triggered for ${symbol}. Closing position.`
        );
        await this.closePositionMarketOrder(symbol);
        return;
      }
    } else {
      // Normal stop
      if (!pos.stopTriggered && pos.stopPrice !== null) {
        const stopTriggered =
          (side === 'buy' && bidPrice <= pos.stopPrice) ||
          (side === 'sell' && askPrice >= pos.stopPrice);
        if (stopTriggered) {
          pos.stopTriggered = true;
          this.dashboard.logWarning(
            `Stop triggered for ${symbol}. Closing position.`
          );
          await this.closePositionMarketOrder(symbol);
          return;
        }
      }
    }

    await this.checkProfitTargetsAndPyramids(pos, symbol);
    this.dashboard.updatePositions(Object.values(this.positions));
  }

  async onTradeUpdate(symbol, tradePrice) {
    const w = this.watchlist[symbol];
    if (!w) return;
    const tier = this.getTierSettingsForSymbol(symbol);
    const offset =
      tier.initialEntryOffsetCents ||
      config.orderSettings.initialEntryOffsetCents;

    if (
      !w.hasPosition &&
      !this.positions[symbol] &&
      !w.hasPendingEntryOrder &&
      w.highOfDay
    ) {
      if (tradePrice >= w.highOfDay + offset / 100) {
        w.hasPendingEntryOrder = true;
        w.isHODFrozen = true;
        w.candidateHOD = w.highOfDay;

        // Use tier's initialEntryQty if available, else default to config
        const initialQty =
          tier.initialEntryQty || config.orderSettings.initialEntryQty;
        const targetPrice = w.candidateHOD + offset / 100;
        this.dashboard.logInfo(
          `Triggering breakout entry for ${symbol} at $${targetPrice.toFixed(
            2
          )}`
        );
        await this.placeEntryOrder(symbol, initialQty, 'buy', targetPrice);
      }
    }
  }

  async placeEntryOrder(symbol, qty, side, targetPrice) {
    const pos = this.positions[symbol];
    if (pos) {
      this.watchlist[symbol].hasPendingEntryOrder = false;
      this.watchlist[symbol].isHODFrozen = false;
      return;
    }

    // Use tier's entryLimitOffsetCents if available
    const tier = this.getTierSettingsForSymbol(symbol);
    const limitOffsetCents =
      tier.entryLimitOffsetCents ||
      config.orderSettings.entryLimitOffsetCents ||
      25;
    const limitPrice = targetPrice + limitOffsetCents / 100;
    if (limitPrice <= 0 || isNaN(limitPrice)) {
      this.dashboard.logError(`Invalid limit price for ${symbol} entry.`);
      this.watchlist[symbol].hasPendingEntryOrder = false;
      this.watchlist[symbol].isHODFrozen = false;
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

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      this.dashboard.logInfo(
        `Entry order placed for ${symbol} at $${limitPrice}. Order ID: ${result.id}`
      );
      this.orderTracking[result.id] = {
        symbol,
        type: 'entry',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
        placedAt: Date.now(),
        triggerPrice: targetPrice,
      };
    } catch (err) {
      this.watchlist[symbol].hasPendingEntryOrder = false;
      this.watchlist[symbol].isHODFrozen = false;
      this.dashboard.logError(
        `Error placing entry order for ${symbol}: ${err.message}`
      );
    }
  }

  async checkProfitTargetsAndPyramids(pos, symbol) {
    const tier = this.getTierSettingsForSymbol(symbol);
    const profitTargets = tier.profitTargets || [];
    const pyramidLevels = tier.pyramidLevels || [];
    const currentProfitCents = parseFloat(pos.profitCents);

    // Check profit targets
    if (pos.profitTargetsHit < profitTargets.length) {
      const target = profitTargets[pos.profitTargetsHit];
      const targetReached =
        (pos.side === 'buy' && currentProfitCents >= target.targetCents) ||
        (pos.side === 'sell' && currentProfitCents <= -target.targetCents);

      if (targetReached && !pos.isProcessing) {
        pos.isProcessing = true;
        const qtyToClose = Math.floor(pos.qty * (target.percentToClose / 100));
        if (qtyToClose > 0) {
          this.dashboard.logInfo(
            `Profit target hit for ${symbol}: closing ${qtyToClose} shares.`
          );
          await this.placeTakeProfitOrder(symbol, qtyToClose, pos.side);
          pos.profitTargetsHit += 1;
        }

        // Update dynamic stop after target hit
        const dynamicStop = this.calculateDynamicStopPrice(pos);
        if (dynamicStop) {
          pos.stopPrice = dynamicStop.stopPrice;
          pos.stopCents = dynamicStop.stopCents;
          pos.stopDescription = `Stop ${pos.stopCents}¢ ${
            pos.stopCents > 0 ? 'above' : pos.stopCents < 0 ? 'below' : 'at'
          } avg price`;
          this.dashboard.logInfo(
            `Dynamic stop updated for ${symbol}: $${pos.stopPrice.toFixed(2)}`
          );
        }

        pos.isProcessing = false;
      }
    }

    // If all targets hit, activate trailing stop if not active
    if (
      pos.profitTargetsHit >= profitTargets.length &&
      !pos.trailingStopActive
    ) {
      pos.trailingStopActive = true;
      const offsetCents =
        tier.trailingStopOffsetCents ||
        config.orderSettings.trailingStopOffsetCents;
      const offset = offsetCents / 100;
      pos.trailingStopPrice =
        pos.side === 'buy'
          ? pos.currentPrice - offset
          : pos.currentPrice + offset;
      pos.highestPriceSeen = pos.currentPrice;
      this.dashboard.logInfo(
        `All profit targets hit for ${symbol}. Trailing stop activated at $${pos.trailingStopPrice.toFixed(
          2
        )}`
      );
    }

    // Check pyramiding
    if (pos.pyramidLevelsHit < pyramidLevels.length && !pos.isProcessing) {
      const nextLevel = pyramidLevels[pos.pyramidLevelsHit];
      const levelReached =
        (pos.side === 'buy' && currentProfitCents >= nextLevel.addInCents) ||
        (pos.side === 'sell' && currentProfitCents <= -nextLevel.addInCents);

      if (levelReached) {
        pos.isProcessing = true;
        const qtyToAdd = Math.floor(pos.qty * (nextLevel.percentToAdd / 100));
        if (qtyToAdd > 0) {
          await this.placePyramidOrder(pos, qtyToAdd, nextLevel.offsetCents);
          pos.pyramidLevelsHit += 1;
        }
        pos.isProcessing = false;
      }
    }
  }

  async placeTakeProfitOrder(symbol, qty, side) {
    const pos = this.positions[symbol];
    if (!pos) return;

    // Use tier's entryLimitOffsetCents if available for profit-taking offset if desired.
    // If not specifically required, you can stick to config.
    const limitOffsetCents = config.orderSettings.entryLimitOffsetCents || 0;

    const oppositeSide = side === 'buy' ? 'sell' : 'buy';
    let limitPrice;
    if (oppositeSide === 'sell') {
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    } else {
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
    }

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side: oppositeSide,
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('TAKE_PROFIT'),
    };

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      this.dashboard.logInfo(
        `Take-profit order placed for ${symbol} at $${limitPrice}. Order ID: ${result.id}`
      );
      this.orderTracking[result.id] = {
        symbol,
        type: 'partial_close',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };
    } catch (err) {
      this.dashboard.logError(
        `Error placing take-profit order for ${symbol}: ${err.message}`
      );
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
      this.dashboard.logError(`Invalid pyramid order price for ${symbol}.`);
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

    this.dashboard.logInfo(
      `Placing pyramid order for ${symbol} at $${limitPrice}`
    );
    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      this.dashboard.logInfo(
        `Pyramid order placed for ${symbol}. Order ID: ${result.id}`
      );
      this.orderTracking[result.id] = {
        symbol,
        type: 'pyramid',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };
    } catch (err) {
      this.dashboard.logError(
        `Error placing pyramid order for ${symbol}: ${err.message}`
      );
    }
  }

  async pollOrderStatuses() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open' })
      );
      this.dashboard.updateOrders(openOrders);

      const openOrderIds = new Set(openOrders.map((o) => o.id));
      for (const order of openOrders) {
        const tracked = this.orderTracking[order.id];
        if (tracked) {
          tracked.filledQty = parseFloat(order.filled_qty || '0');
          const pos = this.positions[tracked.symbol];
          if (pos && tracked.filledQty > 0) {
            if (['ioc', 'partial_close', 'close'].includes(tracked.type)) {
              pos.qty -= tracked.filledQty;
              this.dashboard.logInfo(
                `Order ${order.id} filled ${tracked.filledQty} for ${tracked.symbol}, qty now ${pos.qty}`
              );
              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);
              if (pos.qty <= 0) this.removePosition(tracked.symbol);
            } else if (tracked.type === 'pyramid' || tracked.type === 'entry') {
              const oldQty = pos.qty;
              pos.qty += tracked.filledQty;
              const totalCost =
                pos.avgEntryPrice * oldQty +
                tracked.filledQty *
                  parseFloat(order.limit_price || pos.currentPrice);
              pos.avgEntryPrice = totalCost / pos.qty;
              pos.profitCents = (
                (pos.currentPrice - pos.avgEntryPrice) *
                100 *
                (pos.side === 'buy' ? 1 : -1)
              ).toFixed(2);
              this.dashboard.logInfo(
                `Order ${order.id} filled ${tracked.filledQty} for ${
                  tracked.symbol
                }, qty ${pos.qty}, avg $${pos.avgEntryPrice.toFixed(2)}`
              );

              if (tracked.type === 'entry') {
                this.watchlist[tracked.symbol].hasPendingEntryOrder = false;
                this.watchlist[tracked.symbol].isHODFrozen = false;
              }
            }
            this.dashboard.updatePositions(Object.values(this.positions));
          }
        }
      }

      // Cleanup completed orders
      for (const orderId in this.orderTracking) {
        if (!openOrderIds.has(orderId)) {
          delete this.orderTracking[orderId];
        }
      }
    } catch (err) {
      this.dashboard.logError(`Error polling order statuses: ${err.message}`);
    } finally {
      this.isPolling = false;
    }
  }

  async closePositionMarketOrder(symbol) {
    const pos = this.positions[symbol];
    if (!pos || pos.qty <= 0) return;

    const side = pos.side === 'buy' ? 'sell' : 'buy';
    const limitOffsetCents = config.orderSettings.entryLimitOffsetCents || 25;
    let limitPrice;
    if (side === 'sell') {
      limitPrice = pos.currentBid - limitOffsetCents / 100;
    } else {
      limitPrice = pos.currentAsk + limitOffsetCents / 100;
    }

    if (limitPrice <= 0 || isNaN(limitPrice)) {
      this.dashboard.logError(`Invalid limit price for ${symbol} close.`);
      return;
    }

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

    this.dashboard.logInfo(`Closing position ${symbol} with limit order.`);
    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      this.dashboard.logInfo(
        `Close order placed for ${symbol}, Order ID: ${result.id}`
      );
      this.orderTracking[result.id] = {
        symbol,
        type: 'close',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };
      await this.refreshPositions();
    } catch (err) {
      this.dashboard.logError(
        `Error placing close order for ${symbol}: ${err.message}`
      );
    }
  }

  async refreshPositions() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      const latestPositions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      const latestMap = {};
      latestPositions.forEach((p) => (latestMap[p.symbol.toUpperCase()] = p));

      for (const symbol in this.positions) {
        const pos = this.positions[symbol];
        if (latestMap[symbol]) {
          const lp = latestMap[symbol];
          const latestQty = Math.abs(parseFloat(lp.qty));
          pos.qty = latestQty;
          pos.avgEntryPrice = parseFloat(lp.avg_entry_price);
          pos.currentPrice = parseFloat(lp.current_price);
          pos.currentBid = pos.currentPrice - 0.01;
          pos.currentAsk = pos.currentPrice + 0.01;
          pos.profitCents = (
            (pos.currentPrice - pos.avgEntryPrice) *
            100 *
            (pos.side === 'buy' ? 1 : -1)
          ).toFixed(2);

          if (!pos.trailingStopActive) {
            const dynamicStop = this.calculateDynamicStopPrice(pos);
            if (dynamicStop) {
              pos.stopPrice = dynamicStop.stopPrice;
              pos.stopCents = dynamicStop.stopCents;
              pos.stopDescription = `Stop ${pos.stopCents}¢ ${
                pos.stopCents > 0 ? 'above' : pos.stopCents < 0 ? 'below' : 'at'
              } avg price`;
            }
          }

          if (pos.trailingStopActive && pos.side === 'buy') {
            const tier = this.getTierSettingsForSymbol(symbol);
            const offset = tier.trailingStopOffsetCents / 100;
            if (pos.currentPrice > pos.highestPriceSeen) {
              pos.highestPriceSeen = pos.currentPrice;
              pos.trailingStopPrice = pos.highestPriceSeen - offset;
            }
          }

          if (latestQty === 0) this.removePosition(symbol);
        } else {
          this.removePosition(symbol);
        }
      }

      // Add any new positions not currently tracked
      for (const symbol in latestMap) {
        if (!this.positions[symbol]) {
          await this.addPosition(latestMap[symbol]);
        }
      }

      this.dashboard.updatePositions(Object.values(this.positions));
      this.dashboard.updateWatchlist(this.watchlist);
    } catch (err) {
      this.dashboard.logError(`Error refreshing positions: ${err.message}`);
    } finally {
      this.isRefreshing = false;
    }
  }
}

module.exports = OrderManager;
