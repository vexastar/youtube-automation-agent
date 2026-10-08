const winston = require('winston');
const path = require('path');
const chalk = require('chalk');

class Logger {
  constructor(component = 'System') {
    this.component = component;
    this.winston = this.createWinstonLogger();
  }

  createWinstonLogger() {
    const logDir = path.join(__dirname, '..', 'logs');
    
    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { component: this.component },
      transports: [
        // Write all logs to combined.log
        new winston.transports.File({ 
          filename: path.join(logDir, 'combined.log'),
          maxsize: 5242880, // 5MB
          maxFiles: 5,
        }),
        
        // Write error logs to error.log
        new winston.transports.File({ 
          filename: path.join(logDir, 'error.log'), 
          level: 'error',
          maxsize: 5242880, // 5MB
          maxFiles: 3,
        }),
        
        // Write agent-specific logs
        new winston.transports.File({
          filename: path.join(logDir, `${this.component.toLowerCase()}.log`),
          maxsize: 2097152, // 2MB
          maxFiles: 3,
        })
      ]
    });
  }

  _redact(text) {
    try {
      if (typeof text !== 'string') return text;
      const patterns = [
        /sk_[A-Za-z0-9_\-]{8,}/g,            // OpenAI/elevenlabs-like keys
        /act\.[A-Za-z0-9_\-\.]{8,}/g,       // TikTok tokens
        /ya29\.[A-Za-z0-9_\-]{8,}/g,        // Google tokens
        /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, // JWT-ish
        /\b[A-Za-z0-9_\-]{40,}\b/g         // generic long token-like strings
      ];
      const mask = (m) => (m.length > 8 ? m.slice(0, 4) + '...[REDACTED]' : '...[REDACTED]');
      let out = text;
      for (const p of patterns) {
        out = out.replace(p, mask);
      }
      return out;
    } catch (e) {
      return text;
    }
  }

  info(message, ...args) {
    const safeMessage = this._redact(String(message));
    const safeArgs = args.map(a => (typeof a === 'string' ? this._redact(a) : a));
    this.winston.info(safeMessage, ...safeArgs);
    console.log(this.formatConsoleMessage('INFO', safeMessage, chalk.blue));
  }

  success(message, ...args) {
    const safeMessage = this._redact(String(message));
    const safeArgs = args.map(a => (typeof a === 'string' ? this._redact(a) : a));
    this.winston.info(safeMessage, ...safeArgs);
    console.log(this.formatConsoleMessage('SUCCESS', safeMessage, chalk.green));
  }

  warn(message, ...args) {
    const safeMessage = this._redact(String(message));
    const safeArgs = args.map(a => (typeof a === 'string' ? this._redact(a) : a));
    this.winston.warn(safeMessage, ...safeArgs);
    console.log(this.formatConsoleMessage('WARN', safeMessage, chalk.yellow));
  }

  error(message, error = null, ...args) {
    const safeMessage = this._redact(String(message));
    const safeArgs = args.map(a => (typeof a === 'string' ? this._redact(a) : a));
    if (error) {
      const safeError = { message: this._redact(error.message || ''), stack: error.stack };
      this.winston.error(safeMessage, { error: safeError, ...safeArgs });
    } else {
      this.winston.error(safeMessage, ...safeArgs);
    }
    console.log(this.formatConsoleMessage('ERROR', safeMessage, chalk.red));
    if (error && process.env.NODE_ENV !== 'production') {
      try { console.error(chalk.red(error.stack)); } catch (_) {}
    }
  }

  debug(message, ...args) {
    const safeMessage = this._redact(String(message));
    const safeArgs = args.map(a => (typeof a === 'string' ? this._redact(a) : a));
    this.winston.debug(safeMessage, ...safeArgs);
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatConsoleMessage('DEBUG', safeMessage, chalk.gray));
    }
  }

  formatConsoleMessage(level, message, colorFunc) {
    const timestamp = new Date().toLocaleTimeString();
    const componentTag = chalk.cyan(`[${this.component}]`);
    const levelTag = colorFunc(`[${level}]`);
    
    return `${chalk.gray(timestamp)} ${componentTag} ${levelTag} ${message}`;
  }

  // Method to create specialized loggers for different purposes
  static createAgentLogger(agentName) {
    return new Logger(agentName);
  }

  static createSystemLogger() {
    return new Logger('System');
  }

  static createAPILogger() {
    return new Logger('API');
  }

  // Performance logging
  startTimer(label) {
    const startTime = Date.now();
    return {
      end: () => {
        const duration = Date.now() - startTime;
        this.info(`${label} completed in ${duration}ms`);
        return duration;
      }
    };
  }

  // Structured logging for important events
  logEvent(eventType, data = {}) {
    this.winston.info('System Event', {
      eventType,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  // Log content generation pipeline
  logContentPipeline(stage, contentId, status, data = {}) {
    this.winston.info('Content Pipeline', {
      stage,
      contentId,
      status,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  // Log publishing events
  logPublishing(action, videoId, status, data = {}) {
    this.winston.info('Publishing Event', {
      action,
      videoId,
      status,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  // Log analytics events
  logAnalytics(videoId, metrics, insights = []) {
    this.winston.info('Analytics Update', {
      videoId,
      metrics,
      insights,
      timestamp: new Date().toISOString()
    });
  }

  // Log errors with context
  logErrorWithContext(error, context = {}) {
    this.winston.error('System Error', {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      context,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = { Logger };