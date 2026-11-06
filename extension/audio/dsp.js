import { clamp } from '../shared/settings.js';

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (gain) => 20 * Math.log10(Math.max(gain, 1e-6));

// Stereo-linked peak protection. Immediate attenuation, gentle recovery.
// This is a sample-peak limiter, not a true-peak or loudness-standard meter.
export class PeakLimiter {
  constructor(sampleRate, ceilingDb = -1) {
    this.ceiling = dbToGain(ceilingDb);
    this.release = Math.exp(-1 / (sampleRate * 0.12));
    this.gain = 1;
  }

  next(peak) {
    const required = peak > this.ceiling ? this.ceiling / peak : 1;
    this.gain = Math.min(required, this.release * this.gain + (1 - this.release));
    return this.gain;
  }
}

export class Normalizer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.strength = 0.75;
    this.enabled = true;
    this.energy = 0;
    this.initialized = false;
    this.gainDb = 0;
    this.targetDb = 0;
    this.inputDb = -120;
    this.limiter = new PeakLimiter(sampleRate, -4);
    this.up = Math.exp(-1 / (sampleRate * 3));
    this.down = Math.exp(-1 / (sampleRate * 0.35));
    this.disableSmoothing = Math.exp(-1 / (sampleRate * 0.02));
  }

  process(input, output) {
    const frames = output[0]?.length ?? 0;
    let sum = 0;
    for (const channel of input) {
      for (let i = 0; i < frames; i++) sum += channel[i] * channel[i];
    }
    const blockEnergy = sum / Math.max(1, frames * input.length);
    this.inputDb = gainToDb(Math.sqrt(blockEnergy));
    // Do not integrate silence into the reference or amplify a silent pause.
    if (this.inputDb > -50) {
      const smoothing = Math.exp(-frames / (this.sampleRate * 0.7));
      this.energy = this.initialized ? smoothing * this.energy + (1 - smoothing) * blockEnergy : blockEnergy;
      this.initialized = true;
      this.targetDb = clamp(-22 - gainToDb(Math.sqrt(this.energy)), -18, 12);
    }
    // Disabling correction or setting strength to zero must restore unity even during silence.
    const desiredDb = this.enabled ? this.targetDb * this.strength : 0;
    for (let i = 0; i < frames; i++) {
      let coefficient = desiredDb < this.gainDb ? this.down : this.up;
      if (!this.enabled) coefficient = this.disableSmoothing;
      if (this.inputDb > -50 || desiredDb < this.gainDb || this.strength === 0 || !this.enabled) {
        this.gainDb = coefficient * this.gainDb + (1 - coefficient) * desiredDb;
      }
      const gain = dbToGain(this.gainDb);
      let peak = 0;
      for (let c = 0; c < output.length; c++) {
        const value = (input[c]?.[i] ?? 0) * gain;
        output[c][i] = value;
        peak = Math.max(peak, Math.abs(value));
      }
      const limit = this.limiter.next(peak);
      for (const channel of output) channel[i] *= limit;
    }
  }
}
