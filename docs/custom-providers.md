# Custom and local models

LearnHarness supports **any number of custom OpenAI-compatible endpoints, each with
multiple models**. Every endpoint is its own provider; everything below holds per endpoint.
The setup and Settings UI are based on PR #62 by Daniel Buckner and Abhishek Thakur.
Pi owns inference, message conversion, tools, streaming, and reasoning-effort handling.
For the separate external CLI provider, see [Claude Code](claude-code.md).

## Connect

1. Open **Settings → Providers → + Add a provider → Custom endpoint**. The same
   editor is available from the first-run provider picker. It is offered again
   for every further endpoint.
2. Name the endpoint, for example `LM Studio`. The name gives the endpoint its
   provider id (`lm-studio`), which model selections refer to; it cannot be a
   built-in provider's id or another endpoint's, and it never changes after.
   Renaming later changes only the label.
3. Enter the server's complete API base URL, for example
   `http://localhost:11434/v1`. LearnHarness does **not** append `/v1`.
4. Choose **Keyless** or **API key**:
   - **Keyless** never uses a saved or environment custom-provider key for
     authentication. Pi's OpenAI client receives an internal dummy credential.
   - **API key** uses the endpoint's effective key: `LH_ENDPOINT_<ID>_KEY`
     (`LH_ENDPOINT_LM_STUDIO_KEY`), or `CUSTOM_OPENAI_API_KEY` for the endpoint
     with id `custom` (an endpoint from before endpoints became a list). A real environment
     value wins over a file-saved value; the editor identifies environment ownership.
     Any nonempty trimmed custom key is accepted—there is no arbitrary length floor.
   - Changing the URL requires a new effective key or explicit consent to reuse
     the existing effective key. A key is never silently forwarded to a new URL.
     Clearing authentication selects Keyless.
5. Enter optional **model IDs**, separated by commas or whitespace. This supports
   servers whose chat endpoint works but whose `/models` endpoint is absent.
6. Choose how **thinking** reaches the server: `reasoning_effort` (the default,
   every effort level), `chat_template_kwargs.enable_thinking` (Qwen on vLLM /
   LM Studio) or top-level `enable_thinking` — these two are on/off only, the
   pickers show "on" — or never send thinking parameters.
7. Click **Connect**, then choose models for Strong, Cheap, and Vision.

A key is bound to the canonical endpoint URL and authentication mode. Changing the URL requires a new effective key or explicit consent to reuse it; it is never silently forwarded. Clearing authentication selects Keyless. Use this editor—not generic key management—to change custom credentials.

Connect requests `GET <base>/models` and, for a base URL ending in `/v1`, LM Studio's
`<root>/api/v0/models` (context lengths, vision, embedding models — those are left out).
vLLM's `max_model_len` counts as the context, also when an Open WebUI gateway nests it
under `openai`; llama.cpp's runtime context is read from `meta.n_ctx` (never `n_ctx_train`). With an on/off thinking format every model is taken to support thinking. Discovery metadata wins over duplicate manually
entered IDs. A nonfatal failed probe can fall back to entered IDs; a successful
fallback connect at the same URL preserves its previous model snapshot and pins.
Without entered IDs, the failed connect leaves existing configuration unchanged.
A different URL starts with its own models. **401/403 always fails**, even with
entered IDs. Response-size, model-count, and redirect violations also fail
explicitly rather than silently truncating or bypassing a discovery limit.

Discovery is not a continuous health or capability check. LearnHarness does not install a backend, download models, or perform custom-endpoint OAuth.

## Budgets and reasoning

Edit each model's pins offline:

| Setting | Resolution |
| --- | --- |
| Context budget | User pin → reported limit → **8192 fallback** |
| Maximum output | User pin → reported limit → **4096 fallback** |
| Reasoning support | User declaration → reported support |

Positive integer token pins are accepted, including small output limits; blank removes a pin. The editor labels reported, fallback, and pinned values. **These are request/compaction budgets, not commands to resize the backend's context.** Configure the server separately and match its active limits. Reconnecting prunes pins only to the resulting model IDs.

Reasoning support declares a capability; it does not enable execution. The normal Pi effort picker remains available, but **Off may not disable a backend's default thinking**. There is no model-name inference, Ollama preset, thinking-map/compatibility editor, or nonstandard-header editor.

## Images

