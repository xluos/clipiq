function finiteTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeTranscriptSegments(rawSegments, normalizeText = (value) =>
  String(value || "").trim()) {
  if (!Array.isArray(rawSegments)) return [];
  return rawSegments
    .map((segment) => {
      const start = finiteTimestamp(segment?.start);
      const end = finiteTimestamp(segment?.end);
      const text = normalizeText(segment?.text);
      if (start == null || end == null || end <= start || !text) return null;
      const words = (Array.isArray(segment?.words) ? segment.words : [])
        .map((word) => {
          const wordStart = finiteTimestamp(word?.start);
          const wordEnd = finiteTimestamp(word?.end);
          const wordText = normalizeText(word?.word ?? word?.text);
          if (
            wordStart == null
            || wordEnd == null
            || wordEnd <= wordStart
            || !wordText
            || wordText.includes("\uFFFD")
          ) {
            return null;
          }
          return {
            text: wordText,
            start: wordStart,
            end: wordEnd,
            ...(Number.isFinite(Number(word?.probability))
              ? { confidence: Number(word.probability) }
              : {}),
          };
        })
        .filter(Boolean);
      return {
        start,
        end,
        text,
        ...(words.length ? { words } : {}),
      };
    })
    .filter(Boolean);
}

module.exports = {
  finiteTimestamp,
  normalizeTranscriptSegments,
};
