# dsh-oauth

[简体中文](README.md) · English

Connect subscription accounts and plan keys to DeepSeek Harness, keep model configuration across restarts, and inspect the plan usage that each provider actually reports.

The package is **`@lks347/dsh-oauth@1.0.1`**, updated on 2026-11-16. See the [release notes](docs/RELEASE-1.0.1.md) for npm publication status. The existing sidebar, provider rows, and visual style are preserved; connection settings, model capabilities, plan details, and Chinese/English switching are added within that structure.

The implementation contains **23 provider definitions and 22 usage adapters**. Those are implementation counts, not a claim that every plan, region, organization, or real account has passed live acceptance. Some connections provide only quota information, some expose a public or installed model catalog, and some require a separate billing credential. See [connection details](docs/CONNECTIONS.md) and [validation and limitations](docs/VALIDATION.md).

## Install locally

Add the repository to the profile you intend to use:

```sh
dsh plugin --profile oauth add /path/to/dsh-oauth
dsh --profile oauth --port 3081
```

Use the OAuth page in Settings, or open `http://127.0.0.1:3081/oauth/` for the server started by this command. The official desktop application uses the `desktop` profile. Add a locally built package through its plugin manager, or use the CLI bundled with that installation:

```sh
dsh plugin --profile desktop add /absolute/path/to/lks347-dsh-oauth-1.0.1.tgz --offline
```

