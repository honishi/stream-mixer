import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await mkdir('extension/icons', { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = await page.evaluate((size) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.scale(size / 128, size / 128);
      ctx.fillStyle = '#20271b';
      ctx.beginPath();
      ctx.roundRect(0, 0, 128, 128, 27);
      ctx.fill();
      ctx.fillStyle = '#c1ed8b';
      for (const [x, y, height] of [[29, 44, 40], [57, 24, 80], [85, 34, 60]]) {
        ctx.beginPath();
        ctx.roundRect(x, y, 14, height, 7);
        ctx.fill();
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }, size);
    await writeFile(`extension/icons/icon-${size}.png`, Buffer.from(png, 'base64'));
  }
} finally { await browser.close(); }
