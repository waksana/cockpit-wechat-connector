// Only used by the spawned CLI test. No product flag can enable this routing.
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const local = `http://127.0.0.1:${process.env.TEST_MOCK_PORT}`;
  if (url.origin === 'https://ilinkai.weixin.qq.com') {
    return original(`${local}/weixin${url.pathname}${url.search}`, init);
  }
  if (url.origin === local) return original(input, init);
  throw new Error('Test blocked external request');
};
