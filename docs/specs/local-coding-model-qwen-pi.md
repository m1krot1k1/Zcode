# Recommended local coding model: Qwen3.8-27B-pi-adapted

Status: active (2026-11-23, release 3.17.164)

The product already supports any OpenAI-compatible local server through the ordinary
provider form. This note records the recommended open-weights coding model and the exact
serving contract so the app does not hide a model-specific adapter behind a second
runtime.

## Recommendation

- Base: `Qwen/Qwen3.8-27B`
- Adapter: `harness-hub/Qwen3.8-27B-pi-adapted` (LoRA, Apache-2.0)
- Recommended served model id: `qwen3.8-pi`
- Provider API: `openai-chat-completions`
- Local base URL: `http://127.0.0.1:8000/v1`
- API key: any non-empty local placeholder (`local`)

Why it is recommended: the pi adapter was trained with RL for tool-use efficiency. On
Terminal-Bench 2.1 it reaches 56.6% with thinking off, and on SWE-bench Pro it solves
64.7% with far fewer turns and tokens than the base model. The base model often hits the
100-step budget; the adapter finishes the same class of task in a handful of tool calls.
This is the same system-level principle used by `/start`: fewer, better-parallelized
calls beat a longer single chain.

The adapter needs the base weights (about 54 GB BF16; GGUF Q4 is about 17 GB) and a
serving engine. The app does **not** auto-download these multi-gigabyte weights in this
release; the user starts a local server and then adds it with the normal provider form.
The UI already accepts the OpenAI-compatible endpoint and model, and the local embedding
manager follows the same install-only-what-you-need rule.

## Provider preset

The built-in provider catalog now includes **Local OpenAI-compatible**
(`local-openai-compatible`). Creating it prefills:

- API format: `openai-chat-completions`
- Base URL: `http://127.0.0.1:8000/v1`
- Model: `qwen3.8-pi`

Open **Settings → Model providers → Add provider → Local OpenAI-compatible**, start the
server below, then test the connection. The API-key field accepts any local placeholder
(for example `local`); it is not sent anywhere except the local server.

## vLLM

```sh
vllm serve Qwen/Qwen3.8-27B \
  --enable-lora --max-lora-rank 32 \
  --lora-modules qwen3.8-pi=harness-hub/Qwen3.8-27B-pi-adapted \
  --language-model-only --enable-prefix-caching --mamba-cache-mode align \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --max-model-len 131072
```

Then add a provider:

- API format: `openai-chat-completions`
- Base URL: `http://127.0.0.1:8000/v1`
- Model id: `qwen3.8-pi`
- API key: `local`

## llama.cpp / GGUF

```sh
hf download ggml-org/Qwen3.8-27B-GGUF Qwen3.8-27B-Q8_0.gguf --local-dir .
hf download harness-hub/Qwen3.8-27B-pi-adapted-GGUF Qwen3.8-27B-pi-lora-F16.gguf --local-dir .

llama serve -m Qwen3.8-27B-Q8_0.gguf --lora Qwen3.8-27B-pi-lora-F16.gguf \
  --chat-template-kwargs '{"enable_thinking": false}' -c 65536 --port 9931 --alias qwen3.8-pi
```

Base URL: `http://127.0.0.1:9931/v1`; model id: `qwen3.8-pi`.

## Constraints

- Thinking off is the trained default. Turning it on increases tokens roughly 4x for at
  most a few additional solved tasks.
- The model uses the Qwen XML tool-call parser and the Qwen reasoning parser; a plain
  generic server that does not map tool calls will produce unusable tool blocks.
- The vision tower is not served in the evaluation setup; use text-only models for image
  inputs or a separate vision model.
- Context is 131,072 tokens in the reference vLLM command; the app's context assembly
  still enforces its own working-context ceiling.
- The adapter is a LoRA for Qwen3.8-27B and does not work with other base models.

## Acceptance

- A local OpenAI-compatible provider accepts `http://127.0.0.1:8000/v1` and
  `qwen3.8-pi` and appears in the Composer model list after a successful test request.
- The model can call ZCode tools (the provider uses the existing
  `openai-chat-completions` tool protocol); tool calls are not re-executed by ZCode.
- The app does not claim the model is installed or downloaded unless the user's server
  responds.

## Managed local Qwen3 in ZCode (3.17.164)

Settings → Model providers → Workspace intelligence → **Local model** now manages a
local chat model, not just embeddings:

- it installs the Ollama runtime once, downloads a Qwen3 model with `ollama pull`, and
  registers a personal `Ollama (local)` provider at `http://127.0.0.1:11434/v1`;
- the recommendation uses the Host's `totalMemoryBytes`: Qwen3 4B for 8+ GB,
  Qwen3 8B for 16+ GB, Qwen3 14B for 24+ GB, Qwen3 30B-A3B / Qwen3 Coder 30B-A3B for
  32+ GB;
- a custom Ollama model id can be entered (including a GGUF hub reference supported by
  Ollama);
- the downloaded model is added to the Composer model selector; prompts stay on the
  machine.

This managed path intentionally does **not** download the 54 GB Qwen3.8-27B-pi-adapted
weights. That adapter still requires the external vLLM/llama.cpp server above, so ZCode
cannot pretend the 27B model is installed or ready before the server answers.

Runtime verification: on release 3.17.163, `qwen2.5:1.5b` was installed through
Settings → Local model, registered as `Ollama (local)`, selected in the Composer, and
answered `ok` in about 4 seconds. The Ollama server is started when the Local model
settings open after an app restart; the installed-model list is read from Ollama
manifests without starting the server.
