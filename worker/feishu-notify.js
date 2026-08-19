const CONSENT_VERSION = '2026-08-19-photo-device-ip-v1';
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const MAX_REQUEST_BYTES = 1_500_000;
const MAX_PHOTO_BYTES = 1_000_000;
const MAX_DEVICE_BYTES = 2_048;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  };
}

function json(body, status, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: origin
      ? corsHeaders(origin)
      : {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
        },
  });
}

function cleanText(value, maxLength, fallback = '未知') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function sanitizeDevice(raw) {
  if (new TextEncoder().encode(raw).byteLength > MAX_DEVICE_BYTES) {
    throw new Error('device_too_large');
  }

  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_device');
  }

  const screen = input.screen && typeof input.screen === 'object' ? input.screen : {};
  return {
    userAgent: cleanText(input.userAgent, 512),
    platform: cleanText(input.platform, 64),
    language: cleanText(input.language, 32),
    timezone: cleanText(input.timezone, 64),
    screen: {
      width: Math.round(boundedNumber(screen.width, 0, 10_000, 0)),
      height: Math.round(boundedNumber(screen.height, 0, 10_000, 0)),
      pixelRatio: boundedNumber(screen.pixelRatio, 0, 10, 1),
    },
  };
}

async function readBodyWithLimit(request) {
  if (!request.body) throw new Error('empty_body');

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error('payload_too_large');
    }
    chunks.push(value);
  }

  return new Blob(chunks);
}

async function parseUpload(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new Error('invalid_content_type');
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw new Error('payload_too_large');

  const body = await readBodyWithLimit(request);
  const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  const photo = form.get('photo');
  const deviceRaw = form.get('device');

  if (!(photo instanceof File) || photo.type !== 'image/jpeg') throw new Error('invalid_photo');
  if (photo.size < 4 || photo.size > MAX_PHOTO_BYTES) throw new Error('invalid_photo_size');
  if (typeof deviceRaw !== 'string') throw new Error('invalid_device');

  const signature = new Uint8Array(await photo.slice(0, 3).arrayBuffer());
  if (signature[0] !== 0xff || signature[1] !== 0xd8 || signature[2] !== 0xff) {
    throw new Error('invalid_photo_signature');
  }

  const occurredAt = Date.parse(String(form.get('occurredAt') || ''));
  const isFresh = Number.isFinite(occurredAt) && Math.abs(Date.now() - occurredAt) <= MAX_CLOCK_SKEW_MS;
  if (
    form.get('event') !== 'camera_demo_upload' ||
    form.get('consentVersion') !== CONSENT_VERSION ||
    !isFresh
  ) {
    throw new Error('invalid_event');
  }

  return { photo, device: sanitizeDevice(deviceRaw), occurredAt };
}

async function readFeishuJson(response, errorName) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) throw new Error(errorName);
  return result;
}

async function getTenantAccessToken(env) {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });
  const result = await readFeishuJson(response, 'token_rejected');
  if (typeof result.tenant_access_token !== 'string' || !result.tenant_access_token) {
    throw new Error('token_missing');
  }
  return result.tenant_access_token;
}

async function uploadFeishuImage(token, photo) {
  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', photo, 'consented-camera-photo.jpg');

  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const result = await readFeishuJson(response, 'image_rejected');
  const imageKey = result.data?.image_key;
  if (typeof imageKey !== 'string' || !imageKey) throw new Error('image_key_missing');
  return imageKey;
}

async function sendFeishuMessage(token, chatId, imageKey, occurredAt, device, ipAddress) {
  const content = {
    zh_cn: {
      title: '[反诈实验] 已同意的摄像头上传',
      content: [
        [{ tag: 'text', text: '参与者已明确同意上传以下数据。' }],
        [{ tag: 'img', image_key: imageKey }],
        [{ tag: 'text', text: `确认时间：${new Date(occurredAt).toISOString()}` }],
        [{ tag: 'text', text: `连接 IP：${ipAddress}` }],
        [{ tag: 'text', text: `设备：${device.platform} · ${device.language} · ${device.timezone}` }],
        [
          {
            tag: 'text',
            text: `屏幕：${device.screen.width}×${device.screen.height} @ ${device.screen.pixelRatio}x`,
          },
        ],
        [{ tag: 'text', text: `浏览器：${device.userAgent}` }],
      ],
    },
  };

  const response = await fetch(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify(content),
      }),
    },
  );
  await readFeishuJson(response, 'message_rejected');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();

    if (url.pathname !== '/notify') return json({ ok: false, error: 'not_found' }, 404);
    if (!allowedOrigin || origin !== allowedOrigin) {
      return json({ ok: false, error: 'origin_denied' }, 403);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    }

    const appId = (env.FEISHU_APP_ID || '').trim();
    const appSecret = (env.FEISHU_APP_SECRET || '').trim();
    const chatId = (env.FEISHU_CHAT_ID || '').trim();
    if (!appId || !appSecret || !chatId) {
      return json({ ok: false, error: 'server_not_configured' }, 503, origin);
    }

    let upload;
    try {
      upload = await parseUpload(request);
    } catch (error) {
      const status = error instanceof Error && error.message === 'payload_too_large' ? 413 : 400;
      return json({ ok: false, error: status === 413 ? 'payload_too_large' : 'invalid_upload' }, status, origin);
    }

    const ipAddress = cleanText(request.headers.get('CF-Connecting-IP'), 64);

    try {
      const token = await getTenantAccessToken({
        FEISHU_APP_ID: appId,
        FEISHU_APP_SECRET: appSecret,
      });
      const imageKey = await uploadFeishuImage(token, upload.photo);
      await sendFeishuMessage(
        token,
        chatId,
        imageKey,
        upload.occurredAt,
        upload.device,
        ipAddress,
      );
      return json({ ok: true }, 200, origin);
    } catch {
      return json({ ok: false, error: 'feishu_unavailable' }, 502, origin);
    }
  },
};
