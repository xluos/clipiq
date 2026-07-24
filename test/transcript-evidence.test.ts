import { describe, expect, it } from "vitest";
import {
  hasUsableWordTimings,
  wordTimingTextCoverage,
} from "../electron/editing/transcript-evidence";

describe("词级字幕证据覆盖", () => {
  it("忽略空格和标点，完整词序列达到逐字能力", () => {
    const segment = {
      startSec: 0,
      endSec: 2,
      text: "Hello, 世界！",
      words: [
        { text: " Hello", startSec: 0, endSec: 0.8 },
        { text: "世界", startSec: 0.8, endSec: 1.8 },
      ],
    };
    expect(wordTimingTextCoverage(segment)).toBe(1);
    expect(hasUsableWordTimings(segment)).toBe(true);
  });

  it("中文损坏或缺词时保留为分段级，不伪装成逐字", () => {
    const segment = {
      startSec: 0,
      endSec: 3.3,
      text: "今天天气很好，我们去公园散步。",
      words: [
        { text: "今天", startSec: 0.06, endSec: 0.49 },
        { text: "天", startSec: 0.61, endSec: 0.86 },
        { text: "气", startSec: 0.87, endSec: 1.16 },
        { text: "很好", startSec: 1.16, endSec: 1.57 },
        { text: "我们", startSec: 1.9, endSec: 2.28 },
        { text: "去", startSec: 2.28, endSec: 2.48 },
        { text: "公", startSec: 2.48, endSec: 2.68 },
        { text: "步", startSec: 3.06, endSec: 3.27 },
      ],
    };
    expect(wordTimingTextCoverage(segment)).toBeLessThan(0.9);
    expect(hasUsableWordTimings(segment)).toBe(false);
  });
});
