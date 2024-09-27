// logger.js

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
    }), // Log errors to file
    new winston.transports.File({
      filename: 'trading-exit-system-combined.log',
    }), // Log all to a combined file
    new winston.transports.Console({
      format: winston.format.simple(),
      level: 'info',
    }), // Log info to console
  ],
});

module.exports = logger;
