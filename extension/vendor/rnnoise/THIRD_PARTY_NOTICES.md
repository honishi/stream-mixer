# RNNoise assets

All files are packaged locally. No third-party server is contacted at runtime.

- `@sapphi-red/web-noise-suppressor` **0.4.1**, Copyright (c) sapphi-red, MIT.
  Source: https://github.com/sapphi-red/web-noise-suppressor
  License: `LICENSE.web-noise-suppressor`.
- `@shiguredo/rnnoise-wasm` **2022.2.0**, Copyright 2021-2021 Takeru Ohta
  (Original Author) and Shiguredo Inc., Apache-2.0.
  Source: https://github.com/shiguredo/rnnoise-wasm/tree/2022.2.0
  License: `LICENSE.rnnoise-wasm`.
- RNNoise, Copyright (c) 2021 Shiguredo Inc.; 2017 Mozilla; 2007-2017 Jean-Marc
  Valin; 2005-2017 Xiph.Org Foundation; 2003-2004 Mark Borgerding, BSD-3-Clause.
  Source: https://github.com/shiguredo/rnnoise
  License: `COPYING.rnnoise`.

`runtime.js` is extracted from the source map shipped with web-noise-suppressor
0.4.1. It contains that package's `loadBinary` patch to rnnoise-wasm. We add a
module-local `window = {}` shim, equivalent to web-noise-suppressor's build-time
`window` define, to allow Emscripten to initialize in AudioWorkletGlobalScope.
Trailing whitespace is removed when extracting the runtime.
Japanese API comments are translated into English using
`scripts/rnnoise-comments.patch`; this patch does not change executable code.
Our own worklet and frame adapter provide readiness, failure recovery, stereo
buffering, and disposal; the upstream worklet wrapper is not used.

Both `.wasm` files are copied unchanged from web-noise-suppressor 0.4.1.
`npm run vendor:nr` reproduces the runtime and binary files from the pinned npm
dependency. The license files above are retained separately in this directory.
