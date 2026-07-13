const logger = {
  info: (...args) => console.log('[doc]', ...args),
  debug: (...args) => console.debug('[doc]', ...args),
  warn: (...args) => console.warn('[doc]', ...args),
  error: (...args) => console.error('[doc]', ...args)
};
export default logger;
