/**
 * modules/logger.js
 * Logger centralizado con Winston
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) =>
          `${timestamp} [${level}] ${message}`
        )
      ),
    }),
    new transports.File({
      filename: path.join(logDir, 'su900.log'),
      maxsize:  5 * 1024 * 1024,  // 5 MB
      maxFiles: 3,
      tailable: true,
    }),
    new transports.File({
      filename: path.join(logDir, 'errors.log'),
      level:    'error',
      maxsize:  2 * 1024 * 1024,
      maxFiles: 2,
    }),
  ],
});

module.exports = logger;