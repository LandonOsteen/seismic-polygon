// OrderManager.js

const { alpaca } = require('./alpaca');
const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const Bottleneck = require('bottleneck'); // Rate limiting library
const cron = require('node-cron'); // Scheduler for daily resets
const { Mutex } = require('async-mutex'); // Mutex for concurrency control
const fs = require('fs'); // For state persistence

class OrderManager {
  constructor(dashboard, polygon) {
    this.positions = {}; // symbol => position info
    this.dashboard = dashboard;
    this.polygon = polygon;
    this.orderTracking = {}; // orderId => { symbol, type, qty, side, filledQty, targetNumber }

    // Array to store closed positions for the day
    this.closedPositions = [];

    // Mutex for synchronizing position updates and order placements
    this.mutex = new Mutex();

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

    // Load persisted state if available
    this.loadState();

    // Initialize existing positions
    this.initializeExistingPositions();

    // Periodic tasks
    setInterval(
      () => this.pollOrderStatuses(),
      config.pollingIntervals.orderStatus
    );
    setInterval(
      () => this.refreshPositions(),
      config.pollingIntervals.positionRefresh
    );

    // Schedule a task to clear closed positions at midnight every day
    cron.schedule('0 0 * * *', () => {
      this.clearClosedPositions();
      logger.info('Cleared closed positions for the new day.');
      this.dashboard.log('Cleared closed positions for the new day.');
    });
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
   * Loads the state from a file if available.
   */
  loadState() {
    if (fs.existsSync('orderManagerState.json')) {
      try {
        const state = JSON.parse(
          fs.readFileSync('orderManagerState.json', 'utf8')
        );
        this.positions = state.positions || {};
        this.orderTracking = state.orderTracking || {};
        this.closedPositions = state.closedPositions || [];
        logger.info('Loaded persisted state successfully.');
        this.dashboard.log('Loaded persisted state successfully.');
      } catch (err) {
        logger.error(`Error loading state: ${err.message}`);
        this.dashboard.error(`Error loading state: ${err.message}`);
      }
    } else {
      logger.info('No persisted state found. Starting fresh.');
      this.dashboard.log('No persisted state found. Starting fresh.');
    }
  }

  /**
   * Saves the current state to a file for persistence.
   */
  saveState() {
    const state = {
      positions: this.positions,
      orderTracking: this.orderTracking,
      closedPositions: this.closedPositions,
    };
    try {
      fs.writeFileSync(
        'orderManagerState.json',
        JSON.stringify(state, null, 2)
      );
      logger.info('State persisted successfully.');
    } catch (err) {
      logger.error(`Error saving state: ${err.message}`);
      this.dashboard.error(`Error saving state: ${err.message}`);
    }
  }

  /**
   * Initializes existing positions by fetching them from Alpaca and merging with loaded state.
   */
  async initializeExistingPositions() {
    const release = await this.mutex.acquire();
    try {
      const positionsFromAlpaca = await this.retryOperation(() =>
        this.limitedGetPositions()
      );

      const positionsMap = {};

      // Build a map of positions from Alpaca
      positionsFromAlpaca.forEach((position) => {
        positionsMap[position.symbol] = position;
      });

      // Merge positions loaded from state with positions from Alpaca
      for (const symbol in this.positions) {
        if (positionsMap[symbol]) {
          // Update existing position
          await this.updatePositionFromAlpaca(symbol, positionsMap[symbol]);
        } else {
          // Position no longer exists in Alpaca; remove it
          await this.removePosition(symbol);
        }
      }

      // Add any new positions from Alpaca not in loaded state
      for (const symbol in positionsMap) {
        if (!this.positions[symbol]) {
          await this.addPosition(positionsMap[symbol]);
        }
      }

      // Update the dashboard with the loaded positions
      this.dashboard.updatePositions(Object.values(this.positions));

      // Update summary
      this.updateSummary();

      // Persist state
      this.saveState();
    } catch (err) {
      logger.error(`Error initializing existing positions: ${err.message}`);
      this.dashboard.error(
        `Error initializing existing positions: ${err.message}`
      );
    } finally {
      release();
    }
  }

  /**
   * Updates an existing position with data from Alpaca.
   */
  async updatePositionFromAlpaca(symbol, alpacaPosition) {
    const pos = this.positions[symbol];

    if (pos) {
      const qty = Math.abs(parseFloat(alpacaPosition.qty)); // Ensure qty is positive
      const side = alpacaPosition.side === 'long' ? 'buy' : 'sell';
      const avgEntryPrice = parseFloat(alpacaPosition.avg_entry_price);

      pos.qty = qty;
      pos.side = side;
      pos.avgEntryPrice = avgEntryPrice;
      pos.currentBid = avgEntryPrice;
      pos.currentAsk = avgEntryPrice;
      pos.currentPrice = avgEntryPrice;

      logger.info(
        `Position updated from Alpaca: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
      );
      this.dashboard.log(
        `Position updated from Alpaca: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
      );
    }
  }

  /**
   * Adds a new position to the tracker.
   */
  async addPosition(position) {
    const release = await this.mutex.acquire();
    try {
      const symbol = position.symbol;
      const qty = Math.abs(parseFloat(position.qty)); // Ensure qty is positive
      const side = position.side === 'long' ? 'buy' : 'sell';
      const avgEntryPrice = parseFloat(position.avg_entry_price);

      // Check if position already exists
      if (this.positions[symbol]) {
        logger.warn(
          `Position for ${symbol} already exists. Updating existing position.`
        );
        this.dashboard.log(
          `Position for ${symbol} already exists. Updating existing position.`
        );
      }

      // Initialize or update the position
      this.positions[symbol] = {
        symbol,
        qty,
        initialQty: this.positions[symbol]?.initialQty || qty,
        side,
        avgEntryPrice,
        currentBid: avgEntryPrice,
        currentAsk: avgEntryPrice,
        currentPrice: avgEntryPrice,
        profitTargetsHit: this.positions[symbol]?.profitTargetsHit || 0,
        isActive: true,
        isProcessing: false,
        stopPrice: this.calculateInitialStopPrice(avgEntryPrice, side),
        stopTracking: this.positions[symbol]?.stopTracking || 'Initial', // 'Initial' or 'Breakeven'
        profitTracking: this.positions[symbol]?.profitTracking || 0, // in cents
        profitTargets:
          this.positions[symbol]?.profitTargets ||
          config.orderSettings.profitTargets.map((target, index) => ({
            ...target,
            completed: false,
            sharesClosed: 0,
            label: `${index + 1}${this.getOrdinalSuffix(
              index + 1
            )} Profit Target`,
          })),
      };

      logger.info(
        `Position added/updated: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
      );
      this.dashboard.log(
        `Position added/updated: ${symbol} | Qty: ${qty} | Avg Entry: $${avgEntryPrice}`
      );

      // Subscribe to Polygon quotes for the symbol
      this.polygon.subscribe(symbol);

      // Update dashboard positions
      this.dashboard.updatePositions(Object.values(this.positions));

      // Update summary
      this.updateSummary();

      // Persist state
      this.saveState();
    } catch (err) {
      logger.error(
        `Error adding/updating position ${position.symbol}: ${err.message}`
      );
      this.dashboard.error(
        `Error adding/updating position ${position.symbol}: ${err.message}`
      );
    } finally {
      release();
    }
  }

  /**
   * Removes an existing position from tracking and records its closure.
   */
  async removePosition(symbol) {
    const release = await this.mutex.acquire();
    try {
      if (this.positions[symbol]) {
        const pos = this.positions[symbol];

        // Refresh the position from Alpaca to get the latest quantity
        await this.refreshPosition(symbol);
        const refreshedPos = this.positions[symbol];

        // Confirm position quantity is zero
        if (refreshedPos && refreshedPos.qty > 0) {
          logger.warn(
            `Cannot remove ${symbol}: Position quantity is not zero.`
          );
          this.dashboard.log(
            `Cannot remove ${symbol}: Position quantity is not zero.`
          );
          return;
        }

        // Confirm no open orders exist for the symbol
        const openOrders = await this.retryOperation(() =>
          this.limitedGetOrders({ status: 'open', symbols: [symbol] })
        );

        if (openOrders.length > 0) {
          logger.warn(`Cannot remove ${symbol}: Open orders exist.`);
          this.dashboard.log(`Cannot remove ${symbol}: Open orders exist.`);
          return;
        }

        const entryPrice = pos.avgEntryPrice;
        const exitPrice = pos.currentPrice;
        const side = pos.side;

        // Calculate P&L
        const pnl =
          side === 'buy'
            ? (exitPrice - entryPrice) * pos.initialQty
            : (entryPrice - exitPrice) * pos.initialQty;

        // Create a closed position record
        const closedPosition = {
          symbol,
          side,
          qty: pos.initialQty,
          entryPrice: `$${entryPrice.toFixed(2)}`,
          exitPrice: `$${exitPrice.toFixed(2)}`,
          pnl: `$${pnl.toFixed(2)}`, // Rounded to 2 decimal places
          closedAt: new Date().toISOString(),
        };

        // Store the closed position
        this.closedPositions.push(closedPosition);

        // Log the closed position
        logger.info(`Position closed: ${JSON.stringify(closedPosition)}`);
        this.dashboard.log(
          `Position closed: ${symbol} | P&L: ${closedPosition.pnl}`
        );

        delete this.positions[symbol];
        logger.info(`Position removed: ${symbol}`);
        this.dashboard.log(`Position removed: ${symbol}`);

        // Unsubscribe from Polygon quotes as the position is removed
        this.polygon.unsubscribe(symbol);

        // Update dashboard positions
        this.dashboard.updatePositions(Object.values(this.positions));

        // Update summary
        this.updateSummary();

        // Update closed positions on dashboard
        this.dashboard.updateClosedPositions(this.getClosedPositionsForToday());

        // Persist state
        this.saveState();
      } else {
        logger.warn(`Attempted to remove a non-existent position: ${symbol}`);
        this.dashboard.log(
          `Attempted to remove a non-existent position: ${symbol}`
        );
      }
    } catch (err) {
      logger.error(`Error removing position ${symbol}: ${err.message}`);
      this.dashboard.error(`Error removing position ${symbol}: ${err.message}`);
    } finally {
      release();
    }
  }

  /**
   * Handles quote updates from Polygon and manages profit targets and stop monitoring.
   */
  async onQuoteUpdate(symbol, bidPrice, askPrice) {
    const release = await this.mutex.acquire();
    try {
      const pos = this.positions[symbol];
      if (!pos || !pos.isActive) {
        return;
      }

      const side = pos.side;
      const entryPrice = pos.avgEntryPrice;
      const currentPrice = side === 'buy' ? bidPrice : askPrice;

      // Update position prices
      pos.currentBid = bidPrice;
      pos.currentAsk = askPrice;
      pos.currentPrice = currentPrice;

      // Calculate profit/loss in cents
      const profitCents =
        (currentPrice - entryPrice) * 100 * (side === 'buy' ? 1 : -1);

      // Update profit tracking
      pos.profitTracking = profitCents;

      // Log current profit
      this.dashboard.log(
        `Symbol: ${symbol} | Profit: ${profitCents.toFixed(
          2
        )}¢ | Current Price: $${currentPrice.toFixed(2)}`
      );

      // Check for stop trigger only if stop is not already at Breakeven
      if (pos.stopTracking !== 'Breakeven') {
        if (
          (side === 'buy' && currentPrice <= pos.stopPrice) || // Long position stop loss
          (side === 'sell' && currentPrice >= pos.stopPrice) // Short position stop loss
        ) {
          pos.stopTracking = 'Breakeven';
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

      // Iterate through profit targets
      for (let i = 0; i < pos.profitTargets.length; i++) {
        const target = pos.profitTargets[i];
        if (!target.completed && pos.profitTracking >= target.targetCents) {
          // Double-check position after acquiring mutex
          await this.refreshPosition(symbol);
          const refreshedPos = this.positions[symbol];

          if (!refreshedPos) {
            logger.warn(`Position for ${symbol} no longer exists.`);
            this.dashboard.log(`Position for ${symbol} no longer exists.`);
            return;
          }

          if (refreshedPos.profitTargetsHit >= i + 1) {
            // Already handled
            continue;
          }

          // Calculate order qty based on current position size and target percent
          let qtyToClose = Math.floor(
            refreshedPos.qty * (target.percentToClose / 100)
          );

          // Safety Check: Ensure qtyToClose does not exceed pos.qty
          qtyToClose = Math.min(qtyToClose, refreshedPos.qty);

          if (qtyToClose <= 0) {
            logger.warn(`Quantity to close is zero or negative for ${symbol}.`);
            this.dashboard.log(
              `Quantity to close is zero or negative for ${symbol}.`
            );
            continue;
          }

          // Determine order side opposite to position side
          const orderSide = refreshedPos.side === 'buy' ? 'sell' : 'buy';

          // Mark the target as completed
          target.completed = true;
          target.sharesClosed = qtyToClose;

          // Place IOC order
          await this.placeIOCOrder(
            symbol,
            qtyToClose,
            orderSide,
            i + 1 // Profit target number
          );

          // Increment profit targets hit
          refreshedPos.profitTargetsHit += 1;

          // After the second profit target, ensure stop is at breakeven
          if (
            refreshedPos.profitTargetsHit >= 2 &&
            refreshedPos.stopTracking !== 'Breakeven'
          ) {
            refreshedPos.stopTracking = 'Breakeven';
            refreshedPos.stopPrice = entryPrice; // Adjust stop to breakeven
            this.dashboard.log(
              `Second profit target hit for ${symbol}. Stop tracking set to Breakeven.`
            );
            logger.info(
              `Second profit target hit for ${symbol}. Stop tracking set to Breakeven.`
            );
          }

          // Update summary after processing
          this.updateSummary();

          // Persist state
          this.saveState();
        }
      }
    } catch (err) {
      logger.error(
        `Error processing quote update for ${symbol}: ${err.message}`
      );
      this.dashboard.error(
        `Error processing quote update for ${symbol}: ${err.message}`
      );
    } finally {
      release();
    }
  }

  /**
   * Places an Immediate-Or-Cancel (IOC) order with adjusted limit prices.
   */
  async placeIOCOrder(symbol, qty, side, targetNumber) {
    const release = await this.mutex.acquire();
    try {
      qty = Math.abs(qty);

      const pos = this.positions[symbol];
      if (!pos) {
        logger.error(
          `Attempted to place IOC order for non-existent position: ${symbol}`
        );
        this.dashboard.error(
          `Attempted to place IOC order for non-existent position: ${symbol}`
        );
        return;
      }

      let limitPrice;

      if (side === 'buy') {
        // For closing short positions, buy slightly above the ask price
        limitPrice =
          pos.currentAsk + config.orderSettings.limitOffsetCents / 100;
      } else if (side === 'sell') {
        // For closing long positions, sell slightly below the bid price
        limitPrice =
          pos.currentBid - config.orderSettings.limitOffsetCents / 100;
      } else {
        logger.error(`Invalid side "${side}" for IOC order on ${symbol}.`);
        this.dashboard.error(
          `Invalid side "${side}" for IOC order on ${symbol}.`
        );
        return;
      }

      // Safety Check: Ensure limitPrice is valid
      if (limitPrice <= 0 || isNaN(limitPrice)) {
        logger.error(
          `Invalid limit price for ${symbol}. Cannot place ${side} order.`
        );
        this.dashboard.error(
          `Invalid limit price for ${symbol}. Cannot place ${side} order.`
        );
        return;
      }

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
          targetNumber, // Which profit target triggered this order
        };

        // Immediately refresh positions after placing an order
        await this.refreshPosition(symbol);

        // Persist state
        this.saveState();
      } catch (err) {
        logger.error(`Error placing IOC order for ${symbol}: ${err.message}`);
        this.dashboard.error(
          `Error placing IOC order for ${symbol}: ${err.message}`
        );
      }
    } finally {
      release();
    }
  }

  /**
   * Polls and updates the status of tracked orders.
   */
  async pollOrderStatuses() {
    const release = await this.mutex.acquire();
    try {
      if (this.isPolling) {
        // Prevent overlapping polling cycles
        return;
      }

      this.isPolling = true;

      // Fetch all open orders
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open' })
      );

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

                // Prevent position qty from going negative
                if (pos.qty < 0) {
                  logger.error(
                    `Negative quantity detected for ${trackedOrder.symbol}. Possible over-sell. Correcting to zero.`
                  );
                  this.dashboard.error(
                    `Negative quantity detected for ${trackedOrder.symbol}. Correcting to zero.`
                  );
                  pos.qty = 0;
                }

                // Remove the order from tracking if fully filled
                if (remainingQty <= 0) {
                  delete this.orderTracking[order.id];
                }

                // Update the dashboard
                this.dashboard.updatePositions(Object.values(this.positions));

                // If all qty is closed, remove the position
                if (pos.qty <= 0) {
                  await this.removePosition(trackedOrder.symbol);
                }

                // Persist state
                this.saveState();
              }
              // Handle other order types if necessary
            } else {
              logger.warn(
                `Tracked order ${order.id} has no corresponding position.`
              );
              this.dashboard.log(
                `Tracked order ${order.id} has no corresponding position.`
              );
            }
          }

          // Remove filled or canceled orders from tracking
          if (order.status === 'filled' || order.status === 'canceled') {
            delete this.orderTracking[order.id];

            // Persist state
            this.saveState();
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
      release();
    }
  }

  /**
   * Closes the full position with a market order.
   * This method keeps trying until the position is fully closed.
   */
  async closePositionMarketOrder(symbol) {
    const release = await this.mutex.acquire();
    try {
      const pos = this.positions[symbol];

      if (!pos) {
        logger.warn(`Attempted to close a non-existent position: ${symbol}`);
        this.dashboard.log(
          `Attempted to close a non-existent position: ${symbol}`
        );
        return;
      }

      // Fetch the latest position to ensure accurate qty
      await this.refreshPosition(symbol);
      const refreshedPos = this.positions[symbol];

      if (!refreshedPos) {
        logger.warn(`Position for ${symbol} no longer exists after refresh.`);
        this.dashboard.log(
          `Position for ${symbol} no longer exists after refresh.`
        );
        return;
      }

      // Get pending sell/buy quantity based on position side
      const pendingCloseQty = await this.getPendingCloseQty(symbol);

      // Adjust qty by subtracting pending close orders
      const adjustedQty = refreshedPos.qty - pendingCloseQty;

      if (adjustedQty <= 0) {
        logger.warn(`No shares left to close for ${symbol}.`);
        this.dashboard.log(`No shares left to close for ${symbol}.`);
        return;
      }

      const orderSide = refreshedPos.side === 'buy' ? 'sell' : 'buy';

      const order = {
        symbol,
        qty: adjustedQty.toFixed(0),
        side: orderSide,
        type: 'market',
        time_in_force: 'day',
        client_order_id: this.generateClientOrderId('CLOSE'),
      };

      logger.info(
        `Closing position with market order: ${JSON.stringify(order)}`
      );
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
        await this.refreshPosition(symbol);

        // Continuously check if the position is closed
        this.monitorFinalClosure(symbol);

        // Persist state
        this.saveState();
      } catch (err) {
        logger.error(
          `Error placing market order to close position for ${symbol}: ${err.message}`
        );
        this.dashboard.error(
          `Error placing market order to close position for ${symbol}: ${err.message}`
        );
      }
    } catch (err) {
      logger.error(`Error closing position for ${symbol}: ${err.message}`);
      this.dashboard.error(
        `Error closing position for ${symbol}: ${err.message}`
      );
    } finally {
      release();
    }
  }

  /**
   * Monitors the final closure of a position until it's fully closed.
   */
  async monitorFinalClosure(symbol) {
    const checkInterval = 2000; // 2 seconds
    const maxRetries = 10; // Maximum number of retries
    let attempts = 0;

    const interval = setInterval(async () => {
      attempts += 1;
      try {
        await this.refreshPosition(symbol);
        const pos = this.positions[symbol];
        if (!pos || pos.qty <= 0) {
          clearInterval(interval);
          logger.info(`Final position closed for ${symbol}.`);
          this.dashboard.log(`Final position closed for ${symbol}.`);
        } else {
          logger.warn(
            `Final closure attempt ${attempts} for ${symbol}. Remaining qty: ${pos.qty}`
          );
          this.dashboard.log(
            `Final closure attempt ${attempts} for ${symbol}. Remaining qty: ${pos.qty}`
          );

          // Retry placing a market order to close remaining shares
          await this.closePositionMarketOrder(symbol);

          if (attempts >= maxRetries) {
            clearInterval(interval);
            logger.error(
              `Failed to fully close position for ${symbol} after ${maxRetries} attempts. Manual intervention may be required.`
            );
            this.dashboard.error(
              `Failed to fully close position for ${symbol} after ${maxRetries} attempts. Manual intervention may be required.`
            );
          }
        }
      } catch (err) {
        clearInterval(interval);
        logger.error(
          `Error monitoring final closure for ${symbol}: ${err.message}`
        );
        this.dashboard.error(
          `Error monitoring final closure for ${symbol}: ${err.message}`
        );
      }
    }, checkInterval);
  }

  /**
   * Retrieves the total pending close quantity for a symbol.
   */
  async getPendingCloseQty(symbol) {
    try {
      const openOrders = await this.retryOperation(() =>
        this.limitedGetOrders({ status: 'open', symbols: [symbol] })
      );
      let pendingCloseQty = 0;
      openOrders.forEach((order) => {
        if (order.side === 'sell' && this.positions[symbol].side === 'buy') {
          // Closing a long position
          pendingCloseQty +=
            parseFloat(order.qty) - parseFloat(order.filled_qty);
        } else if (
          order.side === 'buy' &&
          this.positions[symbol].side === 'sell'
        ) {
          // Closing a short position
          pendingCloseQty +=
            parseFloat(order.qty) - parseFloat(order.filled_qty);
        }
      });
      return pendingCloseQty;
    } catch (err) {
      logger.error(`Error fetching pending close quantity: ${err.message}`);
      this.dashboard.error(
        `Error fetching pending close quantity: ${err.message}`
      );
      return 0;
    }
  }

  /**
   * Refreshes a single position from Alpaca and updates internal tracking.
   */
  async refreshPosition(symbol) {
    try {
      const positions = await this.retryOperation(() =>
        this.limitedGetPositions()
      );
      const position = positions.find((pos) => pos.symbol === symbol);

      if (position) {
        const latestQty = Math.abs(parseFloat(position.qty));
        const latestAvgEntryPrice = parseFloat(position.avg_entry_price);
        if (this.positions[symbol]) {
          this.positions[symbol].qty = latestQty;
          this.positions[symbol].avgEntryPrice = latestAvgEntryPrice;
          this.positions[symbol].currentBid =
            parseFloat(position.current_price) - 0.01; // Approximation
          this.positions[symbol].currentAsk =
            parseFloat(position.current_price) + 0.01; // Approximation
          this.positions[symbol].currentPrice = parseFloat(
            position.current_price
          );

          // Recalculate stopPrice if necessary
          if (
            this.positions[symbol].profitTargetsHit >= 2 &&
            this.positions[symbol].stopTracking !== 'Breakeven'
          ) {
            this.positions[symbol].stopPrice = latestAvgEntryPrice; // Breakeven
            this.positions[symbol].stopTracking = 'Breakeven';
          } else if (this.positions[symbol].stopTracking === 'Initial') {
            this.positions[symbol].stopPrice = this.calculateInitialStopPrice(
              latestAvgEntryPrice,
              this.positions[symbol].side
            );
          }

          // Persist state
          this.saveState();
        } else {
          logger.warn(
            `Position for ${symbol} exists in Alpaca but not tracked locally.`
          );
          this.dashboard.log(
            `Position for ${symbol} exists in Alpaca but not tracked locally.`
          );
        }
      } else {
        // Position no longer exists on Alpaca
        if (this.positions[symbol]) {
          this.positions[symbol].qty = 0;
          this.positions[symbol].stopTracking = 'Closed';
        }
      }
    } catch (err) {
      logger.error(`Error refreshing position ${symbol}: ${err.message}`);
      this.dashboard.error(
        `Error refreshing position ${symbol}: ${err.message}`
      );
    }
  }

  /**
   * Refreshes all positions by fetching them from Alpaca and updating internal tracking.
   */
  async refreshPositions() {
    const release = await this.mutex.acquire();
    try {
      if (this.isRefreshing) {
        // Prevent overlapping refresh cycles
        return;
      }

      this.isRefreshing = true;

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

          // Recalculate stopPrice if necessary
          if (
            this.positions[symbol].profitTargetsHit >= 2 &&
            this.positions[symbol].stopTracking !== 'Breakeven'
          ) {
            this.positions[symbol].stopPrice = latestAvgEntryPrice; // Breakeven
            this.positions[symbol].stopTracking = 'Breakeven';
          } else if (this.positions[symbol].stopTracking === 'Initial') {
            this.positions[symbol].stopPrice = this.calculateInitialStopPrice(
              latestAvgEntryPrice,
              this.positions[symbol].side
            );
          }

          // If quantity is zero, remove the position
          if (latestQty === 0) {
            await this.removePosition(symbol);
          }

          // Persist state
          this.saveState();
        } else {
          // Position no longer exists; remove from tracking
          await this.removePosition(symbol);
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
      release();
    }
  }

  /**
   * Retrieves closed positions for the current day.
   */
  getClosedPositionsForToday() {
    const timeZone = config.timeZone || 'UTC';
    const now = new Date().toLocaleString('en-US', { timeZone });
    const currentTime = new Date(now);
    const startOfDay = new Date(
      currentTime.getFullYear(),
      currentTime.getMonth(),
      currentTime.getDate()
    ).toISOString();

    return this.closedPositions.filter((pos) => pos.closedAt >= startOfDay);
  }

  /**
   * Clears closed positions data at the end of the day.
   */
  clearClosedPositions() {
    this.closedPositions = [];
  }

  /**
   * Updates the Summary box with aggregated data.
   */
  updateSummary() {
    const totalPositions = Object.keys(this.positions).length;
    const activePositions = Object.values(this.positions).filter(
      (pos) => pos.isActive
    ).length;
    const closedPositions = this.closedPositions.length;

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

  /**
   * Monitors the final closure of a position until it's fully closed.
   */
  async monitorFinalClosure(symbol) {
    const checkInterval = 2000; // 2 seconds
    const maxRetries = 10; // Maximum number of retries
    let attempts = 0;

    const interval = setInterval(async () => {
      attempts += 1;
      try {
        await this.refreshPosition(symbol);
        const pos = this.positions[symbol];
        if (!pos || pos.qty <= 0) {
          clearInterval(interval);
          logger.info(`Final position closed for ${symbol}.`);
          this.dashboard.log(`Final position closed for ${symbol}.`);
        } else {
          logger.warn(
            `Final closure attempt ${attempts} for ${symbol}. Remaining qty: ${pos.qty}`
          );
          this.dashboard.log(
            `Final closure attempt ${attempts} for ${symbol}. Remaining qty: ${pos.qty}`
          );

          // Retry placing a market order to close remaining shares
          await this.closePositionMarketOrder(symbol);

          if (attempts >= maxRetries) {
            clearInterval(interval);
            logger.error(
              `Failed to fully close position for ${symbol} after ${maxRetries} attempts. Manual intervention may be required.`
            );
            this.dashboard.error(
              `Failed to fully close position for ${symbol} after ${maxRetries} attempts. Manual intervention may be required.`
            );
          }
        }
      } catch (err) {
        clearInterval(interval);
        logger.error(
          `Error monitoring final closure for ${symbol}: ${err.message}`
        );
        this.dashboard.error(
          `Error monitoring final closure for ${symbol}: ${err.message}`
        );
      }
    }, checkInterval);
  }
}

module.exports = OrderManager;
