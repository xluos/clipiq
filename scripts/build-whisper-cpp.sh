#!/usr/bin/env bash
# 编译 whisper.cpp 静态二进制 (whisper-cli + whisper-server),
# 产物落到 resources/bin/<platform-arch>/, electron-builder 打包时随 app 分发。
#
# 用法:
#   ./scripts/build-whisper-cpp.sh             # 用默认 tag
#   WHISPER_VERSION=v1.8.4 ./scripts/build-whisper-cpp.sh
#   WHISPER_BUILD_DIR=/path ./scripts/build-whisper-cpp.sh
#
# 依赖: cmake, git, C++ 编译器 (Xcode CLT / build-essential / MSVC)

set -euo pipefail

WHISPER_VERSION="${WHISPER_VERSION:-v1.8.4}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${WHISPER_BUILD_DIR:-/tmp/whisper-cpp-build}"

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"  # darwin / linux
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
esac
PLATFORM_KEY="${PLATFORM}-${ARCH}"
OUT_DIR="$PROJECT_ROOT/resources/bin/$PLATFORM_KEY"

echo "[build-whisper] version=$WHISPER_VERSION"
echo "[build-whisper] platform=$PLATFORM_KEY"
echo "[build-whisper] build_dir=$BUILD_DIR"
echo "[build-whisper] out_dir=$OUT_DIR"

# Tooling check
for tool in cmake git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "缺少依赖: $tool" >&2
    case "$PLATFORM" in
      darwin) echo "  安装: brew install $tool" >&2 ;;
      linux)  echo "  安装: apt install $tool / dnf install $tool" >&2 ;;
    esac
    exit 1
  fi
done

# Clone or checkout
if [ ! -d "$BUILD_DIR/.git" ]; then
  echo "[build-whisper] 克隆 whisper.cpp $WHISPER_VERSION"
  git clone --depth 1 --branch "$WHISPER_VERSION" \
    https://github.com/ggml-org/whisper.cpp.git "$BUILD_DIR"
else
  echo "[build-whisper] 复用已有 build dir, 切换到 $WHISPER_VERSION"
  cd "$BUILD_DIR"
  git fetch --tags --depth 1 origin "$WHISPER_VERSION" 2>/dev/null || true
  git checkout -q "$WHISPER_VERSION"
  cd - >/dev/null
fi

cd "$BUILD_DIR"

# cmake 配置: 静态库 + 平台加速。
# 关键 flag: GGML_METAL_EMBED_LIBRARY=ON 把 Metal shader 嵌进 binary, 避免多文件分发。
CMAKE_ARGS=(
  -B build
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_BUILD_TESTS=OFF
)

if [ "$PLATFORM" = "darwin" ]; then
  CMAKE_ARGS+=(
    -DGGML_METAL=ON
    -DGGML_METAL_EMBED_LIBRARY=ON
    -DGGML_ACCELERATE=ON
    -DGGML_BLAS=OFF
  )
elif [ "$PLATFORM" = "linux" ]; then
  CMAKE_ARGS+=(
    -DGGML_OPENMP=ON
  )
fi

echo "[build-whisper] cmake configure"
cmake "${CMAKE_ARGS[@]}"

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
echo "[build-whisper] cmake build (jobs=$JOBS)"
cmake --build build -j "$JOBS" --config Release --target whisper-cli whisper-server

cd - >/dev/null

# 拷贝产物
mkdir -p "$OUT_DIR"
EXT=""
[ "$PLATFORM" = "win32" ] || [ "${PLATFORM:0:5}" = "mingw" ] && EXT=".exe"

for binary in whisper-cli whisper-server; do
  src="$BUILD_DIR/build/bin/${binary}${EXT}"
  if [ ! -f "$src" ]; then
    echo "未找到产物: $src" >&2
    echo "可用文件:" >&2
    ls -la "$BUILD_DIR/build/bin/" >&2 || true
    exit 1
  fi
  cp "$src" "$OUT_DIR/${binary}${EXT}"
  chmod +x "$OUT_DIR/${binary}${EXT}"
  echo "[build-whisper] -> $OUT_DIR/${binary}${EXT}"
done

# macOS: 清 quarantine
if [ "$PLATFORM" = "darwin" ]; then
  xattr -dr com.apple.quarantine "$OUT_DIR" 2>/dev/null || true
fi

echo "[build-whisper] done"
ls -lh "$OUT_DIR"
