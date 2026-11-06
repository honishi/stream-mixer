import { Normalizer, PeakLimiter, gainToDb } from './dsp.js';

class NormalizeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new Normalizer(sampleRate);
    this.frames = 0;
    this.port.onmessage = ({ data }) => {
      if (typeof data.strength === 'number') this.dsp.strength = Math.min(1, Math.max(0, data.strength));
    };
  }

  process(inputs, outputs) {
    this.dsp.process(inputs[0] ?? [], outputs[0]);
    this.frames += outputs[0][0]?.length ?? 128;
    if (this.frames >= sampleRate / 10) {
      this.port.postMessage({ inputDb: this.dsp.inputDb, correctionDb: this.dsp.gainDb,
        limitingDb: gainToDb(this.dsp.limiter.gain) });
      this.frames = 0;
    }
    return true;
  }
}

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.energy = [0, 0];
    this.peak = [0, 0];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0]?.length ?? 128;
    for (let c = 0; c < output.length; c++) {
      const channel = input[c];
      if (channel) output[c].set(channel);
      for (let i = 0; i < frames; i++) {
        const value = channel?.[i] ?? 0;
        this.energy[c] += value * value;
        this.peak[c] = Math.max(this.peak[c], Math.abs(value));
      }
    }
    this.frames += frames;
    if (this.frames >= sampleRate / 10) {
      this.port.postMessage({ rms: this.energy.map((sum) => gainToDb(Math.sqrt(sum / this.frames))),
        peak: this.peak.map(gainToDb) });
      this.frames = 0;
      this.energy.fill(0);
      this.peak.fill(0);
    }
    return true;
  }
}

class SafetyProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.limiter = new PeakLimiter(sampleRate);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let i = 0; i < (output[0]?.length ?? 128); i++) {
      let peak = 0;
      for (let c = 0; c < output.length; c++) peak = Math.max(peak, Math.abs(input[c]?.[i] ?? 0));
      const gain = this.limiter.next(peak);
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c]?.[i] ?? 0) * gain;
    }
    return true;
  }
}

registerProcessor('stream-normalizer', NormalizeProcessor);
registerProcessor('stream-meter', MeterProcessor);
registerProcessor('stream-safety', SafetyProcessor);
