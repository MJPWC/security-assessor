
// Minimal dependency-free logger wrapper using console
const LEVELS = ['debug', 'info', 'warn', 'error'];
const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const levelIdx = Math.max(LEVELS.indexOf(envLevel), 1); // default to 'info'

function ts() {
  try { return new Date().toISOString(); } catch { return '';
  }
}

function fmt(level, msg, obj) {
  const prefix = `[${ts()}] [${level.toUpperCase()}]`;
  if (obj && typeof obj === 'object') {
    return [prefix, msg, obj];
  }
  return [prefix, msg];
}

const baseLogger = {
  debug: (obj, msg) => { if (levelIdx <= 0) console.debug(...fmt('debug', msg || '', obj)); },
  info:  (obj, msg) => { if (levelIdx <= 1) console.log(...fmt('info', msg || '', obj)); },
  warn:  (obj, msg) => { if (levelIdx <= 2) console.warn(...fmt('warn', msg || '', obj)); },
  error: (obj, msg) => { if (levelIdx <= 3) console.error(...fmt('error', msg || '', obj)); },
  child: () => baseLogger,
};

// Factory to create a module-scoped logger (kept for API compatibility)
export const createModuleLogger = (moduleName) => baseLogger;

export const createPerformanceLogger = (operation) => {
  const start = Date.now();
  return {
    start: () => {
      baseLogger.debug({ operation, event: 'start' }, `Starting ${operation}`);
      return start;
    },
    end: (details = {}) => {
      const duration = Date.now() - start;
      baseLogger.info({ operation, event: 'complete', duration: `${duration}ms`, ...details }, `Completed ${operation} in ${duration}ms`);
      return duration;
    },
    error: (error, details = {}) => {
      const duration = Date.now() - start;
      baseLogger.error({ operation, event: 'error', duration: `${duration}ms`, error: error?.message, stack: error?.stack, ...details }, `Failed ${operation} after ${duration}ms: ${error?.message}`);
      return duration;
    }
  };
};

export const logApiCall = (apiName, method, url, status, duration, details = {}) => {
  baseLogger.info({ api: apiName, method, url, status, duration: `${duration}ms`, ...details }, `API ${method} ${url} - ${status} (${duration}ms)`);
};

export const logUserInteraction = (sessionId, action, details = {}) => {
  baseLogger.info({ sessionId, action, timestamp: new Date().toISOString(), ...details }, `User ${action} - Session: ${sessionId}`);
};

export const logError = (context, error, additionalInfo = {}) => {
  baseLogger.error({ context, error: error?.message, stack: error?.stack, ...additionalInfo }, `Error in ${context}: ${error?.message}`);
};

const logger = baseLogger;
export default logger;
