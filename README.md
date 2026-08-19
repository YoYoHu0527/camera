# 镜鉴实验室

一个部署于 GitHub Pages 的摄像头权限钓鱼反诈分析实验室，用于演示社会工程诱导、浏览器权限边界与防范方法。

## 安全边界

- 不收集账号、密码或身份信息
- 只有用户明确勾选同意并点击按钮后，才请求摄像头权限和上传数据
- 同意范围在按钮旁逐项披露：一张前置摄像头照片、基础设备摘要和连接 IP
- 截取一帧后立即停止摄像头；页面仅保留预览，刷新或手动清除即可移除本地预览
- Worker 只做校验和转发，不使用数据库、KV 或对象存储保存数据
- 连接 IP 由 Cloudflare 的受信请求头读取，不接受网页自行提交的 IP
- 照片和摘要会进入指定飞书群，后续保留与删除受飞书群消息策略控制
- 仅用于已授权的安全研究、反诈培训与技术分析

## 部署

项目是纯静态页面，GitHub Pages 直接发布仓库根目录即可。摄像头 API 需要 HTTPS 安全上下文；GitHub Pages 默认提供 HTTPS。

## 配置飞书通知

图片上传不能只使用原来的群自定义机器人 Webhook。本项目改用飞书企业自建应用机器人：Worker 先取得应用访问凭证、上传图片，再向指定群发送包含照片、设备摘要和 IP 的富文本消息。应用密钥只保存在 Cloudflare Worker secret 中。

1. 在飞书开放平台创建企业自建应用，启用机器人能力。
2. 为应用开通上传图片和以机器人身份发送消息所需权限（`im:resource`、`im:message:send_as_bot`），发布应用，并把应用机器人加入接收消息的群。
3. 获取应用的 App ID、App Secret 和目标群 Chat ID。不要把 App Secret 粘贴到聊天、源码或 Git 仓库。
4. `worker/wrangler.toml` 已按本仓库配置为 `https://yoyohu0527.github.io`。如果以后改用自定义域名，再同步修改 `ALLOWED_ORIGIN`，末尾不要加斜杠。
5. 在 `worker` 目录依次执行以下命令，并在提示中输入对应值：

   ```powershell
   npx wrangler secret put FEISHU_APP_ID
   npx wrangler secret put FEISHU_APP_SECRET
   npx wrangler secret put FEISHU_CHAT_ID
   ```

6. 执行 `npx wrangler deploy`。当前前端已指向 `https://camera-feishu-notify.yoyo001.workers.dev/notify`；若 Worker 地址变化，再修改 `index.html` 中 `feishu-notify-endpoint` 的 `content`。
7. 新流程验证成功后，旧的 Webhook secret 已不再使用，可以执行 `npx wrangler secret delete FEISHU_WEBHOOK_URL` 删除。

如果 Worker 使用自定义域名，还需要把该域名加入 `index.html` 的 CSP `connect-src`。生产使用时建议在 Worker 平台额外开启速率限制。

飞书参考：[获取 tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)、[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。Cloudflare IP 来源参考：[HTTP 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。

## 本地查看

普通文件地址无法使用摄像头。可启动本地 HTTP 服务查看布局，但完整权限流程应通过 GitHub Pages 的 HTTPS 地址或 localhost 验证。
