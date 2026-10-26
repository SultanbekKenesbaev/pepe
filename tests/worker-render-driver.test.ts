import { test } from 'node:test';
import assert from 'node:assert/strict';

type Driver = 'swiftshader' | 'llvmpipe';
type BrowserSession = { send(method: string): Promise<unknown>; detach(): Promise<void> };
type Browser = { version(): string; newBrowserCDPSession(): Promise<BrowserSession> };
type RendererEvidence = {
  driver: Driver; browserVersion: string; glRenderer: string;
  glVendor: string | null; glVersion: string | null; displayType: string | null; verifiedAt: string;
};

// Import the standalone Node worker without adding it to the app's TS build or
// invoking its CLI. These tests need neither Chromium nor generated lesson code.
const { rendererDriverConfig, verifyRendererDriver } = await import(new URL('../worker/render.mjs', import.meta.url).href) as {
  rendererDriverConfig(driver?: unknown): { driver: Driver; args: string[]; env: Record<string, string> };
  verifyRendererDriver(browser: Browser, driver: unknown): Promise<RendererEvidence>;
};

function browserReturning(info: unknown, failure?: Error) {
  const calls: string[] = [];
  const browser: Browser = {
    version: () => '155.0.test',
    async newBrowserCDPSession() {
      calls.push('browser-session');
      return {
        async send(method) { calls.push(method); if (failure) throw failure; return info; },
        async detach() { calls.push('detach'); },
      };
    },
  };
  return { browser, calls };
}

test('render driver selection is explicit, defaults locally to SwiftShader and rejects automatic or injected fallbacks', () => {
  const previous = process.env.WORKER_RENDER_DRIVER;
  try {
    delete process.env.WORKER_RENDER_DRIVER;
    assert.equal(rendererDriverConfig().driver, 'swiftshader');
    process.env.WORKER_RENDER_DRIVER = 'llvmpipe';
    assert.equal(rendererDriverConfig().driver, 'llvmpipe');
    const mesa = rendererDriverConfig('llvmpipe'), swift = rendererDriverConfig('swiftshader');
    assert.ok(mesa.args.includes('--use-angle=gl-egl'));
    assert.ok(!mesa.args.some(arg => arg.includes('swiftshader')));
    assert.equal(mesa.env.GALLIUM_DRIVER, 'llvmpipe');
    assert.ok(swift.args.includes('--use-angle=swiftshader'));
    assert.ok(!swift.args.includes('--ignore-gpu-blocklist'));
    for (const value of ['', 'auto', 'mesa', 'llvmpipe --disable-web-security', null, false, 0]) {
      assert.throws(() => rendererDriverConfig(value), /must be swiftshader or llvmpipe/);
    }
  } finally {
    if (previous === undefined) delete process.env.WORKER_RENDER_DRIVER;
    else process.env.WORKER_RENDER_DRIVER = previous;
  }
});

test('each accepted renderer is proved through the browser-process CDP field, without trusting page-level claims', async () => {
  for (const [driver, actual] of [
    ['swiftshader', 'ANGLE (Google, SwiftShader Device (LLVM10), SwiftShader driver)'],
    ['llvmpipe', 'ANGLE (Mesa/X.org, llvmpipe (LLVM15 256bits), OpenGL ES3.2)'],
  ] as const) {
    const { browser, calls } = browserReturning({ gpu: { auxAttributes: { glRenderer: actual } } });
    Object.assign(browser, { newPage() { assert.fail('Generated page code must not certify its own renderer'); } });
    const evidence = await verifyRendererDriver(browser, driver);
    assert.equal(evidence.driver, driver);
    assert.equal(evidence.glRenderer, actual);
    assert.equal(evidence.browserVersion, '155.0.test');
    assert.deepEqual(calls, ['browser-session', 'SystemInfo.getInfo', 'detach']);
  }
});

test('missing, wrong and ambiguous trusted renderer evidence cannot silently pass as the requested driver', async t => {
  const cases: [string, Driver, unknown][] = [
    ['SwiftShader fallback for Mesa', 'llvmpipe', { gpu: { auxAttributes: { glRenderer: 'ANGLE SwiftShader' } } }],
    ['Mesa fallback for SwiftShader', 'swiftshader', { gpu: { auxAttributes: { glRenderer: 'ANGLE llvmpipe' } } }],
    ['a different software driver', 'llvmpipe', { gpu: { auxAttributes: { glRenderer: 'softpipe' } } }],
    ['ambiguous mixed renderer', 'llvmpipe', { gpu: { auxAttributes: { glRenderer: 'ANGLE llvmpipe SwiftShader' } } }],
    ['missing GPU info', 'llvmpipe', {}],
    ['missing trusted field despite other renderer claims', 'llvmpipe', { gpu: { devices: [{ deviceString: 'llvmpipe' }], auxAttributes: {} }, pageRenderer: 'llvmpipe' }],
    ['non-string renderer', 'llvmpipe', { gpu: { auxAttributes: { glRenderer: ['llvmpipe'] } } }],
    ['oversized renderer', 'llvmpipe', { gpu: { auxAttributes: { glRenderer: 'llvmpipe' + 'x'.repeat(2048) } } }],
  ];
  for (const [name, driver, info] of cases) await t.test(name, async () => {
    const { browser, calls } = browserReturning(info);
    await assert.rejects(verifyRendererDriver(browser, driver), /renderer is not active/);
    assert.deepEqual(calls, ['browser-session', 'SystemInfo.getInfo', 'detach']);
  });
});

test('a browser CDP failure propagates and always releases the diagnostic session', async () => {
  const failure = new Error('Browser GPU diagnostic unavailable'), { browser, calls } = browserReturning({}, failure);
  await assert.rejects(verifyRendererDriver(browser, 'llvmpipe'), error => error === failure);
  assert.deepEqual(calls, ['browser-session', 'SystemInfo.getInfo', 'detach']);
});

test('an invalid requested driver fails before opening any browser diagnostic session', async () => {
  const { browser, calls } = browserReturning({ gpu: { auxAttributes: { glRenderer: 'llvmpipe' } } });
  await assert.rejects(verifyRendererDriver(browser, 'automatic-fallback'), /must be swiftshader or llvmpipe/);
  assert.deepEqual(calls, []);
});

test('renderer provenance contains only bounded report fields from the verified browser', async () => {
  const actual = 'ANGLE llvmpipe', { browser } = browserReturning({
    gpu: { auxAttributes: { glRenderer: actual, glVendor: 'Mesa/X.org', glVersion: 'OpenGL ES3.2', displayType: 'ANGLE_OPENGL_EGL', glExtensions: 'not-a-report-field', fullDeviceDump: 'not-a-report-field' } },
  });
  const evidence = await verifyRendererDriver(browser, 'llvmpipe');
  assert.deepEqual(Object.keys(evidence).sort(), ['driver', 'browserVersion', 'glRenderer', 'glVendor', 'glVersion', 'displayType', 'verifiedAt'].sort());
  assert.equal(evidence.glVendor, 'Mesa/X.org');
  assert.equal(evidence.displayType, 'ANGLE_OPENGL_EGL');
  assert.ok(Number.isFinite(Date.parse(evidence.verifiedAt)));
  assert.doesNotMatch(JSON.stringify(evidence), /not-a-report-field/);
});
