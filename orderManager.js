const { alpaca } = require('./alpaca');
const config = require('./config');
// We'll still import logger for file logging if needed, but won't log to console
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

    this.latestQuotes = {};
    this.limiter = new Bottleneck({ minTime: 350, maxConcurrent: 1 });

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

    this.trailingData = {};

    this.hodOverrides = this.loadHODOverrides();

    // Initialize
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

  loadHODOverrides() {
    const overridesPath = path.join(__dirname, 'hodOverrides.json');
    if (fs.existsSync(overridesPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'));
        return data.HODOverrides || {};
      } catch (err) {
        const msg = `Error loading HOD overrides: ${err.message}`;
        this.dashboard.logError(msg);
        return {};
      }
    } else {
      return {};
    }
  }

  async loadSystemState() {
    const statePath = config.statePersistence.stateFilePath;
    if (fs.existsSync(statePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        this.positions = data.positions || {};
        this.watchlist = data.watchlist || {};
        this.orderTracking = data.orderTracking || {};
        this.dashboard.logInfo('Loaded previous state from disk.');
      } catch (err) {
        const msg = `Error loading system state: ${err.message}`;
        this.dashboard.logError(msg);
      }
    }
  }

  async saveSystemState() {
    const state = {
      positions: this.positions,
      watchlist: this.watchlist,
      orderTracking: this.orderTracking,
    };
    try {
      fs.writeFileSync(
        config.statePersistence.stateFilePath,
        JSON.stringify(state, null, 2)
      );
      this.dashboard.logInfo('Saved current state to disk.');
    } catch (err) {
      const msg = `Error saving system state: ${err.message}`;
      this.dashboard.logError(msg);
    }
  }

  async initializeExistingPositions() {
    await this.loadSystemState();
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
      this.dashboard.logError(message);
    }
  }

  async processOrderQueue() {
    if (this.processingOrder) return;
    this.processingOrder = true;
    while (!this.orderQueue.isEmpty()) {
      const { order } = this.orderQueue.getNextOrder();
      try {
        const result = await this.retryOperation(() =>
          this.limitedCreateOrder(order)
        );
        const successMessage = `Order placed [${order.client_order_id}] for ${
          order.symbol
        }: ${JSON.stringify(order)}`;
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
        this.applyOverridesToWatchlist();
      }
    } catch (err) {
      const msg = `Error reloading dynamic config: ${err.message}`;
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
          tierIndex: undefined,
          plannedEntryPrice: null,
          isSubscribedToTrade: false,
          isQuoteSubscribed: false,
        };
        this.polygon.subscribeQuote(symbol);
        this.watchlist[symbol].isQuoteSubscribed = true;
        this.dashboard.logInfo(
          `Symbol ${symbol} added to watchlist due to override add list.`
        );
      }
    }

    this.dashboard.updateWatchlist(this.watchlist);
    this.refreshTradeSubscriptions();
  }

  getCurrentVolumeRequirement() {
    const now = moment().tz(config.timeZone);
    const hour = now.hour();
    const minute = now.minute();

    let chosenInterval;
    if (hour < 8) {
      chosenInterval = config.strategySettings.volumeRequirementsInterval1;
    } else if (hour < 9 || (hour === 9 && minute < 30)) {
      chosenInterval = config.strategySettings.volumeRequirementsInterval2;
    } else if (hour < 11 || (hour === 11 && minute === 0)) {
      chosenInterval = config.strategySettings.volumeRequirementsInterval3;
    } else {
      chosenInterval = config.strategySettings.volumeRequirementsInterval4;
    }

    if (typeof chosenInterval !== 'number') {
      chosenInterval = config.strategySettings.volumeRequirementsInterval4;
    }

    this.dashboard.logInfo(
      `getCurrentVolumeRequirement: ${chosenInterval} at ${hour}:${minute}`
    );
    return chosenInterval;
  }

  async initializeWatchlist() {
    try {
      const gainers = await this.restClient.getGainersOrLosers(
        'gainers',
        false
      );
      const currentVolumeRequirement = this.getCurrentVolumeRequirement();
      const topGainers = {};
      const minOneMinuteRange = config.strategySettings.minOneMinuteRange || 0;

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

        const volume = g.min.av || 0;

        const lastMinHigh = g.min.h;
        const lastMinLow = g.min.l;
        if (lastMinHigh === undefined || lastMinLow === undefined) {
          this.dashboard.logInfo(
            `Symbol ${symbol} skipped due to missing 1-minute data.`
          );
          continue;
        }
        const oneMinuteRange = lastMinHigh - lastMinLow;
        if (oneMinuteRange < minOneMinuteRange) {
          this.dashboard.logInfo(
            `Symbol ${symbol} skipped. 1-min range ${oneMinuteRange.toFixed(
              2
            )} < ${minOneMinuteRange}`
          );
          continue;
        }

        topGainers[symbol] = {
          symbol,
          dayClose: currentPrice,
          gapPerc,
          volume,
        };

        if (volume >= currentVolumeRequirement) {
          await this.addSymbolToWatchlist(symbol, currentPrice);
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
      this.refreshTradeSubscriptions();
    } catch (err) {
      const msg = `Error updating watchlist: ${err.message}`;
      this.dashboard.logError(msg);
    }
  }

  findTierForPrice(price) {
    const tiers = config.priceTiers;
    for (let i = 0; i < tiers.length; i++) {
      if (price >= tiers[i].min && price <= tiers[i].max) {
        return i;
      }
    }
    return null;
  }

  async addSymbolToWatchlist(symbol, refPrice) {
    try {
      const hod = await this.restClient.getIntradayHigh(symbol);
      let assignedPrice = hod || refPrice;

      if (this.hodOverrides[symbol]) {
        assignedPrice = this.hodOverrides[symbol];
        this.dashboard.logInfo(
          `HOD override applied for ${symbol}: $${assignedPrice.toFixed(2)}`
        );
      }

      const tierIndex = this.findTierForPrice(assignedPrice);

      if (!this.watchlist[symbol]) {
        this.watchlist[symbol] = {
          highOfDay: assignedPrice,
          lastEntryTime: null,
          hasPosition: !!this.positions[symbol],
          hasPendingEntryOrder: false,
          isHODFrozen: false,
          executedPyramidLevels: [],
          tierIndex,
          plannedEntryPrice: null,
          isSubscribedToTrade: false,
          isQuoteSubscribed: false,
        };
        this.polygon.subscribeQuote(symbol);
        this.watchlist[symbol].isQuoteSubscribed = true;
      } else {
        this.watchlist[symbol].highOfDay = assignedPrice;
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
        if (this.watchlist[symbol].tierIndex === undefined) {
          this.watchlist[symbol].tierIndex = tierIndex;
        }
      }

      this.dashboard.updateWatchlist(this.watchlist);
      this.refreshTradeSubscriptions();
    } catch (err) {
      const errorMsg = `Error adding symbol ${symbol} to watchlist: ${err.message}`;
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

  async addPosition(position) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(parseFloat(position.qty));
    const side = 'buy';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    const w = this.watchlist[symbol];
    if (!w) return;

    const hod = w.highOfDay;
    if (!hod) return;

    const tierIndex = w.tierIndex;
    const tier = tierIndex !== undefined ? config.priceTiers[tierIndex] : null;
    const initialStopOffsetCents = tier ? tier.initialStopOffsetCents : 2;
    const profitTargets = tier
      ? tier.profitTargets
      : config.orderSettings.profitTargets;
    const pyramidLevels = tier
      ? tier.pyramidLevels
      : config.orderSettings.pyramidLevels;

    const initialStopPrice = hod - initialStopOffsetCents / 100;

    this.positions[symbol] = {
      symbol,
      qty,
      initialQty: qty,
      side,
      avgEntryPrice,
      currentPrice: parseFloat(position.current_price),
      profitCents: 0,
      profitTargetsHit: 0,
      totalProfitTargets: profitTargets.length,
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
      totalPyramidLevels: pyramidLevels.length,
      trailingStopActive: false,
      tierIndex,
      pyramidLevels,
      profitTargets,
    };

    this.trailingData[symbol] = { prices: [] };

    if (this.watchlist[symbol]) {
      this.watchlist[symbol].hasPosition = true;
      this.dashboard.updateWatchlist(this.watchlist);
    }

    if (!this.watchlist[symbol].isQuoteSubscribed) {
      this.polygon.subscribeQuote(symbol);
      this.watchlist[symbol].isQuoteSubscribed = true;
    }
    this.dashboard.updatePositions(Object.values(this.positions));
    this.refreshTradeSubscriptions();

    const message = `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice.toFixed(
      2
    )} | Stop: $${initialStopPrice.toFixed(2)} (HOD:${hod.toFixed(2)})`;
    this.dashboard.logInfo(message);
  }

  async fetchRecentBars(symbol, timeframe, limit) {
    const now = new Date().toISOString();
    const from = moment().subtract(30, 'minutes').toISOString();
    try {
      const bars = await alpaca.getBars(timeframe, [symbol], {
        start: from,
        end: now,
        limit,
      });
      return bars[symbol] || [];
    } catch (err) {
      this.dashboard.logError(
        `Error fetching bars for ${symbol}: ${err.message}`
      );
      return [];
    }
  }

  isWithinTradingWindow() {
    const now = moment().tz(config.timeZone);
    const startTimeParts = config.strategySettings.startTime.split(':');
    const endTimeParts = config.strategySettings.endTime.split(':');

    const start = now
      .clone()
      .hour(parseInt(startTimeParts[0]))
      .minute(parseInt(startTimeParts[1]))
      .second(0);
    const end = now
      .clone()
      .hour(parseInt(endTimeParts[0]))
      .minute(parseInt(endTimeParts[1]))
      .second(0);

    return now.isBetween(start, end, null, '[]');
  }

  refreshTradeSubscriptions() {
    for (const symbol of Object.keys(this.watchlist)) {
      const w = this.watchlist[symbol];
      if (!this.latestQuotes[symbol]) continue;
      const bidPrice = this.latestQuotes[symbol].bidPrice;
      const askPrice = this.latestQuotes[symbol].askPrice;
      if (!askPrice || isNaN(askPrice)) continue;

      const distanceToHODCents = (w.highOfDay - askPrice) * 100;
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
    }
    this.dashboard.updateWatchlist(this.watchlist);
  }

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const w = this.watchlist[symbol];
    if (!w) return;

    this.latestQuotes[symbol] = { bidPrice, askPrice };

    if (this.hodOverrides[symbol]) {
      if (this.hodOverrides[symbol] !== w.highOfDay) {
        w.highOfDay = this.hodOverrides[symbol];
        this.dashboard.logInfo(
          `HOD override reapplied for ${symbol}: $${w.highOfDay.toFixed(2)}`
        );
        this.dashboard.updateWatchlist(this.watchlist);
        this.refreshTradeSubscriptions();
      }
    } else {
      if (
        askPrice &&
        !isNaN(askPrice) &&
        askPrice > w.highOfDay &&
        !w.isHODFrozen
      ) {
        try {
          const newHod = await this.restClient.getIntradayHigh(symbol);
          if (newHod && newHod > w.highOfDay) {
            w.highOfDay = newHod;
            this.dashboard.logInfo(
              `HOD updated for ${symbol}: $${newHod.toFixed(2)}`
            );
            this.dashboard.updateWatchlist(this.watchlist);
            this.refreshTradeSubscriptions();
          }
        } catch (err) {
          const errorMsg = `Error updating HOD for ${symbol}: ${err.message}`;
          this.dashboard.logError(errorMsg);
        }
      }
    }

    const distanceToHODCents = (w.highOfDay - askPrice) * 100;
    if (askPrice && !isNaN(askPrice)) {
      if (distanceToHODCents <= 20 && !w.isSubscribedToTrade) {
        this.polygon.subscribeTrade(symbol);
        w.isSubscribedToTrade = true;
        this.dashboard.logInfo(`Subscribed to trade-level data for ${symbol}.`);
        this.dashboard.updateWatchlist(this.watchlist);
      } else if (distanceToHODCents > 20 && w.isSubscribedToTrade) {
        this.polygon.unsubscribeTrade(symbol);
        w.isSubscribedToTrade = false;
        this.dashboard.logInfo(
          `Unsubscribed from trade-level data for ${symbol}.`
        );
        this.dashboard.updateWatchlist(this.watchlist);
      }
    }

    const pos = this.positions[symbol];
    if (pos && bidPrice && !isNaN(bidPrice)) {
      await this.checkStopCondition(pos, symbol);
      await this.updateSecondsTrailingStop(pos, symbol, bidPrice);
    }
  }

  async onTradeUpdate(symbol, price, size, timestamp) {
    const w = this.watchlist[symbol];
    if (!w) return;
    const pos = this.positions[symbol];

    if (pos || w.hasPendingEntryOrder) return;
    if (!this.isWithinTradingWindow()) return;

    const tierIndex = w.tierIndex;
    const tier = tierIndex !== undefined ? config.priceTiers[tierIndex] : null;
    const hodTriggerOffsetCents = tier ? tier.hodTriggerOffsetCents : 0;

    if (w.highOfDay === undefined || w.highOfDay === null) {
      this.dashboard.logError(
        `Missing HOD for ${symbol}, cannot determine trigger price.`
      );
      return;
    }

    const triggerPrice = w.highOfDay + hodTriggerOffsetCents / 100;

    if (price > triggerPrice) {
      w.lastEntryTime = Date.now();
      w.hasPendingEntryOrder = true;
      w.isHODFrozen = true;

      const entryLimitOffsetCents =
        tier?.entryLimitOffsetCents ?? config.orderSettings.limitOffsetCents;

      const askPrice = this.latestQuotes[symbol]?.askPrice;
      let limitPrice;
      if (!askPrice || isNaN(askPrice)) {
        limitPrice = triggerPrice + entryLimitOffsetCents / 100;
      } else {
        limitPrice = askPrice + entryLimitOffsetCents / 100;
      }

      w.plannedEntryPrice = limitPrice;
      this.dashboard.updateWatchlist(this.watchlist);
      this.dashboard.logInfo(
        `Entry triggered by trade for ${symbol}: triggerPrice=$${triggerPrice.toFixed(
          2
        )}, limitPrice=$${limitPrice.toFixed(2)}`
      );

      await this.placeEntryOrder(
        symbol,
        tier?.initialShareSize ?? config.strategySettings.initialShareSize,
        'buy',
        limitPrice
      );
    }
  }

  async placeEntryOrder(symbol, qty, side, targetPrice) {
    if (typeof qty !== 'number' || isNaN(qty) || qty <= 0) {
      this.dashboard.logError(
        `Invalid qty in placeEntryOrder for ${symbol}: ${qty}`
      );
      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPendingEntryOrder = false;
        this.watchlist[symbol].isHODFrozen = false;
      }
      return;
    }

    if (typeof targetPrice !== 'number' || isNaN(targetPrice)) {
      this.dashboard.logError(
        `Invalid targetPrice in placeEntryOrder for ${symbol}: ${targetPrice}`
      );
      if (this.watchlist[symbol]) {
        this.watchlist[symbol].hasPendingEntryOrder = false;
        this.watchlist[symbol].isHODFrozen = false;
      }
      return;
    }

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: targetPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('ENTRY'),
    };

    if (this.watchlist[symbol])
      this.watchlist[symbol].hasPendingEntryOrder = true;

    this.enqueueOrder(order, 3);
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
      this.dashboard.logError(errorMessage);
    } finally {
      this.isRefreshing = false;

      for (const symbol in this.watchlist) {
        this.watchlist[symbol].hasPosition = !!this.positions[symbol];
      }
      this.dashboard.updateWatchlist(this.watchlist);

      await this.checkAllPositionsStops();
      this.refreshTradeSubscriptions();
    }
  }

  syncProfitTargetsOnStartup(pos) {
    const bidPrice = this.latestQuotes[pos.symbol]?.bidPrice;
    if (!bidPrice || isNaN(bidPrice)) return;

    const currentProfitCents = (bidPrice - pos.avgEntryPrice) * 100;
    let newlyHitTargets = 0;
    for (let i = 0; i < pos.profitTargets.length; i++) {
      if (currentProfitCents >= pos.profitTargets[i].targetCents) {
        newlyHitTargets = i + 1;
      } else {
        break;
      }
    }

    if (newlyHitTargets > pos.profitTargetsHit) {
      const diff = newlyHitTargets - pos.profitTargetsHit;
      pos.profitTargetsHit = newlyHitTargets;
      this.dashboard.logInfo(
        `Position ${pos.symbol}: Found ${diff} previously unhit profit targets hit on startup. Now at ${pos.profitTargetsHit}/${pos.totalProfitTargets}.`
      );

      if (
        pos.profitTargetsHit >= pos.totalProfitTargets &&
        !pos.trailingStopActive &&
        config.strategySettings.useSecondsTrailingStop
      ) {
        pos.trailingStopActive = true;
        pos.stopDescription = `Seconds-TrailingStop Active`;
      }
    }
  }

  async checkAllPositionsStops() {
    for (const symbol in this.positions) {
      const pos = this.positions[symbol];
      await this.checkStopCondition(pos, symbol);
    }
  }

  async checkStopCondition(pos, symbol) {
    const bidPrice = this.latestQuotes[symbol]?.bidPrice;
    if (!bidPrice || isNaN(bidPrice)) return;

    if (pos.side === 'buy' && bidPrice <= pos.stopPrice && !pos.stopTriggered) {
      pos.stopTriggered = true;
      const stopMsg = `Stop condition met for ${symbol}. Closing position at bid $${bidPrice.toFixed(
        2
      )} <= stopPrice $${pos.stopPrice.toFixed(2)}.`;
      this.dashboard.logWarning(stopMsg);
      await this.closePositionMarketOrder(symbol);
    }
  }

  async cancelOrder(orderId, symbol) {
    try {
      await this.retryOperation(() => this.limitedCancelOrder(orderId));
      this.dashboard.logInfo(`Order ${orderId} canceled for ${symbol}.`);
      delete this.orderTracking[orderId];
    } catch (err) {
      const errorMsg = `Error canceling order ${orderId} for ${symbol}: ${
        err.response ? JSON.stringify(err.response.data) : err.message
      }`;
      this.dashboard.logError(errorMsg);
    }
  }

  async closePositionMarketOrder(symbol) {
    const pos = this.positions[symbol];
    if (!pos || pos.qty <= 0) return;

    // Cancel any open buy orders to avoid wash trades
    await this.cancelOpenBuyOrders(symbol);

    const limitOffsetCents = config.orderSettings.limitOffsetCents || 0;
    const bidPrice = this.latestQuotes[symbol]?.bidPrice;

    let limitPrice;
    if (!bidPrice || isNaN(bidPrice)) {
      const fallbackPrice = pos.currentPrice || 0;
      limitPrice = fallbackPrice - limitOffsetCents / 100;
    } else {
      limitPrice = bidPrice - limitOffsetCents / 100;
    }

    if (
      typeof limitPrice !== 'number' ||
      isNaN(limitPrice) ||
      limitPrice <= 0
    ) {
      this.dashboard.logError(
        `Invalid limitPrice for closing ${symbol}: ${limitPrice}`
      );
      return;
    }

    const order = {
      symbol,
      qty: pos.qty.toFixed(0),
      side: 'sell',
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('CLOSE'),
    };

    this.enqueueOrder(order, 1);
  }

  async cancelOpenBuyOrders(symbol) {
    try {
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open' })
      );
      for (const o of openOrders) {
        if (
          o.symbol.toUpperCase() === symbol.toUpperCase() &&
          o.side === 'buy'
        ) {
          await this.cancelOrder(o.id, symbol);
        }
      }
    } catch (err) {
      const errorMsg = `Error canceling open buy orders for ${symbol}: ${err.message}`;
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
          // Order filled or canceled
          if (trackedOrder.type === 'entry') {
            const sym = trackedOrder.symbol;
            if (this.watchlist[sym]) {
              this.watchlist[sym].hasPendingEntryOrder = false;
              this.watchlist[sym].isHODFrozen = false;
              this.dashboard.updateWatchlist(this.watchlist);
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
            const sym = trackedOrder.symbol;
            if (this.watchlist[sym]) {
              this.watchlist[sym].hasPendingEntryOrder = false;
              this.watchlist[sym].isHODFrozen = false;
              this.dashboard.updateWatchlist(this.watchlist);
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

              this.dashboard.updatePositions(Object.values(this.positions));

              if (trackedOrder.type === 'entry') {
                const sym = trackedOrder.symbol;
                if (this.watchlist[sym]) {
                  this.watchlist[sym].hasPendingEntryOrder = false;
                  this.watchlist[sym].isHODFrozen = false;
                  this.dashboard.updateWatchlist(this.watchlist);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      const errorMessage = `Error polling order statuses: ${err.message}`;
      this.dashboard.logError(errorMessage);
    } finally {
      this.isPolling = false;
      this.refreshTradeSubscriptions();
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

  async checkAndExecutePyramiding(pos, symbol) {
    const bidPrice = this.latestQuotes[symbol]?.bidPrice;
    const askPrice = this.latestQuotes[symbol]?.askPrice;
    if (!bidPrice || isNaN(bidPrice) || !askPrice || isNaN(askPrice)) return;

    const pyramidLevels =
      pos.pyramidLevels || config.orderSettings.pyramidLevels;
    for (let i = 0; i < pyramidLevels.length; i++) {
      const level = pyramidLevels[i];
      if (pos.executedPyramidLevels.includes(i)) continue;

      const targetPrice = pos.avgEntryPrice + level.priceIncreaseCents / 100;
      if (bidPrice >= targetPrice) {
        const qtyToAdd = Math.floor(
          (pos.initialQty * level.percentToAdd) / 100
        );
        if (qtyToAdd > 0) {
          const limitPrice = askPrice + level.offsetCents / 100;
          await this.placePyramidOrder(pos, qtyToAdd, limitPrice, i);
          pos.executedPyramidLevels.push(i);
          this.dashboard.updatePositions(Object.values(this.positions));
        }
      }
    }
  }

  async placePyramidOrder(pos, qtyToAdd, limitPrice, levelIndex) {
    const symbol = pos.symbol;

    if (
      typeof limitPrice !== 'number' ||
      isNaN(limitPrice) ||
      limitPrice <= 0
    ) {
      this.dashboard.logError(
        `Invalid pyramid limitPrice for ${symbol}: ${limitPrice}`
      );
      return;
    }

    const order = {
      symbol,
      qty: qtyToAdd.toFixed(0),
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      limit_price: limitPrice.toFixed(2),
      extended_hours: true,
      client_order_id: this.generateClientOrderId('PYRAMID'),
    };

    this.dashboard.logInfo(`Queueing pyramid order for ${symbol}...`);
    this.enqueueOrder(order, 2);
  }

  async updateSecondsTrailingStop(pos, symbol, currentRefPrice) {
    if (!config.strategySettings.useSecondsTrailingStop) return;
    if (pos.profitTargetsHit < pos.totalProfitTargets) return;

    const tierIndex = pos.tierIndex;
    const tier = tierIndex !== undefined ? config.priceTiers[tierIndex] : null;
    if (!tier) return;

    const interval = tier.secondsTrailingStopInterval || 5;
    const data = this.trailingData[symbol];
    if (!data) return;

    const now = Date.now();
    data.prices.push({ t: now, p: currentRefPrice });

    const cutoff = now - interval * 1000;
    data.prices = data.prices.filter((d) => d.t >= cutoff);

    let minPrice = Infinity;
    for (const p of data.prices) {
      if (p.p < minPrice) minPrice = p.p;
    }

    if (pos.secondsTrailingStopLow === undefined) {
      pos.secondsTrailingStopLow = minPrice;
      pos.stopDescription = `Seconds-TrailingStop Low @ $${minPrice.toFixed(
        2
      )}`;
    } else {
      if (minPrice < pos.secondsTrailingStopLow) {
        pos.secondsTrailingStopLow = minPrice;
        pos.stopDescription = `Seconds-TrailingStop Updated Low @ $${minPrice.toFixed(
          2
        )}`;
        this.dashboard.logInfo(
          `Seconds-based trailing stop triggered for ${symbol} at $${minPrice.toFixed(
            2
          )}.`
        );
        await this.closePositionMarketOrder(symbol);
      }
    }
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

  removePosition(symbol) {
    if (this.positions[symbol]) {
      delete this.positions[symbol];
      if (this.trailingData[symbol]) delete this.trailingData[symbol];
      const message = `Position removed: ${symbol}`;
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

  async refreshAllSubscriptions() {
    for (const symbol in this.positions) {
      if (!this.watchlist[symbol]) {
        this.watchlist[symbol] = {
          highOfDay: this.positions[symbol].attemptHOD || null,
          lastEntryTime: null,
          hasPosition: true,
          hasPendingEntryOrder: false,
          isHODFrozen: false,
          executedPyramidLevels:
            this.positions[symbol].executedPyramidLevels || [],
          tierIndex: this.positions[symbol].tierIndex,
          plannedEntryPrice: null,
          isSubscribedToTrade: false,
          isQuoteSubscribed: false,
        };
      }
      this.subscribeToSymbol(symbol);
    }

    for (const symbol in this.watchlist) {
      this.subscribeToSymbol(symbol);
    }

    this.refreshTradeSubscriptions();
  }

  subscribeToSymbol(symbol) {
    if (!this.watchlist[symbol]) return;
    if (!this.watchlist[symbol].isQuoteSubscribed) {
      this.polygon.subscribeQuote(symbol);
      this.watchlist[symbol].isQuoteSubscribed = true;
      this.dashboard.logInfo(`Quote subscription ensured for ${symbol}`);
    }
  }
}

module.exports = OrderManager;
