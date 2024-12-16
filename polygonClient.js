const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

class PolygonClient {
  constructor() {
    this.apiKey = config.polygon.apiKey;
    this.ws = null;
    this.subscribedSymbols = new Set();
    this.onTrade = null;
    this.onQuote = null;
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
                .map((sym) => `T.${sym},Q.${sym}`)
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
        } else if (msg.ev === 'T' && this.onTrade) {
          const symbol = msg.sym;
          const price = parseFloat(msg.p);
          const size = parseInt(msg.s);
          const timestamp = msg.t;
          this.onTrade(symbol, price, size, timestamp);
        } else if (msg.ev === 'Q' && this.onQuote) {
          const symbol = msg.sym;
          const bidPrice = parseFloat(msg.bp);
          const askPrice = parseFloat(msg.ap);
          this.onQuote(symbol, bidPrice, askPrice);
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

  subscribeQuote(symbol) {
    if (!this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.add(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `Q.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} quote data.`);
      }
    }
  }

  unsubscribeQuote(symbol) {
    if (this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.delete(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'unsubscribe', params: `Q.${symbol}` })
        );
        logger.info(`Unsubscribed from ${symbol} quote data.`);
      }
    }
  }

  subscribeTrade(symbol) {
    if (!this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.add(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `T.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} trade data.`);
      }
    } else {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'subscribe', params: `T.${symbol}` })
        );
        logger.info(`Subscribed to ${symbol} trade data.`);
      }
    }
  }

  unsubscribeTrade(symbol) {
    if (this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.delete(symbol);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ action: 'unsubscribe', params: `T.${symbol}` })
        );
        logger.info(`Unsubscribed from ${symbol} trade data.`);
      }
    }
  }
}

module.exports = PolygonClient;
