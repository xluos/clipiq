import type {
  CropSpec,
  EditPlan,
  PersonAppearance,
} from "../../src/types";

type NormalizedBounds = NonNullable<PersonAppearance["focusBounds"]>;

function validBounds(bounds: PersonAppearance["focusBounds"]): bounds is NormalizedBounds {
  return Boolean(
    bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.x >= 0
    && bounds.y >= 0
    && bounds.width > 0
    && bounds.height > 0
    && bounds.x + bounds.width <= 1.000001
    && bounds.y + bounds.height <= 1.000001,
  );
}

function unionBounds(bounds: NormalizedBounds[]): NormalizedBounds | null {
  if (bounds.length === 0) return null;
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function evenFloor(value: number): number {
  const floored = Math.max(2, Math.floor(value));
  return floored % 2 === 0 ? floored : floored - 1;
}

function clampedOffset(center: number, size: number): number {
  return Math.max(0, Math.min(1 - size, center - size / 2));
}

function evenOffset(value: number, maximum: number): number {
  const floored = Math.max(0, Math.min(maximum, Math.floor(value)));
  return floored % 2 === 0 ? floored : floored - 1;
}

/**
 * 只在人脸焦点可以完整容纳时生成裁切。
 *
 * 无焦点、多人跨度超过目标窗口、尺寸异常或源/目标比例接近时返回 undefined，
 * 由代理渲染器继续使用等比缩放 + 留边，避免把人物切掉。
 */
export function personAwareCrop(input: {
  sourceWidth?: number;
  sourceHeight?: number;
  canvas: EditPlan["canvas"];
  appearances: PersonAppearance[];
  marginRatio?: number;
}): CropSpec | undefined {
  const sourceWidth = Number(input.sourceWidth);
  const sourceHeight = Number(input.sourceHeight);
  const targetWidth = Number(input.canvas.width);
  const targetHeight = Number(input.canvas.height);
  if (
    ![sourceWidth, sourceHeight, targetWidth, targetHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return undefined;
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  if (Math.abs(sourceAspect - targetAspect) / sourceAspect < 0.03) return undefined;

  const focus = unionBounds(
    input.appearances
      .map((appearance) => appearance.focusBounds)
      .filter(validBounds),
  );
  if (!focus) return undefined;
  const margin = Math.max(0, Math.min(0.3, input.marginRatio ?? 0.12));

  if (targetAspect < sourceAspect) {
    const cropWidthRatio = targetAspect / sourceAspect;
    const requiredLeft = Math.max(0, focus.x - focus.width * margin);
    const requiredRight = Math.min(1, focus.x + focus.width * (1 + margin));
    if (requiredRight - requiredLeft > cropWidthRatio) return undefined;
    const centerX = focus.x + focus.width / 2;
    const xRatio = clampedOffset(centerX, cropWidthRatio);
    const width = evenFloor(sourceWidth * cropWidthRatio);
    return {
      x: evenOffset(xRatio * sourceWidth, sourceWidth - width),
      y: 0,
      width,
      height: evenFloor(sourceHeight),
    };
  }

  const cropHeightRatio = sourceAspect / targetAspect;
  const requiredTop = Math.max(0, focus.y - focus.height * margin);
  const requiredBottom = Math.min(1, focus.y + focus.height * (1 + margin));
  if (requiredBottom - requiredTop > cropHeightRatio) return undefined;
  const centerY = focus.y + focus.height / 2;
  const yRatio = clampedOffset(centerY, cropHeightRatio);
  const height = evenFloor(sourceHeight * cropHeightRatio);
  return {
    x: 0,
    y: evenOffset(yRatio * sourceHeight, sourceHeight - height),
    width: evenFloor(sourceWidth),
    height,
  };
}
