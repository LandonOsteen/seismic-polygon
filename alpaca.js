const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('./config');

const alpaca = new Alpaca({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  paper: config.alpaca.paper,
});

module.exports = { alpaca };
