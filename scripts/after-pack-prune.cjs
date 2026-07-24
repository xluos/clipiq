const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { Arch } = require("builder-util");
const asar = require("@electron/asar");

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removePath(filePath) {
  if (!(await pathExists(filePath))) return;
  await fs.rm(filePath, { recursive: true, force: true });
  console.log(`[after-pack-prune] removed ${filePath}`);
}

async function gzipAndRemove(filePath) {
  if (!(await pathExists(filePath))) return;
  const gzPath = `${filePath}.gz`;
  await fs.rm(gzPath, { force: true });
  await pipeline(
    fsSync.createReadStream(filePath),
    zlib.createGzip({ level: 9 }),
    fsSync.createWriteStream(gzPath),
  );
  await fs.chmod(gzPath, 0o644);
  await fs.rm(filePath, { force: true });
  console.log(`[after-pack-prune] compressed ${filePath} -> ${gzPath}`);
}

async function findAppPath(appOutDir) {
  const entries = await fs.readdir(appOutDir, { withFileTypes: true });
  const app = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!app) throw new Error(`Cannot find .app in ${appOutDir}`);
  return path.join(appOutDir, app.name);
}

function archName(context) {
  const byEnum = Arch[context.arch];
  if (byEnum) return byEnum;
  const dirName = path.basename(context.appOutDir || "");
  if (dirName.includes("arm64")) return "arm64";
  if (dirName.includes("x64")) return "x64";
  return process.arch;
}

function ffprobeDirsToRemove(arch) {
  const dirs = [
    path.join("node_modules", "ffprobe-static", "bin", "linux"),
    path.join("node_modules", "ffprobe-static", "bin", "win32"),
  ];
  if (arch === "arm64") {
    dirs.push(path.join("node_modules", "ffprobe-static", "bin", "darwin", "x64"));
  } else if (arch === "x64") {
    dirs.push(path.join("node_modules", "ffprobe-static", "bin", "darwin", "arm64"));
  }
  return dirs;
}

