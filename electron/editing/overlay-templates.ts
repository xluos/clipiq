import type {
  OverlayItem,
  OverlayTemplateDefinition,
  TransformSpec,
  VideoClip,
} from "../../src/types";

export type OverlayTemplate = OverlayTemplateDefinition & {
  defaultTransform: TransformSpec;
  animation: NonNullable<OverlayItem["animation"]>;
  ass: {
    fontSizeRatio?: number;
    alignment: number;
    primaryColor: string;
    outlineColor: string;
    backColor: string;
    borderStyle: 1 | 3;
    outlineRatio: number;
    bold: boolean;
    drawing?: string;
  };
};

export const OVERLAY_TEMPLATE_KEYS = {
  punch: "clipiq.flower.punch.v1",
  note: "clipiq.flower.note.v1",
  spark: "clipiq.sticker.spark.v1",
} as const;

const TEMPLATES: readonly OverlayTemplate[] = [
  {
    key: OVERLAY_TEMPLATE_KEYS.punch,
    version: 1,
    label: "重点花字",
    description: "居中强调一句短文本",
    kind: "text",
    textRequired: true,
    maxTextLength: 18,
    defaultDurationUs: 1_800_000,
    defaultTransform: {
      x: 0.5,
      y: 0.16,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: -2,
      opacity: 1,
    },
    animation: { in: "pop", out: "fade" },
    ass: {
      fontSizeRatio: 0.052,
      alignment: 8,
      primaryColor: "&H00FCFBFB&",
      outlineColor: "&H00E5464F&",
      backColor: "&H00E5464F&",
      borderStyle: 3,
      outlineRatio: 0.009,
      bold: true,
    },
  },
  {
    key: OVERLAY_TEMPLATE_KEYS.note,
    version: 1,
    label: "注释花字",
    description: "左上角补充地点或说明",
    kind: "text",
    textRequired: true,
    maxTextLength: 24,
    defaultDurationUs: 2_400_000,
    defaultTransform: {
      x: 0.08,
      y: 0.1,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 0.96,
    },
    animation: { in: "fade", out: "fade" },
    ass: {
      fontSizeRatio: 0.033,
      alignment: 7,
      primaryColor: "&H000B0A0A&",
      outlineColor: "&H00FFF0EE&",
      backColor: "&H00FFF0EE&",
      borderStyle: 3,
      outlineRatio: 0.007,
      bold: false,
    },
  },
  {
    key: OVERLAY_TEMPLATE_KEYS.spark,
    version: 1,
    label: "闪光贴纸",
    description: "右上角强调动作或反应",
    kind: "sticker",
    textRequired: false,
    defaultDurationUs: 1_200_000,
    defaultTransform: {
      x: 0.82,
      y: 0.18,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 8,
      opacity: 0.92,
    },
    animation: { in: "pop", out: "fade" },
    ass: {
      alignment: 5,
      primaryColor: "&H00E5464F&",
      outlineColor: "&H000B0A0A&",
      backColor: "&H000B0A0A&",
      borderStyle: 1,
      outlineRatio: 0.003,
      bold: false,
      drawing: [
        "m 0 -50",
        "l 12 -20 38 -38 32 -8 54 4 24 20 30 50 0 34",
        "l -24 50 -30 20 -54 8 -32 -8 -38 -38 -12 -20",
      ].join(" "),
    },
  },
] as const;

const TEMPLATE_BY_KEY = new Map(TEMPLATES.map((template) => [
  template.key,
  template,
]));

export function listOverlayTemplates(): OverlayTemplateDefinition[] {
  return TEMPLATES.map((template) => ({
    key: template.key,
    version: template.version,
    label: template.label,
    description: template.description,
    kind: template.kind,
    textRequired: template.textRequired,
    ...(template.maxTextLength != null
      ? { maxTextLength: template.maxTextLength }
      : {}),
    defaultDurationUs: template.defaultDurationUs,
  }));
}

export function getOverlayTemplate(
  key: string | undefined,
): OverlayTemplate | null {
  return key ? TEMPLATE_BY_KEY.get(key) || null : null;
}

function clipDurationUs(clip: VideoClip): number {
  return Math.round((clip.sourceOutUs - clip.sourceInUs) / clip.speed);
}

export function createTemplateOverlay(input: {
  id: string;
  templateKey: string;
  anchorClip: VideoClip;
  text?: string;
}): OverlayItem {
  const template = getOverlayTemplate(input.templateKey);
  if (!template) throw new Error(`视觉模板不存在: ${input.templateKey}`);
  const text = String(input.text || "").trim();
  if (template.textRequired && !text) {
    throw new Error(`「${template.label}」需要填写文本`);
  }
  if (template.maxTextLength != null && text.length > template.maxTextLength) {
    throw new Error(`「${template.label}」最多 ${template.maxTextLength} 个字符`);
  }
  const durationUs = Math.min(
    template.defaultDurationUs,
    clipDurationUs(input.anchorClip),
  );
  if (durationUs < 200_000) throw new Error("镜头太短，不能添加视觉模板");
  return {
    id: input.id,
    kind: template.kind,
    resourceKey: template.key,
    ...(text ? { text } : {}),
    anchorClipId: input.anchorClip.id,
    anchorOffsetUs: 0,
    startUs: input.anchorClip.timelineInUs,
    endUs: input.anchorClip.timelineInUs + durationUs,
    transform: structuredClone(template.defaultTransform),
    animation: structuredClone(template.animation),
  };
}

export function overlayTemplateManifest(
  keys: Iterable<string>,
): OverlayTemplate[] {
  return [...new Set(keys)]
    .flatMap((key) => {
      const template = getOverlayTemplate(key);
      return template ? [structuredClone(template)] : [];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}
