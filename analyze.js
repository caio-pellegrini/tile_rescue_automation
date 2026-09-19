const sharp = require('sharp');

const input = process.argv[2];
if (!input) {
  console.error('usage: node analyze.js screenshot.png');
  process.exit(2);
}

async function main() {
  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const roi = { x0: 100, y0: 380, x1: Math.min(width, 980), y1: Math.min(height, 1500) };
  const rw = roi.x1 - roi.x0;
  const rh = roi.y1 - roi.y0;
  const mask = new Uint8Array(rw * rh);

  function pixel(x, y) {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  }

  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const [r, g, b] = pixel(x, y);
      const hi = Math.max(r, g, b);
      const lo = Math.min(r, g, b);
      // Tile faces are either bright/neutral or the yellow sun tile.
      const lightFace = hi > 185 && lo > 125 && hi - lo < 115;
      const yellowFace = r > 165 && g > 105 && b < 175 && r > b * 1.25 && g > b * 1.05;
      if (lightFace || yellowFace) mask[(y - roi.y0) * rw + (x - roi.x0)] = 1;
    }
  }

  const seen = new Uint8Array(mask.length);
  const components = [];
  const queue = new Int32Array(rw * rh);

  for (let sy = 0; sy < rh; sy++) {
    for (let sx = 0; sx < rw; sx++) {
      const start = sy * rw + sx;
      if (!mask[start] || seen[start]) continue;
      let qh = 0, qt = 0, area = 0;
      let minX = sx, maxX = sx, minY = sy, maxY = sy;
      queue[qt++] = start;
      seen[start] = 1;
      while (qh < qt) {
        const idx = queue[qh++];
        const x = idx % rw;
        const y = Math.floor(idx / rw);
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const neighbors = [idx - 1, idx + 1, idx - rw, idx + rw];
        for (const n of neighbors) {
          if (n < 0 || n >= mask.length || seen[n] || !mask[n]) continue;
          const nx = n % rw;
          const ny = Math.floor(n / rw);
          if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
          seen[n] = 1;
          queue[qt++] = n;
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      if (area > 700 && w > 55 && h > 55 && w < 230 && h < 230 && w / h > 0.55 && w / h < 1.8) {
        components.push({
          x: roi.x0 + minX,
          y: roi.y0 + minY,
          w,
          h,
          area,
          cx: Math.round(roi.x0 + (minX + maxX) / 2),
          cy: Math.round(roi.y0 + (minY + maxY) / 2),
        });
      }
    }
  }

  components.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  console.log(JSON.stringify({ input, screen: { width, height }, roi, components }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
