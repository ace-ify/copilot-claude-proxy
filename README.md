# Copilot Claude Proxy 

> **⚠️ Disclaimer:** This is an unofficial, experimental tool. It interfaces with GitHub Copilot endpoints in ways that may not be officially supported for third-party clients. Users are responsible for complying with GitHub's and Anthropic's Terms of Service. Use at your own risk. The author is not responsible for blocked accounts or ToS violations.

A local compatibility proxy that accepts Anthropic-style `POST /v1/messages` calls and forwards them to the GitHub Copilot OpenAI-compatible chat endpoint. Ideal for using [Claude Code](https://github.com/anthropics/claude-code) with your existing Copilot models.

This is intended for personal, authorized use only.

## 🚀 Quick Start (Zero Install)

You can run this proxy directly using `npx` without needing to clone the repository or manually install dependencies.

1. Open your terminal and run:

```bash
npx @ace-ify/copilot-claude-proxy
```

2. The server will start on `http://127.0.0.1:2169` by default.

3. Open the **Admin UI** at `http://127.0.0.1:2169/admin` in your browser.

4. Click **Connect Copilot** to authenticate via the GitHub OAuth device flow. This securely generates a token used to forward requests to GitHub models.

5. Select your preferred model and click **Enable Proxy**. This will automatically patch your Claude settings.

## 🛠️ Local Setup (For Developers)

If you prefer to run it locally from source:

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/ace-ify/copilot-claude-proxy.git
cd copilot-claude-proxy
npm install
```

2. (Optional) Create an `.env` file:
```bash
copy .env.example .env
```

3. Run the server:
```bash
npm start
```

## ⚙️ Configuration (Environment Variables)

The proxy comes with sensible defaults, but you can override them using environment variables. 

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `2169` | Local listen port. |
| `COPILOT_ACCESS_TOKEN` | `null` | Your GitHub Copilot access token. If you use the Web UI to login, you don't need to set this. |
| `GITHUB_TOKEN` | `null` | Fallback if `COPILOT_ACCESS_TOKEN` is unset. |
| `DEFAULT_MODEL` | `gpt-5.3-codex` | Fallback model if the incoming request omits a model. |
| `ADMIN_MODEL_ALLOWLIST` | *multiple* | Comma-separated model IDs visible in the Admin UI dropdown. |

*Note: For a full list of advanced tuning variables (endpoint overrides, caching TTLs, beta headers), please check `src/server.js`.*

## 🧠 How it Works & Routing

This proxy acts as a bridge between your local tools (like Claude Code) and GitHub Copilot's upstream APIs. 

1. **Model Discovery:** The proxy checks Copilot `/models` and inspects each model's `supported_endpoints`.
2. **Anthropic Native:** If a model supports `/v1/messages` natively, the proxy forwards directly to Copilot `/v1/messages`.
3. **Responses API:** If a model supports `/responses`, the proxy uses `/responses` (supporting both non-streaming and streaming).
4. **OpenAI Fallback:** Otherwise, it falls back to Copilot `/chat/completions` and performs Anthropic <-> OpenAI mapping on the fly.

### Endpoints
- `POST /v1/messages`: Anthropic-like messages payload mapped to Copilot.
- `GET /healthz`: Health check endpoint.
- `/admin/*`: Internal endpoints for the dashboard (status, trace, live metrics, auth).

## 🔒 Security Notes

- **Keep this local only (`127.0.0.1`)** unless you intentionally add auth and network controls.
- **Do not share your token.**
- Copilot upstream model availability depends on your GitHub Copilot entitlement and account policy.
- Upstream schema or policy changes may require adapter updates.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.