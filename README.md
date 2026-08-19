# 镜鉴实验室

一个部署于 GitHub Pages 的摄像头权限钓鱼反诈分析实验室，用于演示社会工程诱导、浏览器权限边界与防范方法。

## 安全边界

- 不收集账号、密码或身份信息
- 摄像头画面只在当前标签页内处理，截取一帧后立即停止设备
- 页面关闭或刷新后照片自动清除，也可在页面内手动清除
- 只有用户完成演示并再次勾选同意后，才发送匿名飞书通知
- 通知仅包含事件类型、同意版本和时间，不包含照片或设备信息
- 仅用于已授权的安全研究、反诈培训与技术分析

## 部署

项目是纯静态页面，GitHub Pages 直接发布仓库根目录即可。摄像头 API 需要 HTTPS 安全上下文；GitHub Pages 默认提供 HTTPS。

## 配置飞书通知

公开的 GitHub Pages 不能安全保存飞书 Webhook。本项目通过 `worker/feishu-notify.js` 代理发送通知，Webhook 只保存在 Worker secret 中。飞书官方也要求妥善保管自定义机器人 Webhook，避免被恶意调用。

1. 在接收通知的飞书群中添加自定义机器人，并保存 Webhook。可给机器人配置关键词 `[反诈实验]`。
2. `worker/wrangler.toml` 已按本仓库配置为 `https://yoyohu0527.github.io`。如果以后改用自定义域名，再同步修改 `ALLOWED_ORIGIN`，末尾不要加斜杠。
3. 在 `worker` 目录执行 `npx wrangler secret put FEISHU_WEBHOOK_URL`，输入完整 Webhook；不要把它写入仓库。
4. 执行 `npx wrangler deploy`，获得类似 `https://camera-feishu-notify.NAME.workers.dev` 的地址。
5. 将 `index.html` 中 `feishu-notify-endpoint` 的 `content` 设置为完整接口地址，例如 `https://camera-feishu-notify.NAME.workers.dev/notify`。

如果 Worker 使用自定义域名，还需要把该域名加入 `index.html` 的 CSP `connect-src`。生产使用时建议在 Worker 平台额外开启速率限制。

飞书参考：[使用自定义机器人发送消息卡片](https://open.feishu.cn/document/common-capabilities/message-card/getting-started/send-message-cards-with-a-custom-bot?lang=zh-CN)。

## 本地查看

普通文件地址无法使用摄像头。可启动本地 HTTP 服务查看布局，但完整权限流程应通过 GitHub Pages 的 HTTPS 地址或 localhost 验证。
