const fs = require("fs");
const path = require("path");

let logDir = null;
let logStream = null;
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB → rotate

function init(dir) {
  logDir = dir;
  logStream = null;
}

function ensureStream() {
  if (!logDir) return null;
  if (logStream && !logStream.destroyed) return logStream;
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logPath = path.join(logDir, "app.log");
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > MAX_LOG_BYTES) {
      const bak = logPath + ".1";
      try { fs.unlinkSync(bak); } catch {}
      fs.renameSync(logPath, bak);
    }
  } catch {}
  logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.on("error", () => {});
  return logStream;
}

function fmt(...args) {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
}

function write(level, tag, args) {
  const ts = new Date().toISOString();
  const body = fmt(...args);
  const line = `[${ts}] [${level}]${tag ? ` [${tag}]` : ""} ${body}\n`;
  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  consoleFn(line.trimEnd());
  const s = ensureStream();
  if (s) s.write(line);
}

function info(tag, ...args) { write("INFO", tag, args); }
function warn(tag, ...args) { write("WARN", tag, args); }
function error(tag, ...args) { write("ERROR", tag, args); }

function close() {
  if (logStream && !logStream.destroyed) {
    logStream.end();
    logStream = null;
  }
}

module.exports = { init, info, warn, error, close };
