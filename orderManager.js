// orderManager.js

const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');

class OrderManager {
  constructor(dashboard, polygon) {
    this.positions = {}; // symbol => position info
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.apiCallDelay = 200; // Milliseconds between API calls to prevent rate limits
    this.orderTracking = {}; // orderId => { symbol, type, qty, side, filledQty }
    this.orderQueue = []; // Queue to manage order processing
    this.isProcessingQueue = false; // Flag to prevent multiple queue processors

    // Initializing existing positions
    this.initializeExistingPositions();

    // Periodic tasks
    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(
      () => this.checkBreakevenStops(),
      config.pollingIntervals.breakevenCheck
    );
  }

  /**
   * Generates a unique client order ID with an optional prefix.
   * @param {string} prefix - Prefix for the order ID.
   * @returns {string} - Generated client order ID.
   */
  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Pauses execution for a specified duration.
   * @param {number} ms - Milliseconds to sleep.
   * @returns {Promise} - Resolves after the specified duration.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retries an asynchronous operation with exponential backoff in case of rate limits.
   * @param {Function} operation - The asynchronous operation to retry.
   * @param {number} retries - Number of retry attempts.
   * @param {number} delay - Initial delay in milliseconds.
   * @returns {Promise} - Resolves with the operation result or rejects after retries.
   */
  async retryOperation(operation, retries = 5, delay = 1000) {
    try {
      return await operation();
    } catch (err) {
      if (retries <= 0) throw err;
      if (err.statusCode === 429) {
        // Rate limit
        logger.warn(`Rate limit hit. Retrying in ${delay}ms...`);
        this.dashboard.log(`Rate limit hit. Retrying in ${delay}ms...`);
        await this.sleep(delay);
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
      // Fetch all open positions using the Alpaca API
      const positions = await alpaca.getPositions();

      for (const position of positions) {
        await this.addPosition(position);
      }

      // Update the dashboard with the loaded positions
      this.dashboard.updatePositions(Object.values(this.positions));
    } catch (err) {
      logger.error(`Error initializing existing positions: ${err.message}`);
      this.dashboard.error(
        `Error initializing existing positions: ${err.message}`
      );
    }
  }

  /**
   * Adds a new position to the tracker.
   * @param {Object} position - Position object from Alpaca.
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
      currentBid: avgEntryPrice, // Initialize with avgEntryPrice
      currentAsk: avgEntryPrice, // Initialize with avgEntryPrice
      currentPrice: avgEntryPrice,
      profitTargetsHit: 0,
      isActive: true,
      hasBreakevenStop: false, // Track if breakeven stop is set
      isProcessing: false, // Prevent duplicate order placements
    };

    logger.info(
      `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
    );
    this.dashboard.log(
      `Position added: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
    );

    // Cancel all existing orders for the symbol
    await this.cancelAllOrdersForSymbol(symbol);

    // Set initial stop loss for the new position
    await this.setInitialStopLoss(symbol);

    // Subscribe to Polygon quotes for the symbol
    this.polygon.subscribe(symbol);

    // Update dashboard positions
    this.dashboard.updatePositions(Object.values(this.positions));
  }

  /**
   * Removes an existing position from tracking.
   * @param {string} symbol - The stock symbol to remove.
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
    }
  }

  /**
   * Cancels all existing orders for a given symbol.
   * @param {string} symbol - The stock symbol.
   */
  async cancelAllOrdersForSymbol(symbol) {
    try {
      const orders = await alpaca.getOrders({
        status: 'open',
        symbols: [symbol],
      });
      for (const order of orders) {
        await this.retryOperation(() => alpaca.cancelOrder(order.id));
        logger.info(`Cancelled order ${order.id} for ${symbol}.`);
        this.dashboard.log(`Cancelled order ${order.id} for ${symbol}.`);

        // Track the cancellation
        this.orderTracking[order.id] = {
          symbol,
          type: 'cancelled',
          qty: parseFloat(order.qty),
          side: order.side,
          filledQty: 0,
        };

        await this.sleep(this.apiCallDelay); // Throttle API calls
      }

      // After cancellation, update active orders on the dashboard
      const activeOrders = await alpaca.getOrders({ status: 'open' });
      this.dashboard.updateOrders(activeOrders);
    } catch (err) {
      logger.error(`Error cancelling orders for ${symbol}: ${err.message}`);
      this.dashboard.error(
        `Error cancelling orders for ${symbol}: ${err.message}`
      );
    }
  }

  /**
   * Calculates dynamic IOC offset based on price difference thresholds.
   * @param {string} symbol - The stock symbol.
   * @returns {number} - Calculated offset in cents.
   */
  calculateDynamicIOCOffset(symbol) {
    const pos = this.positions[symbol];
    if (!pos) return config.orderSettings.limitOffsetCents; // Default to config value if position not found

    const priceDifference = Math.abs(pos.currentPrice - pos.avgEntryPrice);
    const priceDifferencePercent = (priceDifference / pos.avgEntryPrice) * 100;

    let dynamicOffset = config.orderSettings.limitOffsetCents; // Start with base offset

    for (const threshold of config.orderSettings.dynamicOffsetThresholds) {
      if (priceDifferencePercent >= threshold.percentage) {
        dynamicOffset = threshold.offset;
      }
    }

    // Ensure the offset does not exceed the maximum limit
    dynamicOffset = Math.min(
      dynamicOffset,
      config.orderSettings.maxLimitOffsetCents
    );

    return dynamicOffset;
  }

  /**
   * Sets the initial stop loss order for a position.
   * @param {string} symbol - The stock symbol.
   */
  async setInitialStopLoss(symbol) {
    const pos = this.positions[symbol];
    const side = pos.side;
    const qty = Math.abs(pos.qty); // Ensure qty is positive

    let stopPrice;
    if (side === 'buy') {
      stopPrice =
        pos.avgEntryPrice - config.orderSettings.stopLossOffsetCents / 100;
    } else if (side === 'sell') {
      stopPrice =
        pos.avgEntryPrice + config.orderSettings.stopLossOffsetCents / 100;
    } else {
      logger.warn(`Unknown position side for ${symbol}.`);
      this.dashboard.log(`Unknown position side for ${symbol}.`);
      return;
    }

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side: side === 'buy' ? 'sell' : 'buy', // Opposite side to close the position
      type: 'stop',
      stop_price: stopPrice.toFixed(2),
      time_in_force: 'gtc',
      client_order_id: this.generateClientOrderId('STOP'),
    };

    logger.info(`Attempting to set stop loss order: ${JSON.stringify(order)}`);
    this.dashboard.log(
      `Attempting to set stop loss order: ${JSON.stringify(order)}`
    );

    try {
      const result = await this.retryOperation(() => alpaca.createOrder(order));
      logger.info(
        `Stop loss set for ${symbol} at $${stopPrice.toFixed(2)}. Order ID: ${
          result.id
        }`
      );
      this.dashboard.log(
        `Stop loss set for ${symbol} at $${stopPrice.toFixed(2)}. Order ID: ${
          result.id
        }`
      );

      // Track the stop loss order
      this.orderTracking[result.id] = {
        symbol,
        type: 'stop',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };
    } catch (err) {
      logger.error(
        `Error setting stop loss for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
      this.dashboard.error(
        `Error setting stop loss for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
    }
  }
  /**
   * Cancels all stop loss orders for a given symbol.
   * @param {string} symbol - The stock symbol.
   */
  async cancelStopLosses(symbol) {
    try {
      const orders = await alpaca.getOrders({
        status: 'open',
        symbols: [symbol],
      });
      for (const order of orders) {
        if (order.type === 'stop') {
          await this.retryOperation(() => alpaca.cancelOrder(order.id));
          logger.info(`Cancelled stop loss order ${order.id} for ${symbol}.`);
          this.dashboard.log(
            `Cancelled stop loss order ${order.id} for ${symbol}.`
          );

          // Track the cancellation
          this.orderTracking[order.id] = {
            symbol,
            type: 'stop_cancelled',
            qty: parseFloat(order.qty),
            side: order.side,
            filledQty: 0,
          };

          await this.sleep(this.apiCallDelay); // Throttle API calls
        }
      }
    } catch (err) {
      logger.error(
        `Error cancelling stop losses for ${symbol}: ${err.message}`
      );
      this.dashboard.error(
        `Error cancelling stop losses for ${symbol}: ${err.message}`
      );
    }
  }

  /**
   * Places an Immediate-Or-Cancel (IOC) order.
   * @param {string} symbol - The stock symbol.
   * @param {number} qty - Quantity to order.
   * @param {string} side - 'buy' or 'sell'.
   */
  async placeIOCOrder(symbol, qty, side) {
    qty = Math.abs(qty); // Ensure qty is positive

    // Calculate dynamic IOC offset
    const dynamicOffset = this.calculateDynamicIOCOffset(symbol);

    // Get the latest market data
    let currentPrice;
    try {
      const lastQuote = await alpaca.getLatestQuote(symbol);
      if (side === 'buy') {
        currentPrice = lastQuote.askprice; // Correct property name
      } else if (side === 'sell') {
        currentPrice = lastQuote.bidprice; // Correct property name
      } else {
        throw new Error(`Invalid side: ${side}`);
      }
    } catch (err) {
      logger.error(`Error fetching latest quote for ${symbol}: ${err.message}`);
      this.dashboard.error(
        `Error fetching latest quote for ${symbol}: ${err.message}`
      );
      return;
    }

    // Adjust limit price with offset
    let limitPrice;
    if (side === 'buy') {
      // Closing short position, increase limit price
      limitPrice = currentPrice + dynamicOffset / 100; // Convert cents to dollars
    } else if (side === 'sell') {
      // Closing long position, decrease limit price
      limitPrice = currentPrice - dynamicOffset / 100; // Convert cents to dollars
    }

    // Ensure limit price does not cross the market
    try {
      const lastQuote = await alpaca.getLatestQuote(symbol);
      if (side === 'sell' && limitPrice < lastQuote.bidprice) {
        limitPrice = lastQuote.bidprice;
      } else if (side === 'buy' && limitPrice > lastQuote.askprice) {
        limitPrice = lastQuote.askprice;
      }
    } catch (err) {
      logger.error(`Error fetching latest quote for ${symbol}: ${err.message}`);
      this.dashboard.error(
        `Error fetching latest quote for ${symbol}: ${err.message}`
      );
      return;
    }

    // Cancel existing orders before placing a new IOC order
    await this.cancelAllOrdersForSymbol(symbol);

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side,
      type: 'limit',
      limit_price: limitPrice.toFixed(2),
      time_in_force: 'ioc',
      client_order_id: this.generateClientOrderId('IOC'),
    };

    logger.info(`Attempting to place IOC order: ${JSON.stringify(order)}`);
    this.dashboard.log(
      `Attempting to place IOC order: ${JSON.stringify(order)}`
    );

    try {
      const result = await this.retryOperation(() => alpaca.createOrder(order));
      logger.info(
        `Placed IOC order for ${qty} shares of ${symbol} at $${limitPrice.toFixed(
          2
        )}. Order ID: ${result.id}`
      );
      this.dashboard.log(
        `Placed IOC order for ${qty} shares of ${symbol} at $${limitPrice.toFixed(
          2
        )}. Order ID: ${result.id}`
      );

      // Track the IOC order
      this.orderTracking[result.id] = {
        symbol,
        type: 'ioc',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };

      // Add to order queue for tracking
      this.orderQueue.push(result.id);
      this.processOrderQueue(); // Start processing if not already
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
   * Places a breakeven stop order for a position.
   * @param {string} symbol - The stock symbol.
   */
  async placeBreakevenStop(symbol) {
    const pos = this.positions[symbol];
    const side = pos.side;
    const qty = Math.abs(pos.qty); // Ensure qty is positive

    const stopPrice = pos.avgEntryPrice;

    // Throttle to account for order processing time
    await this.sleep(this.apiCallDelay);

    const order = {
      symbol,
      qty: qty.toFixed(0),
      side: side === 'buy' ? 'sell' : 'buy',
      type: 'stop',
      stop_price: stopPrice.toFixed(2),
      time_in_force: 'gtc',
      client_order_id: this.generateClientOrderId('BREAKEVEN'),
    };

    logger.info(
      `Attempting to set breakeven stop order: ${JSON.stringify(order)}`
    );
    this.dashboard.log(
      `Attempting to set breakeven stop order: ${JSON.stringify(order)}`
    );

    try {
      const result = await this.retryOperation(() => alpaca.createOrder(order));
      logger.info(
        `Breakeven stop set for ${symbol} at $${stopPrice.toFixed(
          2
        )}. Order ID: ${result.id}`
      );
      this.dashboard.log(
        `Breakeven stop set for ${symbol} at $${stopPrice.toFixed(
          2
        )}. Order ID: ${result.id}`
      );
      pos.hasBreakevenStop = true; // Mark that breakeven stop is set

      // Track the breakeven stop order
      this.orderTracking[result.id] = {
        symbol,
        type: 'breakeven_stop',
        qty: parseFloat(order.qty),
        side: order.side,
        filledQty: 0,
      };
    } catch (err) {
      logger.error(
        `Error setting breakeven stop for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
      this.dashboard.error(
        `Error setting breakeven stop for ${symbol}: ${
          err.response ? JSON.stringify(err.response.data) : err.message
        }`
      );
    }
  }

  /**
   * Handles quote updates from Polygon and manages profit targets.
   * @param {string} symbol - The stock symbol.
   * @param {number} bidPrice - Latest bid price.
   * @param {number} askPrice - Latest ask price.
   */
  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const pos = this.positions[symbol];
    if (!pos || !pos.isActive) {
      return;
    }

    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? askPrice : bidPrice;

    // Update current bid and ask prices
    pos.currentBid = bidPrice;
    pos.currentAsk = askPrice;

    pos.currentPrice = currentPrice; // Update current price for P&L calculations

    const profitCents =
      side === 'buy'
        ? ((currentPrice - entryPrice) * 100).toFixed(2)
        : ((entryPrice - currentPrice) * 100).toFixed(2);

    const profitTargets = config.orderSettings.profitTargets;

    // Check if all profit targets have been hit
    if (pos.profitTargetsHit >= profitTargets.length && !pos.hasBreakevenStop) {
      // Ensure breakeven stop is in place
      await this.placeBreakevenStop(symbol);
      return;
    }

    // If all targets are hit and breakeven stop is set, do nothing
    if (pos.profitTargetsHit >= profitTargets.length) {
      return;
    }

    const target = profitTargets[pos.profitTargetsHit];

    // Prevent duplicate order placements using isProcessing flag
    if (!pos.isProcessing && parseFloat(profitCents) >= target.targetCents) {
      pos.isProcessing = true; // Mark as processing

      logger.info(
        `Profit target hit for ${symbol}: +${profitCents}¢ >= +${target.targetCents}¢`
      );
      this.dashboard.log(
        `Profit target hit for ${symbol}: +${profitCents}¢ >= +${target.targetCents}¢`
      );

      // Cancel existing orders before proceeding
      await this.cancelAllOrdersForSymbol(symbol);

      // Update the position to reflect the latest quantity
      await this.updatePositionQuantity(symbol);

      // Calculate order qty based on current position size
      let qtyToClose = Math.floor(pos.qty * (target.percentToClose / 100));

      if (qtyToClose <= 0) {
        logger.warn(`Quantity to close is zero or negative for ${symbol}.`);
        this.dashboard.log(
          `Quantity to close is zero or negative for ${symbol}.`
        );
        pos.isProcessing = false; // Reset processing flag
        return;
      }

      // Place IOC order
      await this.placeIOCOrder(
        symbol,
        qtyToClose,
        side === 'buy' ? 'sell' : 'buy'
      );

      // The IOC order is added to the queue and processed asynchronously

      pos.profitTargetsHit += 1;

      // Reset breakeven stop flag
      pos.hasBreakevenStop = false;

      pos.isProcessing = false; // Reset processing flag
    }
  }

  /**
   * Periodically checks and ensures breakeven stops are in place.
   */
  async checkBreakevenStops() {
    for (const symbol in this.positions) {
      const pos = this.positions[symbol];
      if (
        pos.isActive &&
        !pos.hasBreakevenStop &&
        pos.profitTargetsHit > 0 &&
        !pos.isProcessing
      ) {
        logger.info(
          `Breakeven stop missing for ${symbol}, placing breakeven stop.`
        );
        this.dashboard.log(
          `Breakeven stop missing for ${symbol}, placing breakeven stop.`
        );
        await this.placeBreakevenStop(symbol);
      }
    }
  }

  /**
   * Polls and updates the status of tracked orders.
   */
  async pollOrderStatuses() {
    try {
      // Fetch all open orders
      const openOrders = await alpaca.getOrders({
        status: 'open',
      });

      // Update the dashboard with active orders
      this.dashboard.updateOrders(openOrders);

      for (const order of openOrders) {
        const trackedOrder = this.orderTracking[order.id];
        if (trackedOrder) {
          const filledQty = parseFloat(order.filled_qty);
          const remainingQty = parseFloat(order.qty) - filledQty;

          // Update filled quantity
          trackedOrder.filledQty = filledQty;

          if (filledQty > 0) {
            // Update the position based on the filled quantity
            const pos = this.positions[trackedOrder.symbol];
            if (pos) {
              if (
                trackedOrder.type === 'ioc' ||
                trackedOrder.type === 'breakeven_stop'
              ) {
                // For IOC and breakeven stop orders, handle accordingly
                pos.qty -= filledQty;

                logger.info(
                  `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`
                );
                this.dashboard.log(
                  `Order ${order.id} filled ${filledQty} qty for ${trackedOrder.symbol}. Remaining qty: ${pos.qty}`
                );

                // Remove the order from tracking if fully filled
                if (remainingQty <= 0) {
                  delete this.orderTracking[order.id];
                }

                // Update the dashboard
                this.dashboard.updatePositions(Object.values(this.positions));
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
    } catch (err) {
      logger.error(`Error polling order statuses: ${err.message}`);
      this.dashboard.error(`Error polling order statuses: ${err.message}`);
    }
  }

  /**
   * Updates the quantity of a position by fetching the latest data from Alpaca.
   * @param {string} symbol - The stock symbol.
   */
  async updatePositionQuantity(symbol) {
    try {
      const position = await alpaca.getPosition(symbol);
      const qty = Math.abs(parseFloat(position.qty));
      this.positions[symbol].qty = qty;

      // If position qty is zero, mark as inactive and remove from tracking
      if (qty === 0) {
        delete this.positions[symbol];
        logger.info(`Position in ${symbol} fully closed.`);
        this.dashboard.log(`Position in ${symbol} fully closed.`);
        this.polygon.unsubscribe(symbol);
      }
    } catch (err) {
      if (err.statusCode === 404) {
        // Position is closed
        if (this.positions[symbol]) {
          this.positions[symbol].qty = 0;
          this.positions[symbol].isActive = false;
          logger.info(`Position in ${symbol} fully closed.`);
          this.dashboard.log(`Position in ${symbol} fully closed.`);
          this.polygon.unsubscribe(symbol);
        }
      } else {
        logger.error(
          `Error updating position quantity for ${symbol}: ${err.message}`
        );
        this.dashboard.error(
          `Error updating position quantity for ${symbol}: ${err.message}`
        );
      }
    }
  }

  /**
   * Processes the order queue by monitoring and handling order statuses.
   */
  async processOrderQueue() {
    if (this.isProcessingQueue) {
      // Already processing
      return;
    }
    this.isProcessingQueue = true;

    while (this.orderQueue.length > 0) {
      const orderId = this.orderQueue[0]; // Peek at the first order
      try {
        const order = await alpaca.getOrder(orderId);
        if (order.status === 'filled' || order.status === 'canceled') {
          // Remove the order from the queue
          this.orderQueue.shift();

          // Update position quantity after order execution
          const symbol = order.symbol;
          await this.updatePositionQuantity(symbol);

          // Place a new breakeven stop if necessary
          const pos = this.positions[symbol];
          if (pos && pos.isActive && pos.qty > 0) {
            await this.placeBreakevenStop(symbol);
          }
        } else {
          // Order is still open, wait before checking again
          await this.sleep(this.apiCallDelay);
        }
      } catch (err) {
        logger.error(`Error processing order ${orderId}: ${err.message}`);
        this.dashboard.error(
          `Error processing order ${orderId}: ${err.message}`
        );
        // Remove the order from the queue to prevent infinite loop
        this.orderQueue.shift();
      }
    }

    this.isProcessingQueue = false;
  }
}

module.exports = OrderManager;
