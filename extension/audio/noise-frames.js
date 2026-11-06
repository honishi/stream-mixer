// RNNoise consumes 480-sample (10 ms at 48 kHz) PCM frames. The Web Audio
// render quantum is smaller. Keep one previous frame for continuous stereo
// output and a deterministic 480-sample buffering delay across any block size.
export class NoiseFrames {
  constructor(states, frameSize = 480) {
    this.states = states;
    this.frameSize = frameSize;
    this.cursor = 0;
    this.input = states.map(() => new Float32Array(frameSize));
    this.output = states.map(() => new Float32Array(frameSize));
  }

  process(input, output) {
    for (let i = 0; i < (output[0]?.length ?? 0); i++) {
      for (let c = 0; c < this.states.length; c++) {
        if (output[c]) output[c][i] = this.output[c][this.cursor];
        this.input[c][this.cursor] = (input[c]?.[i] ?? 0) * 32767;
      }
      this.cursor++;
      if (this.cursor === this.frameSize) {
        for (let c = 0; c < this.states.length; c++) {
          this.states[c].processFrame(this.input[c]);
          for (let j = 0; j < this.frameSize; j++) this.output[c][j] = this.input[c][j] / 32767;
        }
        this.cursor = 0;
      }
    }
  }

  destroy() {
    for (const state of this.states) state.destroy();
    this.states = [];
  }

  reset() {
    this.cursor = 0;
    for (const buffer of [...this.input, ...this.output]) buffer.fill(0);
  }
}
