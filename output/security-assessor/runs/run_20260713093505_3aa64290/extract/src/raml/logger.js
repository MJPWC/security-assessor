const logger = {
  info: (...args) => console.log('[raml]', ...args),
  debug: (...args) => console.debug('[raml]', ...args),
  warn: (...args) => console.warn('[raml]', ...args),
  error: (...args) => console.error('[raml]', ...args)
};

export default logger;
