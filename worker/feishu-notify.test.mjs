import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './feishu-notify.js';

const origin = 'https://example.github.io';
const env = {
  ALLOWED_ORIGIN: origin,
  FEISHU_APP_ID: 'cli_test_app',
  FEISHU_APP_SECRET: 'test-secret',
  FEISHU_CHAT_ID: 'oc_test_chat',
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

test('valid consent upload is forwarded to Feishu as an image post', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });

    if (String(url).endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tenant-token' });
    }
    if (String(url).endsWith('/im/v1/images')) {
      assert.equal(options.headers.Authorization, 'Bearer tenant-token');
      assert.equal(options.body.get('image_type'), 'message');
      return Response.json({ code: 0, data: { image_key: 'img_test' } });
    }

    const message = JSON.parse(options.body);
    const content = JSON.parse(message.content);
    assert.equal(message.receive_id, env.FEISHU_CHAT_ID);
    assert.equal(message.msg_type, 'post');
    assert.match(JSON.stringify(content), /img_test/);
    assert.match(JSON.stringify(content), /203\.0\.113\.8/);
    return Response.json({ code: 0, data: { message_id: 'om_test' } });
  };

  try {
    const response = await worker.fetch(uploadRequest(), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 3);
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
  request.headers.set('Content-Length', '1500001');
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
});
