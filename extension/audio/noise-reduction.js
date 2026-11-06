const binaries = new Map();
const modules = new WeakMap();

async function getBinary() {
  const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
  const path = simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm';
  if (!binaries.has(path)) {
    binaries.set(path, fetch(new URL(`../vendor/rnnoise/${path}`, import.meta.url)).then((response) => {
      if (!response.ok) throw new Error('ノイズ抑制データを読み込めませんでした。');
      return response.arrayBuffer();
    }).catch((error) => { binaries.delete(path); throw error; }));
  }
  return binaries.get(path);
}

export function destroyNoiseNode(node) {
  if (!node) return;
  node.disconnect();
  node.onprocessorerror = null;
  // Wait for the worklet to free the channel states before closing its port.
  const timeout = setTimeout(() => node.port.close(), 1000);
  node.port.onmessage = ({ data }) => {
    if (data.type === 'destroyed') { clearTimeout(timeout); node.port.close(); }
  };
  node.port.postMessage({ type: 'destroy' });
}

export async function createNoiseNode(context, onFailure) {
  if (context.sampleRate !== 48000) throw new Error('48 kHz の音声エンジンが必要です。拡張を再読み込みしてください。');
  if (!modules.has(context)) {
    modules.set(context, context.audioWorklet.addModule(new URL('./noise-processor.js', import.meta.url)).catch((error) => {
      modules.delete(context);
      throw error;
    }));
  }
  const [, wasmBinary] = await Promise.all([modules.get(context), getBinary()]);
  const node = new AudioWorkletNode(context, 'stream-noise-reduction', {
    outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { wasmBinary },
  });
  try {
    await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => reject(new Error('ノイズ抑制の準備がタイムアウトしました。')), 5000);
      const fail = (error) => {
        clearTimeout(timeout);
        if (ready) onFailure(error);
        else reject(error);
      };
      node.onprocessorerror = () => fail(new Error('ノイズ抑制の音声処理が停止しました。'));
      node.port.onmessage = ({ data }) => {
        if (data.type === 'ready') { ready = true; clearTimeout(timeout); resolve(); }
        if (data.type === 'error') fail(new Error(data.error));
      };
    });
    return node;
  } catch (error) { destroyNoiseNode(node); throw error; }
}
