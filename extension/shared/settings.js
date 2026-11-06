export const DEFAULT_SETTINGS = Object.freeze({ volume: 0.8, strength: 0.75, spread: 1 });

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function sanitizeSettings(value = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => [
    key,
    typeof value?.[key] === 'number' && Number.isFinite(value[key])
      ? clamp(value[key], 0, 1)
      : fallback,
  ]));
}

export function panPositions(count, spread) {
  const width = clamp(Number.isFinite(spread) ? spread : DEFAULT_SETTINGS.spread, 0, 1);
  return Array.from({ length: count }, (_, index) => count < 2 ? 0 : -width + 2 * width * index / (count - 1));
}
