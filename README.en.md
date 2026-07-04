# GPT K12 Console

## Study Group

Scan the QR code to join the study group:

![Study Group](public/qq-study-group.jpg)

A local task console for managing mailbox pools, K12 workspace flows, Sub2API imports, access-token checks/repairs, and account JSON export.

> This project is released as an open-source technical example and local automation tool only. Users are solely responsible for determining whether their use case is lawful, compliant, and allowed by third-party service terms.

## Features

- Mailbox pool management: import, select, delete, and mark statuses.
- OTP handling: mailbox URL, manual OTP, SMSBower Gmail, and Emailnator Gmail.
- K12 flow: login, join/switch K12 workspace, and read K12-context access tokens.
- Sub2API: OAuth import, noRT import, account liveness check, and AT repair.
- JSON output: SUB2API and CPA formats.
- Data migration: local import/export.
- Task management: batch start, cancel, retry, clear failed tasks, pagination, and logs.

## Requirements

- Node.js 20+, Node.js 22+ recommended.
- npm 10+.
- Network access to the services you configure.
- Optional HTTP/SOCKS proxy.

## Install and Run

```bash
npm install
npm run dev
```

Default URLs:

- Web console: `http://127.0.0.1:5174/`
- API server: `http://127.0.0.1:8796/`

Production build:

```bash
npm run build
```

## SaaS Multi-User Mode

The web console creates a tenant ID in browser `localStorage` and sends it to the API as `X-K12-Tenant-Id`. The backend isolates config, mailbox pools, tasks, refill history, and JSON output per tenant:

- Default local user: `data/`
- Browser tenants in production: `data/tenants/<tenantId>/`

Each deployed user can keep their own Sub2API, proxy, mailbox, and task settings instead of sharing one `data/config.json`. Clearing browser data or switching browsers creates a new tenant space.

## Basic Usage

1. Open the web console.
2. Open Settings and fill in your local configuration.
3. Import a mailbox pool or enable dynamic Gmail OTP.
4. Configure task count, concurrency, Sub2API/noRT, and JSON output options.
5. Start tasks and inspect status/logs in the task list.

## Configuration

The web Settings page writes local configuration to:

- `data/config.json`
- `config.json`, for compatibility with legacy flows

Common fields:

| Field | Description |
| --- | --- |
| `defaultProxyUrl` | Proxy for OpenAI/Auth requests. Supports `direct`, HTTP, and SOCKS. |
| `workspaceIds` | One or more K12 workspace IDs. |
| `taskConcurrency` | Task concurrency. |
| `runWorkspaceJoin` | Whether to run the K12 join/switch flow. |
| `runSub2Api` | Whether to import accounts into Sub2API. |
| `sub2apiNoRtMode` | Whether to use noRT import mode. |
| `sub2apiUrl` | Sub2API service URL. |
| `sub2apiEmail` | Sub2API admin email. |
| `sub2apiPassword` | Sub2API admin password. |
| `smsBowerMailEnabled` | Enable dynamic Gmail OTP mode. |
| `gmailMailProvider` | Dynamic Gmail provider: `smsbower` or `emailnator`. |
| `jsonOutDir` | Account JSON output directory. |
| `jsonOutFormat` | JSON output format: `sub2api` or `cpa`. |

Do not commit real configuration values to a public repository.

## Sensitive Files

The following files or directories may contain passwords, API keys, mailbox refresh tokens, access tokens, cookies, or account credentials and must not be made public:

```text
config.json
data/
json/
pool_tokens.txt
*.log
codex_register/config.json
```

These paths are ignored by `.gitignore` by default. Before committing, check:

```bash
git status --short --ignored
```

## FAQ

### `EmailOtpValidate wrong_email_otp_code`

OpenAI rejected the submitted email OTP. This is often caused by stale emails, ad emails containing six-digit numbers, or expired OTPs.

### Redirected to `accounts.google.com`

The email was routed to Google OAuth instead of the email OTP flow. This tool does not automate Google account login. Use a mailbox that can proceed through the email OTP flow.

### `CreateAccount HTTP 500 Request timeout`

The OpenAI account creation endpoint timed out. It is usually caused by upstream instability, slow proxy, or high concurrency. Retry or lower concurrency.

### Cancel does not stop instantly

Tasks stop as quickly as possible. If a network request is in progress, the task may stop only after that request returns or times out.

## Risks

Using this project may involve risks, including:

- Third-party service changes may break flows.
- Automation may trigger account risk controls.
- Mailbox, proxy, Sub2API, and third-party API services may fail, leak data, or incur costs.
- Locally stored tokens, cookies, refresh tokens, and account JSON files can be used by others if leaked.
- Automation may violate some service terms or local laws.

Use this project only in environments where you are authorized to test and automate. You are responsible for evaluating legal, compliance, and business risks.

## Disclaimer

This project is provided "as is" for technical research, learning, and local automation examples only.

The author and contributors are not responsible for any consequences arising from use of this project, including but not limited to account loss, service suspension, data leakage, financial loss, business interruption, legal disputes, or third-party claims.

By using, copying, modifying, distributing, or deploying this project, you acknowledge that:

- You assume all risks of use.
- You will comply with applicable laws and third-party service terms.
- You will not use this project for unauthorized, illegal, infringing, or abusive activities.
- The author does not participate in, endorse, or take responsibility for any specific use case or outcome.

If you do not accept these terms, do not use this project.

## License

This project is licensed under the MIT License. See `LICENSE`.

The MIT License allows use, copy, modification, merge, publication, distribution, sublicense, and sale of copies of the software, provided that the copyright notice and license notice are retained. The software is provided "as is", without warranty of any kind.

## Contributing

Issues and pull requests are welcome. Please:

- Do not commit real accounts, passwords, API keys, tokens, cookies, or OTP URLs.
- Do not commit `data/`, `json/`, `pool_tokens.txt`, or log files.
- Run build checks before submitting:

```bash
npm run build
```
