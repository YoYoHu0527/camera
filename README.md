# 镜鉴实验室

一个部署于 GitHub Pages 的摄像头权限钓鱼反诈分析实验室，用于演示社会工程诱导、浏览器权限边界与防范方法。

## 安全边界

- 不收集账号、密码或身份信息
- 只有用户明确勾选同意并点击按钮后，才请求摄像头权限和上传数据
- 同意范围在按钮旁逐项披露：一张前置摄像头照片、基础设备摘要和连接 IP
- 截取一帧后立即停止摄像头；页面仅保留预览，刷新或手动清除即可移除本地预览
- Worker 只做校验和转发，不使用数据库、KV 或对象存储保存数据
- 连接 IP 由 Cloudflare 的受信请求头读取，不接受网页自行提交的 IP
- 照片会编码成带编号的 Base64 文本分片，连同设备摘要进入指定飞书群；Base64 不是加密
- 仅用于已授权的安全研究、反诈培训与技术分析

## 部署

项目是纯静态页面，GitHub Pages 直接发布仓库根目录即可。摄像头 API 需要 HTTPS 安全上下文；GitHub Pages 默认提供 HTTPS。

## 配置飞书通知

本项目复用飞书群自定义机器人 Webhook。页面会把 JPEG 压缩到最多约 80 KB；Worker 再编码为 Base64，并拆成带照片编号和分片序号的多条文本消息。第一条消息包含设备摘要、连接 IP、时间和总分片数。Webhook 只保存在 Cloudflare Worker secret 中。

1. 在接收消息的飞书群中添加自定义机器人，建议把安全关键词设为 `[反诈实验]`。
2. `worker/wrangler.toml` 已按本仓库配置为 `https://yoyohu0527.github.io`。如果以后改用自定义域名，再同步修改 `ALLOWED_ORIGIN`，末尾不要加斜杠。
3. 在 `worker` 目录执行以下命令，并在提示中输入 Webhook 地址：

   ```powershell
   npx wrangler secret put FEISHU_WEBHOOK_URL
   ```

4. 执行 `npx wrangler deploy`。当前前端已指向 `https://camera-feishu-notify.yoyo001.workers.dev/notify`；若 Worker 地址变化，再修改 `index.html` 中 `feishu-notify-endpoint` 的 `content`。

## 还原照片

在飞书中找到同一个“照片编号”的全部分片，按照 `1/N` 到 `N/N` 排序，只复制每条消息中 `DATA_BEGIN` 与 `DATA_END` 之间的字符并连续拼接。将结果保存为 `photo-base64.txt`，然后执行：

```powershell
$base64 = (Get-Content -Raw -Encoding UTF8 .\photo-base64.txt) -replace '\s', ''
[IO.File]::WriteAllBytes((Join-Path (Get-Location) 'photo.jpg'), [Convert]::FromBase64String($base64))
```

生成的 `photo.jpg` 就是还原后的照片。Base64 只是二进制文本编码，任何能看到这些群消息的人都可以还原照片。

如果 Worker 使用自定义域名，还需要把该域名加入 `index.html` 的 CSP `connect-src`。生产使用时建议在 Worker 平台额外开启速率限制。

飞书参考：[使用自定义机器人发送消息](https://open.feishu.cn/document/common-capabilities/message-card/getting-started/send-message-cards-with-a-custom-bot?lang=zh-CN)。Cloudflare IP 来源参考：[HTTP 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。

## 本地查看

普通文件地址无法使用摄像头。可启动本地 HTTP 服务查看布局，但完整权限流程应通过 GitHub Pages 的 HTTPS 地址或 localhost 验证。
