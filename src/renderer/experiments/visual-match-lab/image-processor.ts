export function grayscale(source: ImageData) {
  const out = new ImageData(source.width, source.height);
  for (let i = 0; i < source.data.length; i += 4) {
    const value = Math.round(.299 * source.data[i]! + .587 * source.data[i + 1]! + .114 * source.data[i + 2]!);
    out.data[i] = out.data[i + 1] = out.data[i + 2] = value; out.data[i + 3] = source.data[i + 3]!;
  }
  return out;
}

export function edgeMap(source: ImageData) {
  const gray = grayscale(source), out = new ImageData(source.width, source.height), { width, height } = source;
  const px = (x: number, y: number) => gray.data[(y * width + x) * 4]!;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const gx = -px(x-1,y-1)+px(x+1,y-1)-2*px(x-1,y)+2*px(x+1,y)-px(x-1,y+1)+px(x+1,y+1);
    const gy = -px(x-1,y-1)-2*px(x,y-1)-px(x+1,y-1)+px(x-1,y+1)+2*px(x,y+1)+px(x+1,y+1);
    const value = Math.min(255, Math.round(Math.hypot(gx, gy))), i = (y * width + x) * 4;
    out.data[i] = out.data[i+1] = out.data[i+2] = value; out.data[i+3] = 255;
  }
  return out;
}
