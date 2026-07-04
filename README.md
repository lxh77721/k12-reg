# GPT K12 Console

## 学习交流群

扫码加入学习交流群：

![学习交流群](public/qq-study-group.jpg)

一个本地运行的任务控制台，用于管理邮箱池、K12 workspace 加入流程、Sub2API 导入、AT 测活/修复、账号 JSON 写出等自动化流程。

> 本项目仅作为开源技术示例和本地自动化工具发布。使用者应自行确认使用场景是否合法、合规，并自行承担使用风险。

## 功能概览

- 邮箱池管理：导入、选择、删除、状态标记。
- 邮箱接码：支持普通接码 URL、手动接码、SMSBower Gmail、Emailnator Gmail。
- K12 流程：登录、加入/切换 K12 workspace、读取 K12 上下文 AT。
- Sub2API：OAuth 入库、noRT 直入、账号测活、AT 修复。
- JSON 写出：支持 SUB2API / CPA 格式。
- 数据迁移：支持导入/导出本地数据包。
- 任务管理：批量启动、取消、重试、清理失败任务、分页查看日志。

## 环境要求

- Node.js 20+，建议 22+。
- npm 10+。
- 可访问相关服务的网络环境。
- 如需代理，请自行准备 HTTP/SOCKS 代理。

## 安装与启动

```bash
npm install
npm run dev
```

默认地址：

- Web 控制台：`http://127.0.0.1:5174/`
- API 服务：`http://127.0.0.1:8796/`

生产构建：

```bash
npm run build
```

## 基础使用

1. 打开 Web 控制台。
2. 点击「设置」，填写本地运行所需配置。
3. 按需导入邮箱池，或启用动态 Gmail 接码。
4. 设置任务数量、并发、Sub2API/noRT/JSON 写出选项。
5. 启动任务并在任务列表查看状态和日志。

## 配置说明

配置主要通过页面「设置」保存，运行时会写入本地：

- `data/config.json`
- `config.json`，兼容旧流程使用

常见配置项：

| 配置项 | 说明 |
| --- | --- |
| `defaultProxyUrl` | OpenAI/Auth 请求代理，支持 `direct`、HTTP、SOCKS。 |
| `workspaceIds` | K12 workspace ID，可多个。 |
| `taskConcurrency` | 任务并发数。 |
| `runWorkspaceJoin` | 是否执行 K12 加入/切换流程。 |
| `runSub2Api` | 是否执行 Sub2API 入库。 |
| `sub2apiNoRtMode` | 是否使用 noRT 直入模式。 |
| `sub2apiUrl` | Sub2API 服务地址。 |
| `sub2apiEmail` | Sub2API 管理员账号。 |
| `sub2apiPassword` | Sub2API 管理员密码。 |
| `smsBowerMailEnabled` | 是否开启动态 Gmail 接码。 |
| `gmailMailProvider` | 动态 Gmail 渠道：`smsbower` 或 `emailnator`。 |
| `jsonOutDir` | 账号 JSON 写出目录。 |
| `jsonOutFormat` | JSON 写出格式：`sub2api` 或 `cpa`。 |

请不要把真实配置提交到公开仓库。

## 敏感文件

以下文件或目录可能包含密码、API Key、邮箱 refresh token、access token、cookie、账号 JSON 等敏感数据，不应公开：

```text
config.json
data/
json/
pool_tokens.txt
*.log
codex_register/config.json
```

项目默认 `.gitignore` 已忽略这些路径。提交代码前建议执行：

```bash
git status --short --ignored
```

确认敏感文件没有出现在待提交列表中。

## 常见问题

### 1. `EmailOtpValidate wrong_email_otp_code`

OpenAI 判定提交的邮箱验证码错误。通常是接码源返回了旧邮件、广告邮件中的 6 位数字，或验证码已过期。

### 2. 停在 `accounts.google.com`

该邮箱被 OpenAI 引导到 Google OAuth 登录，不是普通邮箱验证码流程。当前工具不会自动登录 Google 账号，应换用可走邮箱验证码流程的邮箱。

### 3. `CreateAccount HTTP 500 Request timeout`

OpenAI 创建账号接口超时。通常是远端服务波动、代理慢或并发过高。可以重试或降低并发。

### 4. 取消任务后没有立刻停

任务会尽量快速停止；如果当前正在网络请求中，需要等当前请求返回或超时后进入取消收尾。

## 风险说明

使用本项目可能存在以下风险：

- 第三方服务规则变更导致流程失效。
- 账号注册、登录、接码、代理、导入等行为可能触发风控。
- 第三方 API、邮箱、代理、Sub2API 等服务可能泄露、失效或产生费用。
- 本地保存的 token、cookie、refresh token、账号 JSON 一旦泄露，可能导致账号被他人使用。
- 自动化行为可能违反某些服务条款或当地法律法规。

请只在你拥有授权、允许测试、允许自动化的环境中使用。使用者应自行评估合法性、合规性和商业风险。

## 免责声明

本项目按“现状”开源发布，仅用于技术研究、学习交流和本地自动化示例。

项目作者、贡献者不对任何使用结果承担责任，包括但不限于账号损失、服务封禁、数据泄露、费用损失、业务中断、法律纠纷或第三方索赔。

任何人使用、复制、修改、分发或部署本项目，即表示其已理解并接受：

- 自行承担全部使用风险；
- 自行遵守当地法律法规和第三方服务条款；
- 不得将本项目用于未授权、违法、侵权或滥用场景；
- 项目作者不参与、不认可、也不负责使用者的具体用途和后果。

如果你不能接受上述条款，请不要使用本项目。

## 开源协议

本项目采用 MIT License。详见 `LICENSE`。

MIT 协议允许你自由使用、复制、修改、合并、发布、分发、再授权或销售本软件副本，但必须保留版权声明和许可声明。软件按“现状”提供，不提供任何明示或暗示担保。

## 贡献

欢迎提交 issue 和 pull request。请注意：

- 不要提交真实账号、密码、API Key、token、cookie、接码 URL。
- 不要提交 `data/`、`json/`、`pool_tokens.txt`、日志文件。
- 提交前请运行构建检查：

```bash
npm run build
```
