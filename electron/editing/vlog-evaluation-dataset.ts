import type { PersonAppearance } from "../../src/types";
import type { IdentityGroundTruthItem } from "./vlog-quality-evaluator";

export type VlogShotRole =
  | "wide"
  | "person"
  | "action"
  | "detail"
  | "reaction";

export type VlogMaterialTrait =
  | "blurry"
  | "shaky"
  | "duplicate"
  | "silent"
  | "noisy"
  | "multi_person"
  | "back_view"
  | "occlusion"
  | "voice_over"
  | "lookalike_negative";

export type VlogIdentityCondition =
  | "outfit_change"
  | "side_face"
  | "lighting_change";

export type VlogIdentityLabel = {
  id: string;
  personKey: string;
  startSec: number;
  endSec: number;
  focusBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  conditions?: VlogIdentityCondition[];
};

export type VlogEvaluationMaterial = {
  key: string;
  file: string;
  durationSec: number;
  orientation: "landscape" | "portrait";
  eventKey?: string;
  shotRoles: VlogShotRole[];
  traits: VlogMaterialTrait[];
  identities: VlogIdentityLabel[];
};

export type VlogEvaluationDatasetManifest = {
  version: 1;
  id: string;
  title?: string;
  materials: VlogEvaluationMaterial[];
};

export type VlogEvaluationMediaProbe = {
  materialKey: string;
  absolutePath: string;
  exists: boolean;
  durationSec?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  error?: string;
};

export type VlogEvaluationDatasetIssue = {
  code: string;
  severity: "warning" | "error";
  message: string;
  materialKey?: string;
};

export type VlogEvaluationDatasetReport = {
  valid: boolean;
  datasetId: string;
  stats: {
    materialCount: number;
    probedMaterialCount: number;
    totalDurationSec: number;
    landscapeCount: number;
    portraitCount: number;
    identityLabelCount: number;
    personCount: number;
    crossVideoPersonCount: number;
  };
  issues: VlogEvaluationDatasetIssue[];
};

export type ValidateVlogEvaluationDatasetOptions = {
  requireFileProbes?: boolean;
};

export type BuildDatasetIdentityGroundTruthInput = {
  manifest: VlogEvaluationDatasetManifest;
  appearances: PersonAppearance[];
  videoIdByMaterialKey: Record<string, string>;
};

export type DatasetIdentityGroundTruthResult = {
  items: IdentityGroundTruthItem[];
  unmappedMaterialKeys: string[];
  unmatchedLabelIds: string[];
};

const REQUIRED_SHOT_ROLES: VlogShotRole[] = [
  "wide",
  "person",
  "action",
  "detail",
  "reaction",
];

const REQUIRED_TRAITS: VlogMaterialTrait[] = [
  "blurry",
  "shaky",
  "duplicate",
  "silent",
  "noisy",
  "multi_person",
  "back_view",
  "occlusion",
  "voice_over",
  "lookalike_negative",
];

const REQUIRED_IDENTITY_CONDITIONS: VlogIdentityCondition[] = [
  "outfit_change",
  "side_face",
  "lighting_change",
];

function finitePositive(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) > 0;
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function isRelativeSafePath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\0")
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).includes("..");
}

function validFocusBounds(
  value: VlogIdentityLabel["focusBounds"] | PersonAppearance["focusBounds"],
): value is NonNullable<VlogIdentityLabel["focusBounds"]> {
  return Boolean(
    value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && finitePositive(value.width)
    && finitePositive(value.height)
    && value.x >= 0
    && value.y >= 0
    && value.x + value.width <= 1.001
    && value.y + value.height <= 1.001,
  );
}

function probedOrientation(
  probe: VlogEvaluationMediaProbe | undefined,
): "landscape" | "portrait" | undefined {
  if (
    !probe
    || !finitePositive(probe.width)
    || !finitePositive(probe.height)
    || probe.width === probe.height
  ) {
    return undefined;
  }
  return probe.width > probe.height ? "landscape" : "portrait";
}

function addIssue(
  issues: VlogEvaluationDatasetIssue[],
  code: string,
  severity: VlogEvaluationDatasetIssue["severity"],
  message: string,
  materialKey?: string,
): void {
  issues.push({
    code,
    severity,
    message,
    ...(materialKey ? { materialKey } : {}),
  });
}

