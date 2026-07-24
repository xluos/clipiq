import { describe, expect, it } from "vitest";
import {
  prepareSFaceRgbaInput,
  SFACE_REFERENCE_LANDMARKS,
} from "../electron/identity/sface-embedder";

describe("SFace 五点对齐", () => {
  it("模板关键点重合时保持 112x112 图像和 RGB NCHW 通道", () => {
    const width = 112;
    const height = 112;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        rgba[offset] = x;
        rgba[offset + 1] = y;
        rgba[offset + 2] = (x + y) % 256;
        rgba[offset + 3] = 255;
      }
    }

    const prepared = prepareSFaceRgbaInput(
      rgba,
      width,
      height,
      SFACE_REFERENCE_LANDMARKS.map((point) => ({ ...point })),
    );
    const planeSize = width * height;
    const sample = 40 * width + 30;

    expect(prepared.width).toBe(112);
    expect(prepared.height).toBe(112);
    expect(prepared.data[sample]).toBeCloseTo(30, 3);
    expect(prepared.data[planeSize + sample]).toBeCloseTo(40, 3);
    expect(prepared.data[planeSize * 2 + sample]).toBeCloseTo(70, 3);
  });

  it("拒绝退化或数量不对的关键点", () => {
    const rgba = new Uint8Array(112 * 112 * 4);
    expect(() => prepareSFaceRgbaInput(
      rgba,
      112,
      112,
      Array.from({ length: 5 }, () => ({ x: 1, y: 1 })),
    )).toThrow("退化");
    expect(() => prepareSFaceRgbaInput(
      rgba,
      112,
      112,
      [{ x: 1, y: 1 }],
    )).toThrow("五个");
  });
});
