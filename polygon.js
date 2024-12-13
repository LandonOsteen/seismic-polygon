const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

class PolygonClient {
  constructor() {
    this.apiKey = config.polygon.apiKey;
    this.ws = null;
    this.subscribedSymbols = new Set();
    this.subscribedTradeSymbols = new Set();
    this.onQuote = null;
    this.onTrade = null;
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
            if (this.subscribedSymbols.size > 0) {
              const symbols = Array.from(this.subscribedSymbols)
                .map((sym) => `Q.${sym}`)
                .join(',');
              this.ws.send(
                JSON.stringify({ action: 'subscribe', params: symbols })
              );
            }
            if (this.subscribedTradeSymbols.size > 0) {
              const tradeSymbols = Array.from(this.subscribedTradeSymbols)
                .map((sym) => `T.${sym}`)
                .join(',');
              this.ws.send(
                JSON.stringify({ action: 'subscribe', params: tradeSymbols })
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
          const askPrice = parseFloat(msg.P);
          const bidPrice = parseFloat(msg.p);
          this.onQuote(symbol, bidPrice, askPrice);
        } else if (msg.ev === 'T' && this.onTrade) {
          const symbol = msg.sym;
          const price = parseFloat(msg.p);
          this.onTrade(symbol, price);
        }
      });
    });

    this.ws.on('error', (err) => {
      logger.error(`Polygon WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`Polygon WebSocket closed. Code: ${code}, Reason: ${reason}`);
      setTimeout(() => this.connect(), 10000);
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

  subscribeTrades(symbol) {
    if (!this.subscribedTradeSymbols.has(symbol)) {
      this.subscribedTradeSymbols.add(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `T.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} trades.`);
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
    if (this.subscribedTradeSymbols.has(symbol)) {
      this.subscribedTradeSymbols.delete(symbol);
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