export function validateVlogEvaluationDataset(
  manifest: VlogEvaluationDatasetManifest,
  probes: VlogEvaluationMediaProbe[] = [],
  options: ValidateVlogEvaluationDatasetOptions = {},
): VlogEvaluationDatasetReport {
  const issues: VlogEvaluationDatasetIssue[] = [];
  const materials = Array.isArray(manifest?.materials) ? manifest.materials : [];
  const datasetId = String(manifest?.id || "").trim();
  if (manifest?.version !== 1) {
    addIssue(issues, "VERSION_UNSUPPORTED", "error", "测试集 manifest.version 必须为 1。");
  }
  if (!datasetId) {
    addIssue(issues, "DATASET_ID_MISSING", "error", "测试集缺少稳定 id。");
  }
  if (materials.length < 10 || materials.length > 20) {
    addIssue(
      issues,
      "MATERIAL_COUNT_OUT_OF_RANGE",
      "error",
      `固定测试集需要 10～20 条素材，当前为 ${materials.length} 条。`,
    );
  }

  const probesByKey = new Map(probes.map((probe) => [probe.materialKey, probe]));
  const materialKeys = new Set<string>();
  const traitSet = new Set<string>();
  const personMaterialKeys = new Map<string, Set<string>>();
  const personConditions = new Map<string, Set<string>>();
  const eventRoles = new Map<string, Set<string>>();
  let totalDurationSec = 0;
  let landscapeCount = 0;
  let portraitCount = 0;
  let identityLabelCount = 0;
  let hasChinesePath = false;
  let hasSpacePath = false;
  let probedMaterialCount = 0;

  for (const material of materials) {
    const key = String(material?.key || "").trim();
    const file = String(material?.file || "").trim();
    if (!key) {
      addIssue(issues, "MATERIAL_KEY_MISSING", "error", "素材缺少稳定 key。");
      continue;
    }
    if (materialKeys.has(key)) {
      addIssue(issues, "MATERIAL_KEY_DUPLICATE", "error", `素材 key 重复：${key}。`, key);
    }
    materialKeys.add(key);
    if (!isRelativeSafePath(file)) {
      addIssue(
        issues,
        "MATERIAL_PATH_UNSAFE",
        "error",
        "素材路径必须相对 manifest，且不能包含 ..。",
        key,
      );
    }
    hasChinesePath ||= /[\u3400-\u9fff]/.test(file);
    hasSpacePath ||= /\s/.test(file);

    const probe = probesByKey.get(key);
    if (probe) probedMaterialCount += 1;
    if (options.requireFileProbes && !probe) {
      addIssue(issues, "MEDIA_NOT_PROBED", "error", "素材没有文件探测结果。", key);
    } else if (probe && !probe.exists) {
      addIssue(issues, "MEDIA_FILE_MISSING", "error", "素材文件不存在。", key);
    } else if (probe?.error) {
      addIssue(issues, "MEDIA_PROBE_FAILED", "error", `媒体探测失败：${probe.error}`, key);
    }

    const durationSec = finitePositive(probe?.durationSec)
      ? probe.durationSec
      : finitePositive(material?.durationSec)
        ? material.durationSec
        : 0;
    if (durationSec <= 0) {
      addIssue(issues, "MATERIAL_DURATION_INVALID", "error", "素材时长无效。", key);
    }
    totalDurationSec += durationSec;
    if (
      finitePositive(probe?.durationSec)
      && finitePositive(material?.durationSec)
      && Math.abs(probe.durationSec - material.durationSec) > 1
    ) {
      addIssue(
        issues,
        "MATERIAL_DURATION_DRIFT",
        "warning",
        `声明时长与实测相差 ${Math.abs(probe.durationSec - material.durationSec).toFixed(2)} 秒。`,
        key,
      );
    }

    const actualOrientation = probedOrientation(probe);
    const orientation = actualOrientation || material?.orientation;
    if (orientation === "landscape") landscapeCount += 1;
    else if (orientation === "portrait") portraitCount += 1;
    else {
      addIssue(issues, "MATERIAL_ORIENTATION_INVALID", "error", "素材方向必须为横屏或竖屏。", key);
    }
    if (actualOrientation && material?.orientation !== actualOrientation) {
      addIssue(
        issues,
        "MATERIAL_ORIENTATION_MISMATCH",
        "error",
        `声明方向 ${material?.orientation || "(缺失)"} 与实测 ${actualOrientation} 不一致。`,
        key,
      );
    }

    const roles = uniqueStrings(material?.shotRoles);
    if (roles.length === 0) {
      addIssue(issues, "SHOT_ROLE_MISSING", "error", "素材至少需要一个镜头角色。", key);
    }
    for (const role of roles) {
      if (!REQUIRED_SHOT_ROLES.includes(role as VlogShotRole)) {
        addIssue(issues, "SHOT_ROLE_INVALID", "error", `未知镜头角色：${role}。`, key);
      }
    }
    const eventKey = String(material?.eventKey || "").trim();
    if (eventKey) {
      const roleSet = eventRoles.get(eventKey) || new Set<string>();
      roles.forEach((role) => roleSet.add(role));
      eventRoles.set(eventKey, roleSet);
    }
    const materialTraits = uniqueStrings(material?.traits);
    for (const trait of materialTraits) {
      if (!REQUIRED_TRAITS.includes(trait as VlogMaterialTrait)) {
        addIssue(issues, "MATERIAL_TRAIT_INVALID", "error", `未知素材特征：${trait}。`, key);
      }
      traitSet.add(trait);
    }

    const labelIds = new Set<string>();
    for (const label of Array.isArray(material?.identities) ? material.identities : []) {
      const labelId = String(label?.id || "").trim();
      const personKey = String(label?.personKey || "").trim();
      identityLabelCount += 1;
      if (!labelId || labelIds.has(labelId)) {
        addIssue(
          issues,
          "IDENTITY_LABEL_ID_INVALID",
          "error",
          "同一素材内人物标注 id 缺失或重复。",
          key,
        );
      }
      labelIds.add(labelId);
      if (!personKey) {
        addIssue(issues, "IDENTITY_PERSON_KEY_MISSING", "error", "人物标注缺少 personKey。", key);
        continue;
      }
      if (
        !finitePositive(label?.endSec)
        || !Number.isFinite(label?.startSec)
        || label.startSec < 0
        || label.endSec <= label.startSec
        || (durationSec > 0 && label.endSec > durationSec + 0.001)
      ) {
        addIssue(issues, "IDENTITY_RANGE_INVALID", "error", "人物真值时间范围无效或越过素材。", key);
      }
      if (label?.focusBounds && !validFocusBounds(label.focusBounds)) {
        addIssue(
          issues,
          "IDENTITY_FOCUS_INVALID",
          "error",
          "人物真值区域必须是 0～1 内的有效归一化矩形。",
          key,
        );
      }
      if (
        materialTraits.includes("multi_person")
        && !validFocusBounds(label?.focusBounds)
      ) {
        addIssue(
          issues,
          "IDENTITY_FOCUS_MISSING",
          "error",
          "多人同框素材的人物真值必须提供 focusBounds。",
          key,
        );
      }
      const materialSet = personMaterialKeys.get(personKey) || new Set<string>();
      materialSet.add(key);
      personMaterialKeys.set(personKey, materialSet);
      const conditionSet = personConditions.get(personKey) || new Set<string>();
      for (const condition of uniqueStrings(label?.conditions)) {
        if (!REQUIRED_IDENTITY_CONDITIONS.includes(condition as VlogIdentityCondition)) {
          addIssue(
            issues,
            "IDENTITY_CONDITION_INVALID",
            "error",
            `未知人物条件：${condition}。`,
            key,
          );
        }
        conditionSet.add(condition);
      }
      personConditions.set(personKey, conditionSet);
    }
  }

  if (totalDurationSec < 600 || totalDurationSec > 1_800) {
    addIssue(
      issues,
      "TOTAL_DURATION_OUT_OF_RANGE",
      "error",
      `素材总时长需要 10～30 分钟，当前为 ${(totalDurationSec / 60).toFixed(1)} 分钟。`,
    );
  }
  if (landscapeCount === 0 || portraitCount === 0) {
    addIssue(issues, "ORIENTATION_MIX_MISSING", "error", "固定集必须同时包含横屏和竖屏素材。");
  }
  if (!hasChinesePath) {
    addIssue(issues, "CHINESE_PATH_MISSING", "error", "固定集必须包含中文路径。");
  }
  if (!hasSpacePath) {
    addIssue(issues, "SPACE_PATH_MISSING", "error", "固定集必须包含带空格路径。");
  }
  for (const trait of REQUIRED_TRAITS) {
    if (!traitSet.has(trait)) {
      addIssue(issues, "REQUIRED_TRAIT_MISSING", "error", `固定集缺少负样本特征：${trait}。`);
    }
  }
  const hasCompleteEvent = [...eventRoles.values()].some((roles) =>
    REQUIRED_SHOT_ROLES.every((role) => roles.has(role)));
  if (!hasCompleteEvent) {
    addIssue(
      issues,
      "EVENT_ROLE_COVERAGE_MISSING",
      "error",
      "至少一个 eventKey 必须覆盖全景、人物、动作、细节和反应镜头。",
    );
  }
  const crossVideoPeople = [...personMaterialKeys.entries()]
    .filter(([, keys]) => keys.size >= 3);
  if (crossVideoPeople.length === 0) {
    addIssue(
      issues,
      "CROSS_VIDEO_PERSON_MISSING",
      "error",
      "至少一个人物必须出现在 3 条不同素材中。",
    );
  } else {
    const hasRequiredVariations = crossVideoPeople.some(([personKey]) => {
      const conditions = personConditions.get(personKey) || new Set<string>();
      return REQUIRED_IDENTITY_CONDITIONS.every((condition) => conditions.has(condition));
    });
    if (!hasRequiredVariations) {
      addIssue(
        issues,
        "IDENTITY_VARIATION_MISSING",
        "error",
        "跨素材主人物必须覆盖换衣、侧脸和光照变化。",
      );
    }
  }
  if (personMaterialKeys.size < 2) {
    addIssue(issues, "IDENTITY_NEGATIVE_PERSON_MISSING", "error", "固定集至少需要两个不同人物用于误合并负例。");
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    datasetId,
    stats: {
      materialCount: materials.length,
      probedMaterialCount,
      totalDurationSec: Math.round(totalDurationSec * 1_000) / 1_000,
      landscapeCount,
      portraitCount,
      identityLabelCount,
      personCount: personMaterialKeys.size,
      crossVideoPersonCount: crossVideoPeople.length,
    },
    issues,
  };
}

