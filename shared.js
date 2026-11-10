
const DO_LOGGING = true;

export function log(...args) {
  if (DO_LOGGING) console.log(`[SERVER]`, ...args);
}