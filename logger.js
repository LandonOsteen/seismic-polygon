const { createLogger, format, transports } = require('winston');
const config = require('./config');

const logger = createLogger({
  level: config.logging.level,
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    // All logs at 'info' and below go to trading-exit-system-combined.log
    new transports.File({
      filename: 'trading-exit-system-combined.log',
      level: 'info',
    }),
    // All errors go to trading-exit-system-error.log as well
    new transports.File({
      filename: 'trading-exit-system-error.log',
      level: 'error',
    }),
  ],
});

module.exports = logger;
