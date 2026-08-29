// 空 Worker：所有静态资源由 wrangler.toml 的 [assets]（./dist）直接服务，
// 请求命中不到资源文件时才会落到这里（将来要加 API 路由时在这里写）。
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
