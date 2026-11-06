// This function is serialized by chrome.scripting; keep it self-contained.
export function captureVideoSnapshot() {
  const candidates = [];
  function collect(root) {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) collect(element.shadowRoot);
      if (element.localName === 'iframe' || element.localName === 'frame') {
        try { if (element.contentDocument) collect(element.contentDocument); } catch { /* Cross-origin frame. */ }
      }
      if (element.localName !== 'video' || element.readyState < 2 || element.mediaKeys
        || !element.videoWidth || !element.videoHeight) continue;
      const rect = element.getBoundingClientRect();
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
      candidates.push({ video: element, playing: !element.paused && !element.ended, area: rect.width * rect.height });
    }
  }
  collect(document);
  candidates.sort((a, b) => Number(b.playing) - Number(a.playing) || b.area - a.area);
  for (const { video } of candidates) {
    try {
      const scale = Math.min(240 / video.videoWidth, 135 / video.videoHeight, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.65);
    } catch { /* A protected or cross-origin video may not allow pixel access. */ }
  }
  return null;
}

export async function getVideoSnapshots(streams) {
  return Promise.all(streams.map(async ({ id }) => {
    try {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: captureVideoSnapshot });
      return { id, image: frame?.result ?? null };
    } catch {
      // Navigation, closing a tab, or an expired activeTab grant is normal.
      return { id, image: null };
    }
  }));
}
