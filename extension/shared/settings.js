export const DEFAULT_SETTINGS = Object.freeze({ volume: 0.8, strength: 0.75, spread: 1 });

/** @returns {number} */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @returns {{volume: number, strength: number, spread: number}} */
export function sanitizeSettings(value = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(settings)) {
    const candidate = value?.[key];
    if (Number.isFinite(candidate)) settings[key] = clamp(candidate, 0, 1);
  }
  return settings;
}

/** @returns {number[]} */
export function panPositions(count, spread) {
  const width = clamp(Number.isFinite(spread) ? spread : DEFAULT_SETTINGS.spread, 0, 1);
  return Array.from({ length: count }, (_, index) => count < 2 ? 0 : -width + 2 * width * index / (count - 1));
}
