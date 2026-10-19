/**
 * 把生成图补成 3:4，不裁切。
 *
 * 生图接口给的是 2:3 竖图（1024×1536），以前居中裁成 3:4 会切掉上下各约 85 像素——
 * 封面标题就放在上半部分，最容易被切掉一截。现在改成在短的那一边补边：
 * 补边颜色取原图贴边几列（行）的平均色，再沿边缘方向做一次平滑，避免出现条纹。
 *
 * 纯函数、只按 4 字节一个像素处理，不关心通道顺序（BGRA / RGBA 都一样），方便单测。
 */

export type Bitmap = { data: Buffer; width: number; height: number };

/** 小红书图文与封面的标准输出尺寸：3:4，和本地卡片模板保持一致。 */
export const XHS_COVER_SIZE = { width: 1080, height: 1440 } as const;

const EDGE_SAMPLE = 6;
const SMOOTH_RADIUS = 12;

/** 目标尺寸：短的那一边补到 3:4，另一边不动。已经是 3:4（误差 1 像素内）时原样返回。 */
export function threeFourSize(width: number, height: number): { width: number; height: number } {
  const wantedWidth = Math.round(height * 3 / 4);
  if (Math.abs(wantedWidth - width) <= 1) return { width, height };
  return wantedWidth > width ? { width: wantedWidth, height } : { width, height: Math.round(width * 4 / 3) };
}

export function padToThreeFour(source: Bitmap): Bitmap {
  const { width, height, data } = source;
  const target = threeFourSize(width, height);
  if (target.width === width && target.height === height) return source;
  const out = Buffer.alloc(target.width * target.height * 4);
  const offsetX = Math.floor((target.width - width) / 2);
  const offsetY = Math.floor((target.height - height) / 2);
  const pixel = (x: number, y: number) => (y * width + x) * 4;

  if (target.width > width) {
    // 左右补边：每一行取左 / 右贴边几列的平均色，再上下平滑。
    const left = smooth(Array.from({ length: height }, (_, y) => average(data, Array.from({ length: Math.min(EDGE_SAMPLE, width) }, (_, x) => pixel(x, y)))));
    const right = smooth(Array.from({ length: height }, (_, y) => average(data, Array.from({ length: Math.min(EDGE_SAMPLE, width) }, (_, x) => pixel(width - 1 - x, y)))));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < target.width; x += 1) {
        const at = (y * target.width + x) * 4;
        const inner = x - offsetX;
        if (inner >= 0 && inner < width) data.copy(out, at, pixel(inner, y), pixel(inner, y) + 4);
        else write(out, at, inner < 0 ? left[y] : right[y]);
      }
    }
  } else {
    // 上下补边：每一列取上 / 下贴边几行的平均色，再左右平滑。
    const top = smooth(Array.from({ length: width }, (_, x) => average(data, Array.from({ length: Math.min(EDGE_SAMPLE, height) }, (_, y) => pixel(x, y)))));
    const bottom = smooth(Array.from({ length: width }, (_, x) => average(data, Array.from({ length: Math.min(EDGE_SAMPLE, height) }, (_, y) => pixel(x, height - 1 - y)))));
    for (let y = 0; y < target.height; y += 1) {
      const inner = y - offsetY;
      if (inner >= 0 && inner < height) {
        data.copy(out, y * target.width * 4, pixel(0, inner), pixel(0, inner) + width * 4);
        continue;
      }
      for (let x = 0; x < width; x += 1) write(out, (y * target.width + x) * 4, inner < 0 ? top[x] : bottom[x]);
    }
  }
  return { data: out, width: target.width, height: target.height };
}

type Color = [number, number, number, number];

function average(data: Buffer, offsets: number[]): Color {
  const sum: Color = [0, 0, 0, 0];
  for (const offset of offsets) for (let channel = 0; channel < 4; channel += 1) sum[channel] += data[offset + channel];
  return sum.map(value => Math.round(value / Math.max(1, offsets.length))) as Color;
}

function smooth(colors: Color[]): Color[] {
  return colors.map((_, index) => {
    const from = Math.max(0, index - SMOOTH_RADIUS);
    const to = Math.min(colors.length - 1, index + SMOOTH_RADIUS);
    const sum: Color = [0, 0, 0, 0];
    for (let position = from; position <= to; position += 1) for (let channel = 0; channel < 4; channel += 1) sum[channel] += colors[position][channel];
    return sum.map(value => Math.round(value / (to - from + 1))) as Color;
  });
}

function write(out: Buffer, at: number, color: Color): void {
  out[at] = color[0]; out[at + 1] = color[1]; out[at + 2] = color[2]; out[at + 3] = color[3];
}
