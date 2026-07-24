// 测试全局 setup。node 环境下没有 window/document,所以所有 DOM 相关 stub 都要守卫。
// 这里只做最小处理:jsdom 环境给一个空的 localStorage 兜底(jsdom 已自带,通常无需),
// 不在这里 mock window.videoAnalyzer —— 各测试按需自己注入,避免互相污染。

if (typeof window !== "undefined" && !("matchMedia" in window)) {
  // 某些组件/主题逻辑会读 matchMedia,jsdom 不实现,给个惰性 stub。
  // @ts-expect-error jsdom 环境补丁
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
