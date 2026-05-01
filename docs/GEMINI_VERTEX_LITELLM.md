# Gemini Vertex LiteLLM Framework

MASTER-MOLD ships a reusable Gemini CLI proxy framework for coworkers, but not
any operator-owned Google Cloud project, OAuth token, ADC JSON, API key, or
quota material.

Each operator uses their own Google login and their own project. The repo only
provides:

- a LiteLLM config template with `__GCP_PROJECT_ID__`,
  `__VERTEX_REGIONS__`, and `__ADC_PATH__` placeholders
- a macOS LaunchAgent template for persistent local startup
- an installer that renders local files under the operator's home directory
- a doctor that checks launchd, health, configured regions, and ADC quota
  project state without printing secrets

## Files

- `templates/gemini/litellm-config.yaml.template`
- `templates/gemini/com.litellm.proxy.plist.template`
- `scripts/gemini_litellm_install.sh`
- `scripts/gemini_litellm_doctor.sh`

Generated files are intentionally local-only:

- `~/.gemini/proxy/config.yaml`
- `~/Library/LaunchAgents/com.litellm.proxy.plist`
- `~/.config/gcloud/application_default_credentials.json`

Do not commit those generated files.

## Prerequisites

Install and authenticate tools on the coworker's Mac:

```bash
python3 -m pip install --user litellm
gcloud auth application-default login
```

The installer can set the ADC quota project after login when `gcloud` is on
`PATH`.

## Install

Use a project owned by the coworker or team, not another operator's personal
project:

```bash
npm run gemini:litellm:install -- \
  --project-id YOUR_GCP_PROJECT_ID \
  --regions global,us-central1,europe-west4,asia-southeast1
```

The script renders local config, writes a LaunchAgent with `RunAtLoad` and
`KeepAlive`, sets the ADC quota project, and starts the proxy. It does not copy
or print the ADC JSON.

Use `--dry-run` to render files into a test location without launchd or gcloud
changes:

```bash
npm run gemini:litellm:install -- \
  --dry-run \
  --project-id YOUR_GCP_PROJECT_ID \
  --output-dir /tmp/gemini-proxy \
  --launchagents-dir /tmp/LaunchAgents
```

## Verify

```bash
npm run gemini:litellm:doctor
curl http://127.0.0.1:4000/health
```

The doctor reports whether launchd is running, whether the local config/plist
exist, whether ADC is present, whether the quota project is set, and how many
LiteLLM endpoints are healthy.

## Point Gemini CLI at the Proxy

After the proxy is healthy, route Gemini CLI through the local Vertex proxy in
the coworker's shell profile or terminal session:

```bash
export GOOGLE_VERTEX_BASE_URL="http://127.0.0.1:4000"
export GOOGLE_CLOUD_PROJECT="YOUR_GCP_PROJECT_ID"
export GOOGLE_CLOUD_LOCATION="global"
```

Keep this as local shell state. Do not commit a real project ID into repo docs,
templates, or tracked env files.

## Security Boundary

The repo must remain safe to share with coworkers. Keep these rules:

- Never commit `application_default_credentials.json`.
- Never commit `~/.gemini/proxy/config.yaml` after it has a real project ID.
- Never commit OAuth tokens, API keys, service-account JSON, bearer tokens, or
  copied home-directory paths from a specific operator.
- Use placeholders in docs/templates and let each operator render their own
  local files.

## Gemini CLI Routing

Gemini CLI should point at the local LiteLLM proxy only after the operator has
confirmed their auth path. The supported automation path is Vertex AI or Google
AI Studio API credentials. Do not piggyback another user's Gemini CLI OAuth
session into shared automation.
