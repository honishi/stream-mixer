// Keep some original audio at lower strengths when RNNoise misclassifies speech.
export const NOISE_LEVELS = Object.freeze({ low: 0.25, medium: 0.5, high: 1 });
export const DEFAULT_NOISE_LEVEL = 'medium';
