# vision-agent (Vision MCP server)

An MCP server plus a Node service that lets a Hermes agent (profile `vision`) annotate video clips on a LAN GPU
box with `dell-annotate`: segmentation, pose, relations, 3D reconstruction, renders and a written
description, with results copied back locally and shown in a keyless LAN viewer.

## Tools

`start_job`, `segment`, `pose`, `relations`, `reconstruct_3d`, `render`, `describe`, `finish`,
`show_job`, `list_jobs`, `cancel_job`.

Stages already done are never re-run, queued or running stages are waited on, and GPU jobs queue and are never
cancelled from here (see [dell-annotate-client](https://github.com/mohammedterryjack/dell-annotate-client)).

## How it runs

- `mcp.js`: stateless stdio MCP server started by Hermes; forwards calls over an owner-only unix socket.
- `service.js`: systemd **user** service (`systemd/vision-agent.service`); stores outputs in `~/vision/<job_id>/`
  and serves `/v/<token>/` on the LAN. Requires `~/Code/dell-annotate-client`.

```yaml
# Hermes profile config.yaml
mcp_servers:
  vision:
    command: /usr/bin/node
    args: [/home/<you>/Code/vision-agent/mcp.js]
    timeout: 2400
```

## Dependencies

Node.js 20+ (no npm packages), ffmpeg, [dell-annotate-client](https://github.com/mohammedterryjack/dell-annotate-client)
cloned to `~/Code/dell-annotate-client`, and the GPU box's dell-annotate service and chat model.

## Configuration (environment)

Copy `.env.example` to `.env` (the systemd unit loads it with `EnvironmentFile`).

| Variable | Default | Meaning |
|---|---|---|
| `VISION_DIR` | `~/vision` | job outputs |
| `VISION_SOCK` | `~/.hermes/vision-agent/worker.sock` | service socket |
| `VISION_BIND` / `VISION_PORT` | (required) / `8647` | LAN viewer |
| `VISION_ENV_FILE` | `~/.hermes/profiles/vision/.env` | holds `DELL_LLM_API_KEY`, read per request |
| `DELL_ANNOTATE` | (required) | dell-annotate |
| `DELL_LLM` / `DELL_LLM_MODEL` | (required) / `Qwen3.8-Flash-Next-UD-IQ4_XS` | model for `describe` |
| `VISION_CALL_TIMEOUT_MS` | 40 min | MCP call timeout |

LAN addresses have no defaults: set them in `.env` (copy `.env.example`); the service fails loudly if one is missing. No keys are in this repo.