function overlapDuration(
  left: { startSec: number; endSec: number },
  right: { startSec: number; endSec: number },
): number {
  return Math.max(0, Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec));
}

function spatialIou(
  left: NonNullable<VlogIdentityLabel["focusBounds"]>,
  right: NonNullable<PersonAppearance["focusBounds"]>,
): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width)
      - Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height)
      - Math.max(left.y, right.y),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function buildIdentityGroundTruthFromDataset(
  input: BuildDatasetIdentityGroundTruthInput,
): DatasetIdentityGroundTruthResult {
  const appearancesByVideo = new Map<string, PersonAppearance[]>();
  for (const appearance of input.appearances) {
    const values = appearancesByVideo.get(appearance.videoId) || [];
    values.push(appearance);
    appearancesByVideo.set(appearance.videoId, values);
  }
  const items: IdentityGroundTruthItem[] = [];
  const unmappedMaterialKeys: string[] = [];
  const unmatchedLabelIds: string[] = [];

  for (const material of input.manifest.materials) {
    const videoId = input.videoIdByMaterialKey[material.key];
    if (!videoId) {
      unmappedMaterialKeys.push(material.key);
      continue;
    }
    const appearances = appearancesByVideo.get(videoId) || [];
    for (const label of material.identities) {
      const matched = appearances
        .map((appearance) => ({
          appearance,
          overlap: overlapDuration(label, appearance),
          focusIou: validFocusBounds(label.focusBounds)
            && validFocusBounds(appearance.focusBounds)
            ? spatialIou(label.focusBounds, appearance.focusBounds)
            : label.focusBounds
              ? 0
              : 1,
        }))
        .filter((item) => item.overlap > 0 && item.focusIou > 0)
        .sort((left, right) =>
          right.focusIou - left.focusIou
          || right.overlap - left.overlap
          || (right.appearance.identityConfidence ?? 0)
            - (left.appearance.identityConfidence ?? 0)
          || left.appearance.id.localeCompare(right.appearance.id))[0]?.appearance;
      const labelKey = `${material.key}:${label.id}`;
      if (!matched) unmatchedLabelIds.push(labelKey);
      items.push({
        appearanceId: matched?.id || `missing:${labelKey}`,
        videoId,
        expectedPersonKey: label.personKey,
        ...(matched?.personId ? { predictedPersonId: matched.personId } : {}),
      });
    }
  }

  return {
    items,
    unmappedMaterialKeys: [...new Set(unmappedMaterialKeys)].sort(),
    unmatchedLabelIds: [...new Set(unmatchedLabelIds)].sort(),
  };
}
