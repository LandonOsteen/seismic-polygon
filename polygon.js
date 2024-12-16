const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

class PolygonClient {
  constructor() {
    this.apiKey = config.polygon.apiKey;
    this.ws = null;
    this.subscribedSymbolsQuotes = new Set();
    this.subscribedSymbolsTrades = new Set();
    this.onQuote = null; // callback for quotes
    this.onTrade = null; // callback for trades
  }

  connect() {
    this.ws = new WebSocket(`wss://socket.polygon.io/stocks`);

    this.ws.on('open', () => {
      logger.info('Polygon WebSocket connection opened.');
      this.ws.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
    });

    this.ws.on('message', (data) => {
      let messages;
      try {
        messages = JSON.parse(data);
      } catch (err) {
        logger.error(`Error parsing Polygon message: ${err.message}`);
        return;
      }

      messages.forEach((msg) => {
        if (msg.ev === 'status') {
          if (msg.status === 'auth_success') {
            logger.info('Polygon WebSocket authenticated.');
            // Resubscribe to any symbols after reconnecting
            this.resubscribe();
          } else if (msg.status === 'auth_failed') {
            logger.error('Polygon WebSocket authentication failed.');
            this.ws.close();
          } else if (msg.status === 'connected') {
            logger.info('Polygon WebSocket connected.');
          }
        } else if (msg.ev === 'Q' && this.onQuote) {
          const symbol = msg.sym;
          const bidPrice = parseFloat(msg.bp);
          const askPrice = parseFloat(msg.ap);
          this.onQuote(symbol, bidPrice, askPrice);
        } else if (msg.ev === 'T' && this.onTrade) {
          const symbol = msg.sym;
          const tradePrice = parseFloat(msg.p);
          this.onTrade(symbol, tradePrice);
        }
      });
    });

    this.ws.on('error', (err) => {
      logger.error(`Polygon WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`Polygon WebSocket closed. Code: ${code}, Reason: ${reason}`);
      setTimeout(() => this.connect(), 10000); // Reconnect after 10 seconds
    });
  }

  resubscribe() {
    if (this.subscribedSymbolsQuotes.size > 0) {
      const symbols = Array.from(this.subscribedSymbolsQuotes)
        .map((sym) => `Q.${sym}`)
        .join(',');
      this.ws.send(JSON.stringify({ action: 'subscribe', params: symbols }));
      logger.info(`Resubscribed to quotes: ${symbols}`);
    }

    if (this.subscribedSymbolsTrades.size > 0) {
      const symbols = Array.from(this.subscribedSymbolsTrades)
        .map((sym) => `T.${sym}`)
        .join(',');
      this.ws.send(JSON.stringify({ action: 'subscribe', params: symbols }));
      logger.info(`Resubscribed to trades: ${symbols}`);
    }
  }

  subscribeQuotes(symbol) {
    if (!this.subscribedSymbolsQuotes.has(symbol)) {
      this.subscribedSymbolsQuotes.add(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `Q.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} quotes.`);
      }
    }
  }

  unsubscribeQuotes(symbol) {
    if (this.subscribedSymbolsQuotes.has(symbol)) {
      this.subscribedSymbolsQuotes.delete(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'unsubscribe', params: `Q.${symbol}` })
        );
        logger.info(`Unsubscribed from ${symbol} quotes.`);
      }
    }
  }

  subscribeTrades(symbol) {
    if (!this.subscribedSymbolsTrades.has(symbol)) {
      this.subscribedSymbolsTrades.add(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `T.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} trades.`);
      }
    }
  }

  unsubscribeTrades(symbol) {
    if (this.subscribedSymbolsTrades.has(symbol)) {
      this.subscribedSymbolsTrades.delete(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'unsubscribe', params: `T.${symbol}` })
        );
        logger.info(`Unsubscribed from ${symbol} trades.`);
      }
    }
  }
}

module.exports = PolygonClient;
