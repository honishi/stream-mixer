// RNNoise consumes 480-sample (10 ms at 48 kHz) PCM frames. The Web Audio
// render quantum is smaller. Keep one previous frame for continuous stereo
// output and a deterministic 480-sample buffering delay across any block size.
// RNNoise adds another frame internally. Delay the dry signal by both frames
// before blending, otherwise partial strengths would produce a delayed echo.
export class NoiseFrames {
  constructor(states, frameSize = 480, mix = 1) {
    this.states = states;
    this.frameSize = frameSize;
    this.cursor = 0;
    this.input = states.map(() => new Float32Array(frameSize));
    this.output = states.map(() => new Float32Array(frameSize));
    this.dry = states.map(() => new Float32Array(frameSize * 2));
    this.dryCursor = 0;
    this.mix = mix;
    this.targetMix = mix;
    this.rampRemaining = 0;
  }

  setMix(value) {
    if (!Number.isFinite(value)) return;
    this.targetMix = Math.max(0, Math.min(1, value));
    this.rampRemaining = this.frameSize * 2;
    this.mixStep = (this.targetMix - this.mix) / this.rampRemaining;
  }

  process(input, output) {
    for (let i = 0; i < (output[0]?.length ?? 0); i++) {
      if (this.rampRemaining > 0) {
        this.mix += this.mixStep;
        this.rampRemaining--;
        if (this.rampRemaining === 0) this.mix = this.targetMix;
      }
      for (let c = 0; c < this.states.length; c++) {
        const original = input[c]?.[i] ?? 0;
        const delayed = this.dry[c][this.dryCursor];
        this.dry[c][this.dryCursor] = original;
        if (output[c]) output[c][i] = this.output[c][this.cursor] * this.mix + delayed * (1 - this.mix);
        this.input[c][this.cursor] = original * 32767;
      }
      this.dryCursor = (this.dryCursor + 1) % (this.frameSize * 2);
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
    this.dryCursor = 0;
    this.mix = this.targetMix;
    this.rampRemaining = 0;
    for (const buffer of [...this.input, ...this.output, ...this.dry]) buffer.fill(0);
  }
}
