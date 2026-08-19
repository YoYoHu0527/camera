const CONSENT_VERSION = '2026-08-19';
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

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

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: origin ? corsHeaders(origin) : {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();

    if (url.pathname !== '/notify') return json({ ok: false, error: 'not_found' }, 404);
    if (!allowedOrigin || origin !== allowedOrigin) return json({ ok: false, error: 'origin_denied' }, 403);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > 2048) return json({ ok: false, error: 'payload_too_large' }, 413, origin);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400, origin);
    }

    const occurredAt = Date.parse(payload.occurredAt);
    const isFresh = Number.isFinite(occurredAt) && Math.abs(Date.now() - occurredAt) <= MAX_CLOCK_SKEW_MS;
    if (
      payload.event !== 'camera_demo_confirmed' ||
      payload.consentVersion !== CONSENT_VERSION ||
      !isFresh
    ) {
      return json({ ok: false, error: 'invalid_event' }, 400, origin);
    }

    const webhook = (env.FEISHU_WEBHOOK_URL || '').trim();
    if (!webhook.startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/')) {
      return json({ ok: false, error: 'server_not_configured' }, 503, origin);
    }

    const message = {
      msg_type: 'text',
      content: {
        text: [
          '[反诈实验] 用户确认通知',
          '一名参与者已明确同意并完成摄像头权限演示。',
          `确认时间：${new Date(occurredAt).toISOString()}`,
          '照片：未上传',
        ].join('\n'),
      },
    };

    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.code !== 0) {
        return json({ ok: false, error: 'feishu_rejected' }, 502, origin);
      }
      return json({ ok: true }, 200, origin);
    } catch {
      return json({ ok: false, error: 'feishu_unavailable' }, 502, origin);
    }
  },
};
