import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './feishu-notify.js';

const origin = 'https://example.github.io';
const env = {
  ALLOWED_ORIGIN: origin,
  FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
};

function uploadRequest({ mime = 'image/jpeg', signature = [0xff, 0xd8, 0xff, 0x00] } = {}) {
  const form = new FormData();
  form.append('event', 'camera_demo_upload');
  form.append('consentVersion', '2026-08-19-photo-device-ip-v1');
  form.append('occurredAt', new Date().toISOString());
  form.append(
    'device',
    JSON.stringify({
      userAgent: 'Test Browser',
      platform: 'Test OS',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      screen: { width: 1280, height: 720, pixelRatio: 2 },
    }),
  );
  form.append('photo', new File([new Uint8Array(signature)], 'photo.jpg', { type: mime }));

  return new Request('https://worker.example/notify', {
    method: 'POST',
    headers: {
      Origin: origin,
      'CF-Connecting-IP': '203.0.113.8',
    },
    body: form,
  });
}

test('valid upload sends metadata and reconstructable Base64 chunks to the webhook', async () => {
  const originalFetch = globalThis.fetch;
  const messages = [];

  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), env.FEISHU_WEBHOOK_URL);
    const payload = JSON.parse(options.body);
    assert.equal(payload.msg_type, 'text');
    messages.push(payload.content.text);
    return Response.json({ code: 0 });
  };

  try {
    const originalBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    const response = await worker.fetch(uploadRequest({ signature: originalBytes }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(messages.length, 2);
    assert.match(messages[0], /203\.0\.113\.8/);
    assert.match(messages[0], /共 1 个分片/);

    const encoded = messages[1].match(/DATA_BEGIN\n([A-Za-z0-9+/=]+)\nDATA_END/)[1];
    assert.deepEqual(new Uint8Array(Buffer.from(encoded, 'base64')), originalBytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('large photos are split into ordered, reconstructable chunks', async () => {
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (_url, options) => {
    messages.push(JSON.parse(options.body).content.text);
    return Response.json({ StatusCode: 0 });
  };

  try {
    const originalBytes = new Uint8Array(20_000).fill(0x7a);
    originalBytes.set([0xff, 0xd8, 0xff], 0);
    const response = await worker.fetch(uploadRequest({ signature: originalBytes }), env);
    assert.equal(response.status, 200);
    assert.ok(messages.length > 2);

    const encoded = messages
      .slice(1)
      .map(message => message.match(/DATA_BEGIN\n([A-Za-z0-9+/=]+)\nDATA_END/)[1])
      .join('');
    assert.deepEqual(new Uint8Array(Buffer.from(encoded, 'base64')), originalBytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requests from any other origin are rejected', async () => {
  const request = uploadRequest();
  request.headers.set('Origin', 'https://attacker.example');
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 403);
});

test('non-JPEG uploads are rejected before calling Feishu', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Feishu must not be called');
  };

  try {
    const response = await worker.fetch(uploadRequest({ mime: 'text/plain' }), env);
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('declared oversized bodies are rejected', async () => {
  const request = uploadRequest();
  request.headers.set('Content-Length', '300001');
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
});
