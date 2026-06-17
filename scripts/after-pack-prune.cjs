const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
    for (const rel of ffprobeDirsToRemove(arch)) {
      await removePath(path.join(tmpDir, rel));
    }
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

async function pruneUnpacked(resourcesDir, arch) {
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  for (const rel of ffprobeDirsToRemove(arch)) {
    await removePath(path.join(unpackedDir, rel));
  }
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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = await findAppPath(context.appOutDir);
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const arch = archName(context);
  console.log(`[after-pack-prune] pruning ${appPath} arch=${arch}`);
  await pruneAsar(resourcesDir, arch);
  await pruneUnpacked(resourcesDir, arch);
  await pruneSpider(resourcesDir);
};
