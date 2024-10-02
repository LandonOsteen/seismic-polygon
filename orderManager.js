// orderManager.js

const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const Bottleneck = require('bottleneck'); // Rate limiting library

class OrderManager {
  constructor(dashboard, polygon) {
    this.positions = {}; // symbol => position info
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.orderTracking = {}; // orderId => { symbol, type, qty, side, filledQty }

    // Flags to prevent concurrent API calls
    this.isRefreshing = false;
    this.isPolling = false;

    // Initialize Alpaca rate limiter using Bottleneck
    this.limiter = new Bottleneck({
      minTime: 350, // Minimum time between requests in ms (approx 2.85 req/sec)
      maxConcurrent: 1, // Ensure requests are executed sequentially
    });

    // Wrap Alpaca API calls with the rate limiter
    this.limitedGetPositions = this.limiter.wrap(
      alpaca.getPositions.bind(alpaca)
    );
    this.limitedGetOrders = this.limiter.wrap(alpaca.getOrders.bind(alpaca));
    this.limitedCreateOrder = this.limiter.wrap(
      alpaca.createOrder.bind(alpaca)
    );

    // Initialize existing positions
    this.initializeExistingPositions();

    // Periodic tasks
    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );

    // Periodically refresh positions
    setInterval(
      () => this.refreshPositions(),
      config.pollingIntervals.positionRefresh
    );
  }

  /**
   * Generates a unique client order ID with an optional prefix.
   */
  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Pauses execution for a specified duration.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retries an asynchronous operation with exponential backoff in case of rate limits.
   */
  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (err.statusCode === 429) {
        // Rate limit
        const jitter = Math.random() * 1000; // Add jitter to prevent thundering herd
        const totalDelay = delay + jitter;
        logger.warn(
          `Rate limit hit. Retrying in ${totalDelay.toFixed(0)}ms...`
        );
        this.dashboard.log(
          `Rate limit hit. Retrying in ${totalDelay.toFixed(0)}ms...`
        );
        await this.sleep(totalDelay);
        return this.retryOperation(operation, retries - 1, delay * 2);
      }
      throw err;
    }
  }

  /**
   * Initializes existing positions by fetching them from Alpaca and adding to tracking.
   */
  async initializeExistingPositions() {
    try {
      const positions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      for (const position of positions) {
        await this.addPosition(position);
      }

      // Update the dashboard with the loaded positions
      this.dashboard.updatePositions(Object.values(this.positions));

      // Update summary
      this.updateSummary();
    } catch (err) {
      logger.error(`Error initializing existing positions: ${err.message}`);
      this.dashboard.error(
        `Error initializing existing positions: ${err.message}`
      );
    }
  }

  /**
   * Adds a new position to the tracker.
   */
  async addPosition(position) {
    const symbol = position.symbol;
    const qty = Math.abs(parseFloat(position.qty)); // Ensure qty is positive
    const side = position.side === 'long' ? 'buy' : 'sell';
    const avgEntryPrice = parseFloat(position.avg_entry_price);

    this.positions[symbol] = {
      symbol,
      qty,
      initialQty: qty,
      side,
      avgEntryPrice,
      currentBid: parseFloat(position.current_price) - 0.01, // Approximation
      currentAsk: parseFloat(position.current_price) + 0.01, // Approximation
      currentPrice: parseFloat(position.current_price),
      profitCents: 0, // Initialize profit
      profitTargetsHit: 0,
      isActive: true,
      isProcessing: false,
      stopPrice: this.calculateInitialStopPrice(avgEntryPrice, side),
      stopTriggered: false,
    };

    logger.info(
      `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
    );
    this.dashboard.log(
      `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
    );

    // Subscribe to Polygon quotes for the symbol
    this.polygon.subscribe(symbol);

    // Update dashboard positions
    this.dashboard.updatePositions(Object.values(this.positions));

    // Update summary
    this.updateSummary();
  }

  /**
   * Calculates the initial stop price based on the position side.
   */
  calculateInitialStopPrice(avgEntryPrice, side) {
    const stopLossCents = config.orderSettings.stopLossCents;
    if (side === 'buy') {
      // Long position: stop price is below entry price
      return avgEntryPrice - stopLossCents / 100;
    } else if (side === 'sell') {
      // Short position: stop price is above entry price
      return avgEntryPrice + stopLossCents / 100;
    }
    // Default to breakeven if side is unknown
    return avgEntryPrice;
  }

  /**
   * Removes an existing position from tracking.
   */
  removePosition(symbol) {
    if (this.positions[symbol]) {
      delete this.positions[symbol];
      logger.info(`Position removed: ${symbol}`);
      this.dashboard.log(`Position removed: ${symbol}`);

      // Unsubscribe from Polygon quotes as the position is removed
      this.polygon.unsubscribe(symbol);

      // Update dashboard positions
      this.dashboard.updatePositions(Object.values(this.positions));

      // Update summary
      this.updateSummary();
    }
  }

  /**
   * Handles quote updates from Polygon and manages profit targets and stop monitoring.
   */
  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const pos = this.positions[symbol];
    if (!pos || !pos.isActive) {
      return;
    }

    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? bidPrice : askPrice;

    // Update current bid and ask prices
    pos.currentBid = bidPrice;
    pos.currentAsk = askPrice;
    pos.currentPrice = currentPrice;

    // Calculate profit/loss in cents
    pos.profitCents = (
      (currentPrice - entryPrice) *
      100 *
      (side === 'buy' ? 1 : -1)
    ).toFixed(2);

    // Log current profit
    this.dashboard.log(
      `Symbol: ${symbol} | Profit: ${
        pos.profitCents
      }¢ | Current Price: $${currentPrice.toFixed(2)}`
    );

    // Check for stop trigger only if stop has not been triggered yet
    if (!pos.stopTriggered) {
      if (
        (side === 'buy' && currentPrice <= pos.stopPrice) || // Long position stop loss
        (side === 'sell' && currentPrice >= pos.stopPrice) // Short position stop loss
      ) {
        pos.stopTriggered = true;
        logger.info(
          `Stop condition met for ${symbol}. Initiating market order to close position.`
        );
        this.dashboard.log(
          `Stop condition met for ${symbol}. Initiating market order to close position.`
        );
        await this.closePositionMarketOrder(symbol);
        return;
      }
    }

    const profitTargets = config.orderSettings.profitTargets;

    // Check if all profit targets have been hit
    if (pos.profitTargetsHit >= profitTargets.length) {
      return;
    }

    const target = profitTargets[pos.profitTargetsHit];

    // Prevent duplicate order placements
    if (
      !pos.isProcessing &&
      parseFloat(pos.profitCents) >= target.targetCents
    ) {
      pos.isProcessing = true;

      logger.info(
        `Profit target hit for ${symbol}: +${pos.profitCents}¢ >= +${target.targetCents}¢`
      );
      this.dashboard.log(
        `Profit target hit for ${symbol}: +${pos.profitCents}¢ >= +${target.targetCents}¢`
      );

      // Calculate order qty based on current position size
      let qtyToClose = Math.floor(pos.qty * (target.percentToClose / 100));

      // Safety Check: Ensure qtyToClose does not exceed pos.qty
      qtyToClose = Math.min(qtyToClose, pos.qty);

      if (qtyToClose <= 0) {
        logger.warn(`Quantity to close is zero or negative for ${symbol}.`);
        this.dashboard.log(
          `Quantity to close is zero or negative for ${symbol}.`
        );
        pos.isProcessing = false;
        return;
      }

      // Place IOC order
      await this.placeIOCOrder(
        symbol,
        qtyToClose,
        side === 'buy' ? 'sell' : 'buy'
      );

      // Increment profit targets hit
      pos.profitTargetsHit += 1;

      // After the second profit target, adjust stop monitoring to breakeven
      if (pos.profitTargetsHit === 2) {
        logger.info(
          `Second profit target hit for ${symbol}. Adjusting stop monitoring to breakeven.`
        );
        this.dashboard.log(
          `Second profit target hit for ${symbol}. Adjusting stop monitoring to breakeven.`
        );
        // Update stop price to breakeven
        pos.stopPrice = entryPrice;

        // Log the new stop price
        this.dashboard.log(
          `Adjusted stop price for ${symbol} to breakeven at $${entryPrice.toFixed(
            2
          )}.`
        );
      }

      pos.isProcessing = false;

      // Update summary after processing
      this.updateSummary();
    }
  }

  /**
   * Places an Immediate-Or-Cancel (IOC) order.
   */
  async placeIOCOrder(symbol, qty, side) {
    qty = Math.abs(qty);

    const pos = this.positions[symbol];
    let marketPrice;
    if (side === 'buy') {
      // For short positions, buy at the ask price
      marketPrice = pos.currentAsk;
    } else if (side === 'sell') {
      // For long positions, sell at the bid price
      marketPrice = pos.currentBid;
    } else {
      logger.error(`Invalid side "${side}" for IOC order on ${symbol}.`);
      this.dashboard.error(
        `Invalid side "${side}" for IOC order on ${symbol}.`
      );
      return;
    }

    // **Safety Check: Ensure marketPrice is valid**
    if (marketPrice <= 0 || isNaN(marketPrice)) {
      logger.error(
        `Invalid market price for ${symbol}. Cannot place ${side} order.`
      );
      this.dashboard.error(
        `Invalid market price for ${symbol}. Cannot place ${side} order.`
      );
      return;
    }

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'market', // Use market order for immediate execution
      time_in_force: 'day',
      client_order_id: this.generateClientOrderId('IOC'),
    };

    logger.info(`Attempting to place IOC order: ${JSON.stringify(order)}`);
    this.dashboard.log(
      `Attempting to place IOC order: ${JSON.stringify(order)}`
    );

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      logger.info(
        `Placed IOC order for ${qty} shares of ${symbol}. Order ID: ${result.id}`
      );
      this.dashboard.log(
        `Placed IOC order for ${qty} shares of ${symbol}. Order ID: ${result.id}`
      );

      // Track the IOC order
      this.orderTracking[result.id] = {
        symbol,
        type: 'ioc',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };

      // Immediately refresh positions after placing an order
      await this.refreshPositions();
    } catch (err) {
      logger.error(
        `Error placing IOC order for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
      this.dashboard.error(
        `Error placing IOC order for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
    }
  }

  /**
   * Polls and updates the status of tracked orders.
   */
  async pollOrderStatuses() {
    if (this.isPolling) {
      // Optionally, you can choose not to log this warning to the dashboard
      return;
    }

    this.isPolling = true;

    try {
      // Fetch all open orders
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open' })
      );

      // Update the dashboard with active orders
      this.dashboard.updateOrders(openOrders);

      for (const order of openOrders) {
        const trackedOrder = this.orderTracking[order.id];
        if (trackedOrder) {
          const filledQty = parseFloat(order.filled_qty || '0');
          const totalQty = parseFloat(order.qty || '0');
          const remainingQty = totalQty - filledQty;

          // Update filled quantity
          trackedOrder.filledQty = filledQty;

          if (filledQty > 0) {
            // Update the position based on the filled quantity
            const pos = this.positions[trackedOrder.symbol];
            if (pos) {
              if (
                trackedOrder.type === 'ioc' ||
                trackedOrder.type === 'close'
              ) {
                // For IOC and close orders, adjust position quantity
                pos.qty -= filledQty;

                logger.info(
                  `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`
                );
                this.dashboard.log(
                  `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`
                );

                // Recalculate profit since qty has changed
                pos.profitCents = (
                  (pos.currentPrice - pos.avgEntryPrice) *
                  100 *
                  (pos.side === 'buy' ? 1 : -1)
                ).toFixed(2);

                // Update the dashboard
                this.dashboard.updatePositions(Object.values(this.positions));

                // If all qty is closed, remove the position
                if (pos.qty <= 0) {
                  this.removePosition(trackedOrder.symbol);
                }
              }
              // Handle other order types if necessary
            }
          }

          // Remove filled or canceled orders from tracking
          if (order.status === 'filled' || order.status === 'canceled') {
            delete this.orderTracking[order.id];
          }
        }
      }

      // Update summary after polling
      this.updateSummary();
    } catch (err) {
      logger.error(`Error polling order statuses: ${err.message}`);
      this.dashboard.error(`Error polling order statuses: ${err.message}`);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Closes the full position with a market order.
   */
  async closePositionMarketOrder(symbol) {
    const pos = this.positions[symbol];
    const qty = pos.qty;

    if (qty <= 0) {
      logger.warn(`Attempted to close position for ${symbol} with qty ${qty}.`);
      this.dashboard.log(
        `Attempted to close position for ${symbol} with qty ${qty}.`
      );
      return;
    }

    const side = pos.side === 'buy' ? 'sell' : 'buy';

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'market',
      time_in_force: 'day',
      client_order_id: this.generateClientOrderId('CLOSE'),
    };

    logger.info(`Closing position with market order: ${JSON.stringify(order)}`);
    this.dashboard.log(
      `Closing position with market order: ${JSON.stringify(order)}`
    );

    try {
      const result = await this.retryOperation(() =>
        this.limitedCreateOrder(order)
      );
      logger.info(
        `Market order placed to close position in ${symbol}. Order ID: ${result.id}`
      );
      this.dashboard.log(
        `Market order placed to close position in ${symbol}. Order ID: ${result.id}`
      );

      // Track the market order
      this.orderTracking[result.id] = {
        symbol,
        type: 'close',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };

      // Immediately refresh positions after placing an order
      await this.refreshPositions();
    } catch (err) {
      logger.error(
        `Error placing market order to close position for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
      this.dashboard.error(
        `Error placing market order to close position for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
    }
  }

  /**
   * Fetches the latest positions from Alpaca and updates internal tracking.
   */
  async refreshPositions() {
    if (this.isRefreshing) {
      // Do not send this warning to the dashboard to prevent clutter
      return;
    }

    this.isRefreshing = true;

    try {
      const latestPositions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      const latestPositionMap = {};
      latestPositions.forEach((position) => {
        latestPositionMap[position.symbol] = position;
      });

      // Update existing positions
      for (const symbol in this.positions) {
        if (latestPositionMap[symbol]) {
          const latestQty = Math.abs(parseFloat(latestPositionMap[symbol].qty));
          const latestAvgEntryPrice = parseFloat(
            latestPositionMap[symbol].avg_entry_price
          );
          this.positions[symbol].qty = latestQty;
          this.positions[symbol].avgEntryPrice = latestAvgEntryPrice;
          this.positions[symbol].currentBid =
            parseFloat(latestPositionMap[symbol].current_price) - 0.01; // Approximation
          this.positions[symbol].currentAsk =
            parseFloat(latestPositionMap[symbol].current_price) + 0.01; // Approximation
          this.positions[symbol].currentPrice = parseFloat(
            latestPositionMap[symbol].current_price
          );

          // Recalculate profit since avgEntryPrice might have changed
          this.positions[symbol].profitCents = (
            (this.positions[symbol].currentPrice -
              this.positions[symbol].avgEntryPrice) *
            100 *
            (this.positions[symbol].side === 'buy' ? 1 : -1)
          ).toFixed(2);

          // Recalculate stopPrice if necessary
          if (this.positions[symbol].profitTargetsHit >= 2) {
            this.positions[symbol].stopPrice = latestAvgEntryPrice; // Breakeven
          } else {
            this.positions[symbol].stopPrice = this.calculateInitialStopPrice(
              latestAvgEntryPrice,
              this.positions[symbol].side
            );
          }

          // If quantity is zero, remove the position
          if (latestQty === 0) {
            this.removePosition(symbol);
          }
        } else {
          // Position no longer exists; remove from tracking
          this.removePosition(symbol);
        }
      }

      // Add any new positions not currently tracked
      latestPositions.forEach((position) => {
        const symbol = position.symbol;
        if (!this.positions[symbol]) {
          this.addPosition(position);
        }
      });

      // Update dashboard and summary
      this.dashboard.updatePositions(Object.values(this.positions));
      this.updateSummary();
    } catch (err) {
      logger.error(`Error refreshing positions: ${err.message}`);
      this.dashboard.error(`Error refreshing positions: ${err.message}`);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Updates the Summary box with aggregated data.
   */
  updateSummary() {
    const totalPositions = Object.keys(this.positions).length;
    const activePositions = Object.values(this.positions).filter(
      (pos) => pos.isActive
    ).length;
    const closedPositions = totalPositions - activePositions;

    const totalOrders = Object.keys(this.orderTracking).length;
    const activeOrders = Object.values(this.orderTracking).filter(
      (order) => order.filledQty < order.qty
    ).length;
    const completedOrders = totalOrders - activeOrders;

    const summary = {
      totalPositions,
      activePositions,
      closedPositions,
      totalOrders,
      activeOrders,
      completedOrders,
    };

    this.dashboard.updateSummary(summary);
  }
}

module.exports = OrderManager;
