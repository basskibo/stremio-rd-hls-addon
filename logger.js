import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfiguracija za dnevnu rotaciju
const dailyRotateFileTransport = new DailyRotateFile({
  filename: path.join(__dirname, 'logs', 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '7d', // Zadrži poslednjih 7 dana
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  )
});

// Konfiguracija za error logove (poseban fajl za greške)
const errorRotateFileTransport = new DailyRotateFile({
  filename: path.join(__dirname, 'logs', 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '7d',
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  )
});

// Format za konzolu (čitljiviji)
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

// Kreiraj Winston logger
const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    dailyRotateFileTransport,
    errorRotateFileTransport,
    new winston.transports.Console({
      format: consoleFormat
    })
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(__dirname, 'logs', 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '7d'
    })
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(__dirname, 'logs', 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '7d'
    })
  ]
});

// Wrapper koji zadržava isti API kao prethodni logger
const logger = {
  log: (message, ...args) => {
    if (args.length > 0) {
      winstonLogger.info(message, ...args);
    } else {
      winstonLogger.info(message);
    }
  },
  
  info: (message, ...args) => {
    if (args.length > 0) {
      winstonLogger.info(message, ...args);
    } else {
      winstonLogger.info(message);
    }
  },
  
  warn: (message, ...args) => {
    if (args.length > 0) {
      winstonLogger.warn(message, ...args);
    } else {
      winstonLogger.warn(message);
    }
  },
  
  error: (message, ...args) => {
    if (args.length > 0) {
      winstonLogger.error(message, ...args);
    } else {
      winstonLogger.error(message);
    }
  },
  
  debug: (message, ...args) => {
    if (args.length > 0) {
      winstonLogger.debug(message, ...args);
    } else {
      winstonLogger.debug(message);
    }
  }
};

export default logger;
