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
  }

  generateClientOrderId(prefix = 'MY_SYSTEM') {
    return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Retry operation with exponential backoff
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

  // Add a new position
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
  }

  // Remove an existing position
  removePosition(symbol) {
    if (this.positions[symbol]) {
      delete this.positions[symbol];
      logger.info(`Position removed: ${symbol}`);
      this.dashboard.log(`Position removed: ${symbol}`);

      // Unsubscribe from Polygon quotes as the position is removed
      this.polygon.unsubscribe(symbol);
    }
  }

  // Cancel all existing orders for a symbol
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
    } catch (err) {
      logger.error(`Error cancelling orders for ${symbol}: ${err.message}`);
      this.dashboard.error(
        `Error cancelling orders for ${symbol}: ${err.message}`
      );
    }
  }

  // Calculate dynamic IOC offset (max 3 cents)
  calculateDynamicIOCOffset(symbol) {
    const pos = this.positions[symbol];
    if (!pos) return config.iocOffset; // Default to config value if position not found

    // Example Logic:
    // Calculate the percentage difference between current price and entry price
    const priceDifference = Math.abs(pos.currentPrice - pos.avgEntryPrice);
    const priceDifferencePercent = (priceDifference / pos.avgEntryPrice) * 100;

    // Set dynamic offset based on price difference percentage
    let dynamicOffset = 1; // Base offset in cents
    if (priceDifferencePercent >= 1) dynamicOffset = 2;
    if (priceDifferencePercent >= 2) dynamicOffset = 3;

    // Ensure the offset does not exceed 3 cents
    dynamicOffset = Math.min(dynamicOffset, 3);

    return dynamicOffset;
  }

  async setInitialStopLoss(symbol) {
    const pos = this.positions[symbol];
    const side = pos.side;
    const qty = Math.abs(pos.qty); // Ensure qty is positive

    let stopPrice;
    if (side === 'buy') {
      stopPrice = pos.avgEntryPrice - config.stopLossOffset / 100; // For long positions
    } else if (side === 'sell') {
      stopPrice = pos.avgEntryPrice + config.stopLossOffset / 100; // For short positions
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

  async placeIOCOrder(symbol, qty, currentBidOrAskPrice, side) {
    qty = Math.abs(qty); // Ensure qty is positive

    // Calculate dynamic IOC offset
    const dynamicOffset = this.calculateDynamicIOCOffset(symbol);

    // Adjust limit price with dynamic offset
    let limitPrice;
    if (side === 'sell') {
      // Closing long position
      limitPrice = (currentBidOrAskPrice * 100 - dynamicOffset) / 100;
    } else {
      // Closing short position
      limitPrice = (currentBidOrAskPrice * 100 + dynamicOffset) / 100;
    }

    // Ensure limit price does not cross the market
    try {
      const lastQuote = await alpaca.getLatestQuote(symbol);
      if (side === 'sell' && limitPrice < lastQuote.bidPrice) {
        limitPrice = lastQuote.bidPrice;
      } else if (side === 'buy' && limitPrice > lastQuote.askPrice) {
        limitPrice = lastQuote.askPrice;
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

  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const pos = this.positions[symbol];
    if (!pos || !pos.isActive) {
      return;
    }

    const side = pos.side;
    const entryPrice = pos.avgEntryPrice;
    const currentPrice = side === 'buy' ? askPrice : bidPrice;

    pos.currentPrice = currentPrice; // Update current price for P&L calculations

    const profitCents =
      side === 'buy'
        ? ((currentPrice - entryPrice) * 100).toFixed(2)
        : ((entryPrice - currentPrice) * 100).toFixed(2);

    const profitTargets = config.profitTargets;

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

      // Calculate order qty based on proportion
      let qtyToClose = Math.floor(pos.initialQty * target.proportion);

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
        currentPrice,
        side === 'buy' ? 'sell' : 'buy'
      );

      // Wait for orders to process
      await this.sleep(this.apiCallDelay);

      // Update position quantity
      pos.qty -= qtyToClose;
      pos.profitTargetsHit += 1;

      // Reset breakeven stop flag
      pos.hasBreakevenStop = false;

      if (pos.qty <= 0) {
        pos.isActive = false;
        logger.info(`Position in ${symbol} fully closed.`);
        this.dashboard.log(`Position in ${symbol} fully closed.`);
        this.polygon.unsubscribe(symbol);
      } else {
        logger.info(
          `Position in ${symbol} partially closed. Remaining qty: ${pos.qty}`
        );
        this.dashboard.log(
          `Position in ${symbol} partially closed. Remaining qty: ${pos.qty}`
        );
        // Place breakeven stop after profit is taken
        await this.placeBreakevenStop(symbol);
      }

      // Update the dashboard with the latest positions
      this.dashboard.updatePositions(Object.values(this.positions));

      pos.isProcessing = false; // Reset processing flag
    }
  }

  // Periodically check for missing breakeven stops
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

  // Polling for order statuses
  async pollOrderStatuses() {
    try {
      // Fetch all open orders
      const openOrders = await alpaca.getOrders({
        status: 'open',
      });

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
                const sideMultiplier = trackedOrder.side === 'buy' ? 1 : -1;
                pos.qty -= filledQty;
                pos.currentPrice = pos.currentPrice; // Current price already updated via quotes

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
}

module.exports = OrderManager;