All custom models are Vision-selectable; reported image-capable models appear first. Choose a backend that actually understands images.

Every custom-engine image-bearing request attempts delivery even when discovery omitted image support. This includes file reads, PDF pages, and visual previews. A request-local model allowance lets Pi encode images without changing the catalog's capability claims. Text-only servers may reject them; errors surface without silent text-only fallback. Payload delivery tests do not establish real-model image quality.

## Editing, credentials, and recovery

Nonsecret configuration is stored in `settings.json.customProviders`, one entry per
endpoint; file-saved credentials use the existing `auth.json` key seam. A reserved internal
string entry per endpoint, `__learnharness_custom_provider_binding:<id>` (without the
suffix for `custom`), binds authorization to the
endpoint, mode, and a random nonsecret `credentialBindingId` in its settings entry.
The file key and its binding are published in one existing atomic auth-map write.
The internal entry is not an environment variable or an editable/displayed key.
Neither keys nor raw upstream errors are returned by the custom-provider API.

If authorization is interrupted, reload and explicitly reconnect. An environment key changing endpoints does not authorize a shadowed saved key for that new URL. Disconnect prevents a latent environment key from reviving the provider. These are crash/restart guards, not a power-loss/fsync transaction guarantee.

Stale editor saves return **409**: reload and retry. Mutations preserve unrelated settings changes; failed edits do not claim success. Each new model operation resolves current endpoint, credentials, limits, and effort; in-flight requests keep their setup. Disconnecting/removing a model does not remap saved selections or rewrite history.

Discovery limits are **15 seconds**, **8 MiB**, and **10,000 models**; configuration bodies are bounded to **64 KiB**. Desktop capability/same-origin browser checks are not multi-user authentication.

## Pricing and older development configurations

Prices are **unknown/unpriced**, not $0—even for a local server. Internal zero rates are Pi-required placeholders; there is no rate editor. See [accounting](compaction-accounting.md).

The earlier unshipped `models.json` configuration is not read or migrated. Existing early development profiles need explicit endpoint configuration/reconnect and model reselection; files/history are not deleted or silently remapped.

## Maintainer entry points

The earlier, unshipped app-data `models.json` feature is retired and is **not read**.
No user file is deleted or renamed, and there is no importer, coexistence mode,
profile reset, history rewrite, or silent model remapping. Existing development
profiles need manual endpoint configuration and model reselection. Unbound early
GUI development configurations also require explicit reconnect/new-key entry or
the existing reuse-consent checkbox, even at the same URL; they are never silently
trusted or migrated. Custom endpoints speak the OpenAI-compatible protocol only. See [compaction and accounting](compaction-accounting.md)
for how context measurements and unpriced usage are displayed.

A `settings.json.customProvider` (one endpoint) becomes the `customProviders` entry
`custom` on the first start, keeping its binding. The fork's earlier `endpoints` list
becomes entries with the same ids, so model selections keep working; each one's
`LH_ENDPOINT_<ID>_KEY` is bound to its URL at that moment, since it already ran
against exactly that URL.

The HTTP surface is `GET /api/custom-providers` (every endpoint's status),
`POST /api/custom-providers` (add one) and `GET`/`POST`/`PATCH`/`DELETE`
`/api/custom-providers/<id>` (status, connect, offline edits of pins, thinking
format and name, disconnect), each mutation guarded by that endpoint's ETag.

## Implementation and regression references

- [Endpoint registration and discovery](../src/server/custom-provider.ts),
  [HTTP mutations/revisions](../src/server/custom-provider-http.ts), and
  [canonical URLs and budgets](../src/core/settings.ts).
- [Private authorization resolution](../src/server/custom-provider-auth.ts),
  [durable binding contract](../src/core/custom-provider-auth.ts),
  [request-boundary tests](../tests/custom-provider-boundaries.test.ts), and
  [crash/restart tests](../tests/custom-provider-restart.test.ts).
- [Per-operation engine resolution and image allowance](../src/agent/models.ts),
  [native payload/lifecycle tests](../tests/custom-provider-lifecycle.test.ts), and
  [Vision model filtering](../components/settings/model-menu.tsx). Synthetic image payload tests
  establish delivery, not real-model image-understanding quality.
- [Editor tests](../tests/custom-provider-ui.test.tsx) and
  [connect snapshot/pin tests](../tests/custom-provider-route.test.ts).
