const CONSENT_VERSION = '2026-08-19-photo-device-ip-v1';
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const MAX_REQUEST_BYTES = 300_000;
const MAX_PHOTO_BYTES = 80_000;
const MAX_DEVICE_BYTES = 2_048;
const BASE64_CHUNK_CHARACTERS = 12_000;

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

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function splitText(value, size) {
  const parts = [];
  for (let offset = 0; offset < value.length; offset += size) {
    parts.push(value.slice(offset, offset + size));
  }
  return parts;
}

function shortDelay() {
  return new Promise(resolve => setTimeout(resolve, 250));
}

async function sendWebhookText(webhook, text) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      msg_type: 'text',
      content: { text },
    }),
  });
  const result = await response.json().catch(() => ({}));
  const accepted = result.code === 0 || result.StatusCode === 0;
  if (!response.ok || !accepted) throw new Error('webhook_rejected');
}

async function sendUploadToFeishu(webhook, upload, ipAddress) {
  const uploadId = crypto.randomUUID();
  const bytes = new Uint8Array(await upload.photo.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  const parts = splitText(base64, BASE64_CHUNK_CHARACTERS);
  const device = upload.device;

  await sendWebhookText(
    webhook,
    [
      '[反诈实验] 已同意的摄像头上传',
      `照片编号：${uploadId}`,
      `确认时间：${new Date(upload.occurredAt).toISOString()}`,
      `连接 IP：${ipAddress}`,
      `设备：${device.platform} · ${device.language} · ${device.timezone}`,
      `屏幕：${device.screen.width}×${device.screen.height} @ ${device.screen.pixelRatio}x`,
      `浏览器：${device.userAgent}`,
      `照片格式：image/jpeg;base64，共 ${parts.length} 个分片`,
      '请按分片序号拼接 DATA_BEGIN 与 DATA_END 之间的字符。',
    ].join('\n'),
  );
  await shortDelay();

  for (let index = 0; index < parts.length; index += 1) {
    await sendWebhookText(
      webhook,
      [
        '[反诈实验] 照片 Base64 分片',
        `照片编号：${uploadId}`,
        `分片：${index + 1}/${parts.length}`,
        'DATA_BEGIN',
        parts[index],
        'DATA_END',
      ].join('\n'),
    );
    if (index < parts.length - 1) await shortDelay();
  }
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

    const webhook = (env.FEISHU_WEBHOOK_URL || '').trim();
    if (!webhook.startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/')) {
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
      await sendUploadToFeishu(webhook, upload, ipAddress);
      return json({ ok: true }, 200, origin);
    } catch {
      return json({ ok: false, error: 'feishu_unavailable' }, 502, origin);
    }
  },
};
