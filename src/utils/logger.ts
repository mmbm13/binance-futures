import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
export const logsDir = path.join(process.cwd(), 'logs');
export const combinedLogPath = path.join(logsDir, 'combined.log');
export const errorLogPath = path.join(logsDir, 'error.log');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for log messages
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format (more readable)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'binance-bot' },
  transports: [
    // Write all logs to combined.log
    new winston.transports.File({
      filename: combinedLogPath,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    // Write errors to error.log
    new winston.transports.File({
      filename: errorLogPath,
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    // Console output
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

export default logger;
