const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.File({
      filename: 'trading-exit-system-error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'trading-exit-system-combined.log',
    }),
  ],
});

module.exports = logger;
