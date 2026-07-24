import { describe, expect, it } from "vitest";
import type { PersonAppearance } from "../src/types";
import { personAwareCrop } from "../electron/editing/smart-reframe";

function appearance(
  id: string,
  focusBounds?: PersonAppearance["focusBounds"],
): PersonAppearance {
  return {
    id,
    videoId: "video-1",
    trackId: id,
    startSec: 0,
    endSec: 4,
    confidence: 0.9,
    focusBounds,
    source: "face_track",
  };
}

describe("人物感知横竖屏重构图", () => {
  it("横屏转竖屏时围绕人物焦点生成偶数裁切窗口", () => {
    const focusBounds = { x: 0.72, y: 0.2, width: 0.12, height: 0.3 };
    const crop = personAwareCrop({
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvas: { width: 1080, height: 1920, fps: 30 },
      appearances: [appearance("person-a", focusBounds)],
    });

    expect(crop).toEqual({
      x: 1192,
      y: 0,
      width: 606,
      height: 1080,
    });
    expect(crop!.x).toBeLessThanOrEqual(focusBounds.x * 1920);
    expect(crop!.x + crop!.width).toBeGreaterThanOrEqual(
      (focusBounds.x + focusBounds.width) * 1920,
    );
    expect([crop!.x, crop!.y, crop!.width, crop!.height].every(
      (value) => value % 2 === 0,
    )).toBe(true);
  });

  it("竖屏转横屏时围绕人物纵向位置裁切", () => {
    const crop = personAwareCrop({
      sourceWidth: 1080,
      sourceHeight: 1920,
      canvas: { width: 1920, height: 1080, fps: 30 },
      appearances: [appearance("person-a", {
        x: 0.2,
        y: 0.65,
        width: 0.3,
        height: 0.15,
      })],
    });

    expect(crop).toEqual({
      x: 0,
      y: 1088,
      width: 1080,
      height: 606,
    });
  });

  it("多人跨度超出目标窗口时不裁切，保留渲染器留边降级", () => {
    const crop = personAwareCrop({
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvas: { width: 1080, height: 1920, fps: 30 },
      appearances: [
        appearance("left", { x: 0.05, y: 0.2, width: 0.15, height: 0.3 }),
        appearance("right", { x: 0.8, y: 0.2, width: 0.15, height: 0.3 }),
      ],
    });

    expect(crop).toBeUndefined();
  });

  it("没有可靠焦点、尺寸异常或比例接近时不制造裁切", () => {
    expect(personAwareCrop({
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvas: { width: 1080, height: 1920, fps: 30 },
      appearances: [appearance("unknown")],
    })).toBeUndefined();
    expect(personAwareCrop({
      sourceWidth: 0,
      sourceHeight: 1080,
      canvas: { width: 1080, height: 1920, fps: 30 },
      appearances: [appearance("invalid", { x: 0.2, y: 0.2, width: 0.2, height: 0.3 })],
    })).toBeUndefined();
    expect(personAwareCrop({
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvas: { width: 1920, height: 1080, fps: 30 },
      appearances: [appearance("same-ratio", { x: 0.2, y: 0.2, width: 0.2, height: 0.3 })],
    })).toBeUndefined();
  });
});