async function pruneAsar(resourcesDir, arch) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!(await pathExists(asarPath))) return;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipiq-asar-prune-"));
  const nextAsar = `${asarPath}.next`;
  try {
    await asar.extractAll(asarPath, tmpDir);
    await patchBinaryWrappers(tmpDir, arch);
    for (const rel of ffprobeDirsToRemove(arch)) {
      await removePath(path.join(tmpDir, rel));
    }
    await removePath(path.join(tmpDir, "node_modules", "ffprobe-static", "bin"));
    await removePath(path.join(tmpDir, "node_modules", "@ffmpeg-installer", `darwin-${arch}`, "ffmpeg"));
    await fs.rm(nextAsar, { force: true });
    await asar.createPackage(tmpDir, nextAsar);
    await fs.rename(nextAsar, asarPath);
    asar.uncache(asarPath);
    console.log(`[after-pack-prune] repacked ${asarPath}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(nextAsar, { force: true });
  }
}

async function patchBinaryWrappers(rootDir, arch) {
  const ffprobeIndex = path.join(rootDir, "node_modules", "ffprobe-static", "index.js");
  if (await pathExists(ffprobeIndex)) {
    await fs.writeFile(ffprobeIndex, `\
//
// Patched by ClipIQ packaging: binaries live in app.asar.unpacked.
//
const os = require("os");
const path = require("path");

const platform = os.platform();
const arch = os.arch();
const binary = platform === "win32" ? "ffprobe.exe" : "ffprobe";
const baseDir = __dirname.includes("app.asar")
  ? __dirname.replace("app.asar", "app.asar.unpacked")
  : __dirname;

exports.path = path.join(baseDir, "bin", platform, arch, binary);
`, "utf8");
    console.log(`[after-pack-prune] patched ${ffprobeIndex}`);
  }

  const ffmpegIndex = path.join(rootDir, "node_modules", "@ffmpeg-installer", "ffmpeg", "index.js");
  const ffmpegPackage = path.join(rootDir, "node_modules", "@ffmpeg-installer", `darwin-${arch}`, "package.json");
  if ((await pathExists(ffmpegIndex)) && (await pathExists(ffmpegPackage))) {
    await fs.writeFile(ffmpegIndex, `\
//
// Patched by ClipIQ packaging: binaries live in app.asar.unpacked.
//
const os = require("os");
const path = require("path");

const platform = os.platform() + "-" + os.arch();
const binary = os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg";
const packageDir = path.resolve(__dirname, "..", platform);
const unpackedPackageDir = packageDir.includes("app.asar")
  ? packageDir.replace("app.asar", "app.asar.unpacked")
  : packageDir;
const ffmpegPath = path.join(unpackedPackageDir, binary);
const packageJson = require(path.join(packageDir, "package.json"));

module.exports = {
  path: ffmpegPath,
  version: packageJson.ffmpeg || packageJson.version,
  url: packageJson.homepage,
};
`, "utf8");
    console.log(`[after-pack-prune] patched ${ffmpegIndex}`);
  }
}

async function pruneUnpacked(resourcesDir, arch) {
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  for (const rel of ffprobeDirsToRemove(arch)) {
    await removePath(path.join(unpackedDir, rel));
  }
  await gzipAndRemove(path.join(unpackedDir, "node_modules", "ffprobe-static", "bin", "darwin", arch, "ffprobe"));
  await gzipAndRemove(path.join(unpackedDir, "node_modules", "@ffmpeg-installer", `darwin-${arch}`, "ffmpeg"));
}

async function removeMatching(dir, predicate) {
  if (!(await pathExists(dir))) return;
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries
      .filter(predicate)
      .map((entry) => removePath(path.join(dir, entry))),
  );
}

async function pruneSpider(resourcesDir) {
  const spiderDir = path.join(resourcesDir, "vendor", "DouYin_Spider");
  await removePath(path.join(spiderDir, "author"));
  await removePath(path.join(spiderDir, "dy_live"));
  await removePath(path.join(spiderDir, "outputs"));
  await removePath(path.join(spiderDir, ".env"));
  await removePath(path.join(spiderDir, "Dockerfile"));
  await removePath(path.join(spiderDir, "README.md"));
  await removePath(path.join(spiderDir, "package-lock.json"));

  const nodeModulesDir = path.join(spiderDir, "node_modules");
  if (await pathExists(nodeModulesDir)) {
    const entries = await fs.readdir(nodeModulesDir);
    await Promise.all(
      entries
        .filter((entry) => entry !== "jsrsasign")
        .map((entry) => removePath(path.join(nodeModulesDir, entry))),
    );
  }

  const venvDir = path.join(spiderDir, ".venv");
  const binDir = path.join(venvDir, "bin");
  await removePath(path.join(binDir, "playwright"));

  const libDir = path.join(venvDir, "lib");
  if (!(await pathExists(libDir))) return;
  const pyDirs = (await fs.readdir(libDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("python"))
    .map((entry) => path.join(libDir, entry.name, "site-packages"));

  for (const sitePackages of pyDirs) {
    await removeMatching(sitePackages, (entry) =>
      entry === "playwright" || /^playwright-.*\.dist-info$/.test(entry),
    );
  }
}

async function pruneElectronFramework(appPath) {
  const frameworkDir = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
  );
  const resourcesDir = path.join(frameworkDir, "Resources");
  await removeMatching(resourcesDir, (entry) => {
    if (!entry.endsWith(".lproj")) return false;
    return !/^(en|en_GB|zh_CN|zh_TW)(?:_|\.lproj)/.test(entry);
  });

  const librariesDir = path.join(frameworkDir, "Libraries");
  await removePath(path.join(librariesDir, "libvk_swiftshader.dylib"));
  await removePath(path.join(librariesDir, "vk_swiftshader_icd.json"));
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = await findAppPath(context.appOutDir);
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const arch = archName(context);
  console.log(`[after-pack-prune] pruning ${appPath} arch=${arch}`);
  await pruneAsar(resourcesDir, arch);
  await pruneUnpacked(resourcesDir, arch);
  await pruneSpider(resourcesDir);
  await pruneElectronFramework(appPath);
};
