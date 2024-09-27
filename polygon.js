// polygon.js

const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

class Polygon {
  constructor() {
    this.apiKey = config.polygon.apiKey;
    this.ws = null;
    this.subscribedSymbols = new Set();
    this.onQuote = null; // This should be set by the consumer
  }

  connect() {
    this.ws = new WebSocket(`wss://socket.polygon.io/stocks`);

    this.ws.on('open', () => {
      logger.info('Polygon WebSocket connection opened.');
      this.ws.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
    });

    this.ws.on('message', (data) => {
      const messages = JSON.parse(data);
      messages.forEach((msg) => {
        if (msg.ev === 'status') {
          if (msg.status === 'auth_success') {
            logger.info('Polygon WebSocket authenticated.');
            // Resubscribe to any symbols after reconnecting
            if (this.subscribedSymbols.size > 0) {
              const symbols = Array.from(this.subscribedSymbols)
                .map((sym) => `Q.${sym}`)
                .join(',');
              this.ws.send(
                JSON.stringify({ action: 'subscribe', params: symbols })
              );
            }
          } else if (msg.status === 'auth_failed') {
            logger.error('Polygon WebSocket authentication failed.');
            this.ws.close();
          } else if (msg.status === 'connected') {
            logger.info('Polygon WebSocket connected.');
          }
        } else if (msg.ev === 'Q' && this.onQuote) {
          const symbol = msg.sym;
          const bidPrice = msg.bp;
          const askPrice = msg.ap;
          this.onQuote(symbol, bidPrice, askPrice);
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

  subscribe(symbol) {
    if (!this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.add(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `Q.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} quotes.`);
      }
    }
  }

  unsubscribe(symbol) {
    if (this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.delete(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'unsubscribe', params: `Q.${symbol}` })
        );
        logger.info(`Unsubscribed from ${symbol} quotes.`);
      }
    }
  }
}

module.exports = Polygon;
