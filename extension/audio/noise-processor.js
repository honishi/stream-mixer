import { Rnnoise } from '../vendor/rnnoise/runtime.js';
import { NoiseFrames } from './noise-frames.js';

// Share one WASM heap across tabs. Each stereo channel has its own model state.
let runtimePromise;
function loadRuntime(binary) {
  runtimePromise ??= Rnnoise.loadBinary(binary).catch((error) => { runtimePromise = undefined; throw error; });
  return runtimePromise;
}

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.destroyed = false;
    this.suspended = false;
    this.mix = options.processorOptions.mix;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'destroy') {
        this.destroy();
        this.port.postMessage({ type: 'destroyed' });
        this.port.close();
      }
      if (data.type === 'suspend') {
        this.suspended = data.value;
        this.frames?.reset();
      }
      if (data.type === 'mix') this.frames?.setMix(data.value);
    };
    this.initialize(options.processorOptions.wasmBinary).catch((error) => this.fail(error));
  }

  async initialize(binary) {
    if (sampleRate !== 48000) throw new Error('RNNoise requires 48 kHz audio.');
    const runtime = await loadRuntime(binary);
    if (this.destroyed) return;
    if (runtime.frameSize !== 480) throw new Error('Unsupported RNNoise frame size.');
    const states = [];
    try {
      for (let channel = 0; channel < 2; channel++) states.push(runtime.createDenoiseState());
      this.frames = new NoiseFrames(states, runtime.frameSize, this.mix);
    } catch (error) {
      for (const state of states) state.destroy();
      throw error;
    }
    this.port.postMessage({ type: 'ready' });
  }

  fail(error) {
    // A WASM trap or abort may leave this runtime unusable. New nodes must
    // load a fresh instance; existing nodes keep theirs until disposal.
    runtimePromise = undefined;
    this.destroy();
    this.port.postMessage({ type: 'error', error: error?.message ?? 'Noise reduction failed.' });
  }

  destroy() {
    this.destroyed = true;
    this.frames?.destroy();
    this.frames = undefined;
  }

  process(inputs, outputs) {
    if (this.destroyed) return false;
    if (this.suspended) return true;
    try {
      if (this.frames) this.frames.process(inputs[0] ?? [], outputs[0]);
      else for (let c = 0; c < outputs[0].length; c++) {
        if (inputs[0]?.[c]) outputs[0][c].set(inputs[0][c]);
      }
    } catch (error) { this.fail(error); return false; }
    return true;
  }
}

registerProcessor('stream-noise-reduction', NoiseProcessor);
