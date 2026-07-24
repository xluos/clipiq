import { describe, expect, it } from "vitest";
import {
  formatStudioDuration,
  parseStudioDuration,
} from "../src/screens/studio-duration";

describe("Studio 目标时长", () => {
  it("保留 30 到 90 秒短 Vlog 的精确秒数", () => {
    expect(formatStudioDuration(30)).toBe("30 sec");
    expect(formatStudioDuration(60)).toBe("60 sec");
    expect(formatStudioDuration(90)).toBe("90 sec");
    expect(parseStudioDuration("30 sec")).toBe(30);
    expect(parseStudioDuration("60 sec")).toBe(60);
    expect(parseStudioDuration("90 sec")).toBe(90);
  });

  it("分钟选项保持秒级计算", () => {
    expect(formatStudioDuration(180)).toBe("3 min ± 0.5");
    expect(formatStudioDuration(300)).toBe("5 min ± 1");
    expect(parseStudioDuration("3 min ± 0.5")).toBe(180);
    expect(parseStudioDuration("5 min ± 1")).toBe(300);
  });
});