On macOS, the bundled CLI is at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`. Reload or restart when the host requests it, and confirm that the plugin is enabled. Editing or packaging this repository does not automatically replace the copy already installed in the desktop application.

The declared host range is `>=0.2.0-rc.2 <0.3.0-0`. This iteration tested DSH **0.2.0-rc.2 with pi-ai 0.87.1** and DSH **0.2.2-rc.3 with pi-ai 1.5.2**. Other combinations inside the declared range have not all been individually accepted.

## Connect a subscription

1. Open the OAuth panel and select the appropriate provider. The available actions reflect the host and provider integration. Use browser sign-in where the host supplies it, or **Connect key** for a supported subscription/API key.
2. In **Connection settings**, supply any separate usage-query credential and required region, organization, workspace, or project. Region is independent of the interface language; the default is `global`, with `cn` available where the provider supports it. Changing an endpoint or account scope removes the previously installed route so that it can be fetched again for the new scope.
3. Use **Fetch models** to inspect model IDs, input/output modalities, tool support, context and output limits, and reasoning levels when the source declares them. Select at least one chat model and save. Image/video models, where supported, remain media tools within the current conversation.
4. Use **Plan & usage** to request the provider's read-only quota or balance data. Opening the panel does not start a usage query, and refreshing usage does not send an inference request.

Passwords are not echoed back into the form or kept in browser storage. A blank usage-query credential field retains an existing saved credential. Chinese and English are selectable in the page and dialogs; the browser remembers only the UI language preference. Switching languages preserves in-progress form input and authorization steps.

Native OAuth uses the host authorization and credential services. Device codes, manual authorization input, cancellation, and popup blocking remain visible in the panel. xAI defaults to its browser PKCE route and retains an explicit device-code fallback. The formal `/oauth/` panel never substitutes a simulated successful login when the service or authorization fails.

### Reuse a local CLI authorization

The panel can reuse supported entries from **Codex** and **OpenCode** at fixed local locations. Availability is discovered by the server; the browser does not receive the source token or an arbitrary filesystem path.

- Codex: the supported ChatGPT token entry in `auth.json`, normally under `~/.codex/`, or the server's configured `CODEX_HOME`.
- OpenCode: the v1 provider dictionary in `auth.json`, or v2 saved credentials through the official CLI. OAuth renews in the source CLI.

This saves a reference to an **externally managed** source. The source CLI continues to own refresh and renewal. The plugin rereads the selected source when authorization is needed; it does not copy a refresh token into a competing refresh chain or rewrite the source CLI's file. If the source is removed, expires, or is too close to expiry, renew it in that CLI and retry. Ambiguous entries are rejected rather than silently choosing an account. One provider connection is active at a time.

OpenCode v2 lists credential metadata during discovery and exports the selected provider on demand. Set `DSH_OAUTH_OPENCODE_BIN` to the executable's absolute path if the DSH host cannot find it.

## Provider and evidence boundaries

“Account catalog” means an authenticated account endpoint returned the model. “Subscription catalog” means a subscription-specific endpoint returned it. Neither guarantees that a particular request will be permitted or funded. A public or installed catalog has **unknown plan entitlement**; the plugin does not spend tokens to test it.

| Provider definition | Model source or limitation | Usage adapter and important scope |
| --- | --- | --- |
| ChatGPT / Codex | Account catalog; native OAuth or supported local source | Account usage windows; account ID retained when available |
| Claude API | Account catalog via a Claude Console API key | Claude Code subscriptions and usage stay in the official client |
| GitHub Copilot | Account picker/policy and declared capabilities | Account usage; request counters and AI credits remain distinct |
| Kimi Code | Account catalog; host OAuth or plan key | Coding usage for the selected global/China endpoint |
| MiniMax | Installed host catalog; entitlement unknown | Plan remains endpoint; provider counters and units retained |
| Z.AI / GLM Coding Plan | Installed host catalog; entitlement unknown | Global/China quota; team queries require both organization and project IDs |
| Alibaba Cloud Token Plan | Installed host catalog; entitlement unknown | Personal Console Token Plan usage; separate Console credential and selected region |
| Google Antigravity | View the model catalog from the official AGY CLI | View subscription usage with `/usage` in AGY |
| Google Gemini CLI | **Quota only**; no model protocol integration in the tested host | Code Assist quota requires the authorized project and an eligible OAuth account |
| xAI Grok | Account catalog; browser PKCE or device fallback | CLI billing allowance and credits are separate measures |
| Nous Portal | Authenticated inference catalog; key connection | Portal OAuth account usage; an inference key alone is insufficient |
| Qwen Code subscription | Account catalog and existing subscription authorization | **No verified proactive remote quota reader**; remaining quota is unknown |
| DeepSeek API | API catalog; entitlement unknown | API account balance, not a consumer chat subscription allowance |
| OpenRouter | Account model catalog | Key budgets and spend; account balance may need a separate management key |
| NanoGPT | Subscription-specific model endpoint and inference channel | Subscription allowance windows; cash wallet balance is not queried |
| ZenMux | Public catalog; entitlement unknown | Management key required; subscription and PAYG results stay separate |
| OpenCode Go | Go-specific catalog | Workspace/member allowance; select the intended workspace |
| OpenCode Console / Zen | Catalog; entitlement unknown | Workspace budgets; not a claim to expose the complete workspace wallet |
| Kilo Gateway / Pass | Catalog; entitlement unknown | Credit and Pass data; personal/organization scope matters |
| Poe | API catalog; entitlement unknown | Combined point balance; subscription/top-up split or reset may be unavailable |
| Synthetic | Catalog; entitlement unknown | Plan allowance; incremental recovery is not a full reset |
| Chutes | Catalog; entitlement unknown | Subscription allowance; PAYG-equivalent allowance is not a wallet balance |
| New API gateway | Catalog from an explicitly configured deployment; entitlement unknown | Deployment token quota in its original units, not an assumed USD balance |

For Google, a compatible OAuth entry already present in a supported legacy OpenCode file may be reused for quota queries. That does not add a Google login implementation or model transport to a host that lacks them. The plugin does not onboard a Google project or scan an IDE's local language server. A missing project, unsupported OAuth client, or insufficient permission is not interpreted as zero remaining quota.

Alibaba Cloud support here is the **personal Console Token Plan** query path. It does not claim team/RAM coverage, legacy Coding Plan equivalence, or PAYG fallback. The model key cannot replace the Console query credential. MiniMax, Z.AI, and Alibaba model choices come from the installed host catalog; the panel labels their plan entitlement as unconfirmed.

For Nous, configure the inference key for model access and a compatible **Portal OAuth access token** as the separate usage-query credential when required. This field does not establish a new Portal login or own its refresh lifecycle. Monthly, purchased, rollover, and total usable credits may overlap; do not add total usable credits to its components.

For New API, supply the trusted public HTTPS API root, including `/v1`. The explicit deployment receives the model key. The usage adapter preserves the deployment's quota units and does not invent a conversion to USD. A gateway with a different usage contract is reported as unavailable rather than estimated.

## Read usage accurately

The panel displays the provider's plan label, independent windows, balances, scope, source, observation time, and last query time. A snapshot is an observation at that time, not a continuously live balance.

- Windows keep their own units: percentages, requests, tokens, credits, points, currency, or deployment quota. They are not combined into a universal “tokens left” value.
- An unknown percentage stays unknown and has no fabricated zero-percent meter. A limit without a used/remaining value is still a limit, not proof of a full allowance.
- Subscription renewal, quota reset, and partial regeneration are different timestamps. The UI does not mark an incremental refill as a full reset.
- `partial` retains the fields that were actually returned. `stale` labels a previous successful snapshot after a transient refresh failure; its original observation time remains visible.
- Permission/configuration failures, required reauthorization, query rate limits, unsupported readers, and temporary unavailability remain separate from an exhausted allowance. A 429 response does not establish how much subscription quota is left.
- The service binds cached results to the credential and account scope. Disconnecting, replacing authorization, or changing scope cannot revive an older in-flight result for a different connection.

Model-access and billing permissions can differ. For example, a ZenMux management key or Alibaba Console token is separate from the model credential. An OpenRouter management balance can belong to its own account scope; it must not be assumed to describe another model key. These credentials are used for their designated endpoints, not sent to arbitrary model hosts.

## Keep model configuration across restarts

**Keep enabled** is the default. It saves `expiresAt: null` for the model configuration. You can still choose a future expiry, up to 366 days. Existing records with a deadline keep that deadline; upgrading does not silently make them permanent.

This setting controls model configuration, not OAuth lifetime. Closing the panel or restarting the plugin does not intentionally delete saved authorization. Tokens can still expire or be revoked, subscriptions can change, and some connections still require signing in again. There is no promise of permanent login.

Native OAuth and connected keys use the host credential service. A typical desktop installation uses `DSH_HOME/.credentials.yaml`, normally `~/.dsh/.credentials.yaml`. Profiles sharing the same `DSH_HOME` can share credentials, so **Disconnect** can affect another profile using that credential. Locally reused CLI authorization remains owned by the source CLI.

Model pull records and usage snapshots are profile-specific. They are stored under the profile directory as `dsh-oauth-pulls.json` and `dsh-oauth-usage.json`; these JSON records do not contain access or refresh tokens. Expiring a model configuration does not expire or delete the account authorization. Cleanup restores only configuration that still matches the plugin's installed values, preserving later manual edits.

The older `DSH_HOME/dsh-oauth-pulls.json` has no profile identity. It is not automatically migrated or used to clean another profile. Fetch models again in the intended profile when moving from that legacy layout. See [connection and persistence details](docs/CONNECTIONS.md).

## Develop and validate

Use the dependencies from the DSH installation being tested. `--from` points to the runtime installation containing `node_modules`; the linking script modifies only this repository's links and refuses to overwrite the real installation.

```sh
npm run link:peers -- --from /absolute/path/to/dsh-runtime
npm test
npm run verify:host -- --runtime /absolute/path/to/dsh-runtime
npm run verify:persistence -- --runtime /absolute/path/to/dsh-runtime
npm run verify:browser
npm run verify:subscriptions -- --out-dir artifacts/subscriptions-ui
npm run check:upstreams -- --out artifacts/upstream-check.json
```

The completed local validation for this iteration includes:

| Validation | Evidence scope |
| --- | --- |
| 292 unit tests | Parsing, scope, transport, credentials, authorization, models, and lifecycle behavior |
| Host integration on DSH 0.2.0-rc.2 / pi-ai 0.87.1 and DSH 0.2.2-rc.3 / pi-ai 1.5.2 | Real Cordis, authorization, tools, client slot, and model configuration schemas with mocked provider responses |
| Six independent persistence processes | Real `dsh-credentials-local` 0.2.2-rc.3 storage; credentials, permanent models/capabilities, quota snapshots, renewal, and expiry separation |
| 19 subscription UI scenarios and 11 existing OAuth scenarios | Real Chromium; local mock endpoints; Chinese/English, narrow screens, keyboard handling, connection settings, quota states, and existing authorization flows |

The offline checks were followed by live acceptance using existing Codex, OpenRouter, and xAI authorization. Their catalogs returned 6, 433, and 6 models respectively; two chat models per provider were imported. A second independent process restored identical saved capabilities and configuration, then successfully queried the real catalogs and usage services again. OpenRouter returned key usage and budgets; account-wide balance remained explicitly unavailable without Management permission. The local Codex and OpenCode source files were unchanged. No paid inference was sent, and the user's daily desktop profile was not restarted or modified. See [live acceptance](docs/LIVE-VALIDATION-1.0.1.md). This does not establish indefinite renewal or live acceptance of every other provider and plan.

`verify:browser` and `verify:subscriptions` require Playwright/Chromium; `DSH_PLAYWRIGHT_MODULE` can point to the Playwright module directory. `verify:persistence` uses temporary credential/profile directories. If the selected runtime lacks `dsh-credentials-local`, supply an independently prepared matching package with `--credentials-local /absolute/path/to/package`, as described in that script.

Opening `index.html` directly runs the explicitly labeled static example. It does not confirm real authorization. `DshOAuth.setLoginOpener()` and `onAuthorize()` are preview-only; the hosted `/oauth/` panel uses the server API.

## Implementation and references

The local implementation is split into [provider metadata](src/catalog.js), [fixed local sources](src/local-imports.js), [model capabilities](src/models.js), [connection storage](src/connections.js), and [usage readers/cache](src/usage/index.js). Provider-specific details are in [official readers](src/usage/official.js) and [aggregator readers](src/usage/aggregators.js).

The design was checked against official implementations and community readers, including these pinned sources:

- [OpenCode provider authentication and workspace handling](https://github.com/anomalyco/opencode/blob/26f2522e60a924b8bad95725ede56b55281fb46c/packages/core/src/plugin/provider/opencode.ts) and [usage limits](https://github.com/anomalyco/opencode/blob/26f2522e60a924b8bad95725ede56b55281fb46c/packages/core/src/usage-limits.ts).
- [Hermes account-aware usage caching](https://github.com/NousResearch/hermes-agent/blob/611f0ab757b307774c4a63c7b19f67d1f3aa6f6e/agent/account_usage_cache.py) and [Nous Portal account handling](https://github.com/NousResearch/hermes-agent/blob/f8acc26834bf1275c34d09ccc3e51250bcd1e26b/hermes_cli/nous_account.py).
- [CodexBar provider architecture](https://github.com/steipete/CodexBar/blob/1f6da9bec44455288ddee5ef6f3617a803d8eb2a/docs/provider.md) and [Antigravity source distinctions](https://github.com/steipete/CodexBar/blob/1f6da9bec44455288ddee5ef6f3617a803d8eb2a/docs/antigravity.md).
- [Official Gemini CLI quota request](https://github.com/google-gemini/gemini-cli/blob/4ed06ed0ddc523a6d356a4ad35ddfea331041888/packages/core/src/code_assist/server.ts), [MiniMax quota interpretation](https://github.com/MiniMax-AI/cli/blob/ae29aae57b05c2140c7ea6aba0a852763ffe7859/src/utils/quota.ts), and [Alibaba Token Plan usage command](https://github.com/modelstudioai/cli/blob/98ceadc00e00bd5043f266ba3781268e6b83b12f/packages/commands/src/commands/usage/token-plan.ts).

These references explain protocol and lifecycle decisions; their feature lists are not claims about functionality already implemented here. In particular, this worktree implements neither Hermes local credential import nor every alternative quota source offered by CodexBar.
