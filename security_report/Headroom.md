# Headroom security review

Review date: 20 October 2026  
Version reviewed: Headroom 0.41.0  
Environment: the installed Linux package under `/opt/headroom`, using Python 3.10.12

## Conclusion

The review found no affirmative evidence of a deliberate backdoor or local tampering. All 580 installed Headroom payload files matched the official PyPI wheel, including its compiled extension.

Headroom does communicate externally. Its default behavior includes a usage beacon, version checks and downloads of missing model or tokenizer files. When used as an LLM proxy, it sends conversation content to the configured provider. The inspected beacon payload did not contain raw prompts, source code or file contents.

The review identified three code-level vulnerabilities. The most serious on a shared machine is an authentication bypass for loopback callers: another local account can access administrative settings and change where later provider requests are sent. Optional HTTP MCP file access and plaintext forwarding of configured secret headers introduce further risks under the conditions described below.

These results do not certify Headroom as backdoor-free. Matching a published wheel establishes which release is installed; it does not establish that every component of that release is trustworthy. Most native code was not reverse-engineered, dependency authenticity was not independently established for every package, and cached model provenance remains unverified.

No remediation remains applied. Earlier temporary hardening was removed before the expanded audit. The user chose to leave the installation unchanged.

## Scope and method

The review covered the installed Headroom source, its launchers and startup mechanisms, outbound communication paths, authentication and administrative access, and relevant local configuration. It also checked installed-file integrity, compared Headroom against its published wheel, inventoried native components and queried public dependency advisories.

Source checks included isolated execution of authentication and destination-trust functions with synthetic inputs. The expanded audit did not start Headroom services or send exploit requests to external systems. Public PyPI artifacts and GitHub advisories were retrieved for verification.

The source references below use this installation root:

```text
/opt/headroom/lib/python3.10/site-packages/
```

Line numbers refer to the installed 0.41.0 release and may change in another version. Process and configuration observations describe the time of inspection. They are not continuous monitoring.

## Security findings

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟠 HIGH | `headroom/proxy/server.py` | 4124-4151, 4562-4675 | Loopback authentication bypass permits administrative changes and redirection of later provider traffic. | 10/10 |
| 2 | 🟠 HIGH | `headroom/ccr/mcp_http.py`; `headroom/ccr/mcp_server.py` | 32-78; 999-1038 | Optional HTTP MCP transport exposes unrestricted file reading when the read tool is enabled. | 9/10 |
| 3 | 🟡 MEDIUM | `headroom/proxy/upstream_trust.py`; `headroom/proxy/helpers.py` | 113-126; 2080-2094 | Hostname-only trust can attach operator-configured secret headers to a plaintext HTTP destination. | 9/10 |
| 4 | 🟡 MEDIUM | `pip-22.0.2.dist-info/METADATA` | Version metadata | Installed pip matches multiple installation-related security advisories. | 9/10 |

Severity reflects the impact under the stated preconditions. Confidence reflects the supporting evidence, not the probability that someone has exploited the issue.

### 1. Loopback callers bypass authentication

The HTTP security middleware exempts loopback callers from `HEADROOM_PROXY_TOKEN` authentication. On a shared Linux host, loopback identifies a network origin, not an operating-system user. Another local account can therefore reach the same listener without knowing the configured token.

The settings endpoints accept a loopback peer with a loopback Host header and allow changes to Anthropic and OpenAI upstream URLs. Those changes can redirect subsequent conversations and applicable provider authentication headers after a restart, unless explicit environment settings override them. A supervised deployment can also expose the settings-apply endpoint that initiates a restart.

Synthetic checks of the installed authentication function accepted a loopback request without a token and rejected a non-loopback request without one. The HTTP gate also accepted a loopback request with an attacker-domain Host header. That inconsistency can contribute to DNS-rebinding exposure where browser and network protections allow it; no browser exploit was performed.

The shared-host impact supports the High rating. Exploitation requires a running, reachable proxy. The code treats loopback as trusted explicitly, so this finding does not establish a concealed or deliberately malicious backdoor.

Additional references:

- WebSocket loopback exemption: `headroom/proxy/server.py:3023-3035`.
- Configurable provider destinations: `headroom/settings_store.py:731-749`.

### 2. Optional HTTP MCP transport can expose local files

The MCP HTTP application passes requests to the session manager without authentication middleware or explicit transport-security settings. The installed SDK disables its DNS-rebinding protection when those settings are omitted.

If `HEADROOM_MCP_READ` is enabled, the `headroom_read` tool accepts an absolute path and reads it without restricting access to approved directories. A client that can reach the HTTP endpoint can establish its own MCP session and request files readable by the Headroom account.

On a loopback listener, this can expose files to another local user. A network-accessible bind can expose the same capability remotely.

The required configuration was not active during inspection: the observed MCP process used stdio, `HEADROOM_MCP_READ` was unset, and no listener on port 8788 was observed. This is a conditional vulnerability, not evidence that files were being exposed.

Additional references:

- Read-tool enablement and registration: `headroom/ccr/mcp_server.py:84-92,755-771`.
- SDK transport-security default: `mcp/server/transport_security.py:47-50`.

### 3. Configured secret headers can be sent without TLS

Headroom decides whether a destination may receive operator-configured secret headers by comparing its hostname. The client-controlled `x-headroom-base-url` path also accepts plain HTTP.

Isolated checks classified `https://api.openai.com`, `http://api.openai.com` and `http://api.openai.com:8080` as trusted. The request path can then attach configured gateway or API-key headers to the selected origin.

Exploitation requires configured secret extra headers, access to the proxy and an attacker able to observe or intercept the plaintext connection. The review did not send such a request. An HTTPS-only origin allowlist prevents this particular downgrade path.

Related request handling: `headroom/proxy/handlers/openai.py:454-472,5632-5640`.

### 4. pip has installation-related advisory matches

All 176 installed package versions were queried against GitHub's public advisory database. Seventeen earlier successful queries were reused and the remaining 159 completed without failures or uncovered packages.

Only pip 22.0.2 returned matches: seven advisories, six rated Medium and one Low. These concern package installation and download operations. They do not demonstrate exploitation during normal Headroom proxy use.

| Advisory | Severity | Relevant condition |
|---|---|---|
| [CVE-2026-13346](https://github.com/advisories/GHSA-qwm4-qh6w-59xr) | Medium | A malicious package index supplies doubly encoded package URLs. |
| [CVE-2026-8643](https://github.com/advisories/GHSA-wf93-45jw-7689) | Medium | A package supplies entry-point names that traverse outside the installation directory. |
| [CVE-2026-6357](https://github.com/advisories/GHSA-jp4c-xjxw-mgf9) | Medium | A wheel supplies module names subsequently imported during pip self-update checking. |
| [CVE-2026-3219](https://github.com/advisories/GHSA-58qw-9mgm-455v) | Medium | An installation archive can be interpreted as both tar and ZIP. |
| [CVE-2026-1703](https://github.com/advisories/GHSA-6vgw-5pg2-w6jp) | Low | A malicious wheel uses path traversal during installation or extraction. |
| [CVE-2025-8869](https://github.com/advisories/GHSA-4xh5-x5gv-qwph) | Medium | Unsafe fallback tar extraction. The reported Python 3.10.12 version meets the advisory's mitigation threshold; that runtime protection was not independently exercised. |
| [CVE-2023-5752](https://github.com/advisories/GHSA-mq26-g339-26xf) | Medium | An attacker-controlled Mercurial revision reaches an `hg+` installation operation. |

Configured exploitability was not established. The other 175 packages returned no matching records from this database query. Unpublished vulnerabilities, missing advisory coverage and unsafe package behavior remain possible.

## External communication and data handling

| Channel | Behavior and conditions | Data involved |
|---|---|---|
| LLM provider requests | Proxy requests go to the configured provider, normally Anthropic or OpenAI, or an operator-selected gateway. | Conversation and tool context needed for inference, after applicable optimization, plus applicable provider authentication. |
| Headroom usage beacon | Enabled by default. Posts to `https://headroom-beacon.headroom-beacon.workers.dev/v1/logs`. | Persistent installation and session identifiers, usage and savings counters, timing, platform information and bounded configuration classifications. |
| Version checks | CLI startup can check `https://pypi.org/pypi/headroom-ai/json`, at most daily. | A version-check request; the inspected path does not itself perform an upgrade. |
| Model and tokenizer downloads | Missing cached artifacts can trigger downloads from Hugging Face or OpenAI's public tokenizer storage. | Artifact requests and downloaded model or tokenizer files. |
| Subscription and authentication helpers | Can contact Anthropic, ChatGPT or GitHub when the relevant integration and authentication are available. | Applicable authentication and usage requests. |
| Optional cloud compression | Configured Headroom Cloud integrations or a remote Kompress endpoint can receive compression inputs. | Actual content submitted for compression. |
| Optional reporting and exporters | Licensed usage reporting, OTLP and Langfuse depend on their respective configuration and enablement. | Usage or observability data defined by the enabled integration. |

The inspected beacon construction did not upload raw prompts, code or file paths. Its persistent identifier still permits correlation between reports, and the receiving service can observe the source IP. This review did not independently establish the recipient's retention policy or downstream handling.

The dashboard template inspected during the review loaded its JavaScript locally and polled local endpoints. No automatic remote-dashboard upload was identified in that template.

Local retention is a separate concern. Context retrieval can retain original tool content, and optional request logging can retain message bodies. Full-message logging defaults off. These local stores are not evidence that the beacon transmits their contents.

Source references:

- Beacon defaults: `headroom/telemetry/beacon.py:31-92`.
- Beacon identifiers, payload and destination: `headroom/telemetry/session.py:624-675,793-892,1713-1758`.
- Version checks: `headroom/update_check.py:36-70,210-234`.
- Optional cloud compression: `headroom/integrations/asgi.py:80-86,220-245`.
- Licensed usage-reporting enablement: `headroom/proxy/server.py:1520-1533`.

### Offline mode has exceptions

`HEADROOM_OFFLINE=1` blocks many Headroom-initiated reporting and download paths. It deliberately permits forwarding user requests to the configured upstream. An external provider therefore remains external in offline mode.

The review also identified dependency-level caveats: a missing tiktoken vocabulary can trigger a download outside Headroom's own guard, and LiteLLM can fetch a remote pricing map unless configured to use its local map. A no-external-traffic requirement needs a local inference endpoint and enforced outbound network restrictions.

References: `headroom/offline.py:19-35,166-201`, `headroom/tokenizers/tiktoken_counter.py:116-134`, `tiktoken/load.py:13-18`, and `litellm/litellm_core_utils/get_model_cost_map.py:621-660`.

## Package integrity and provenance

The installed launcher is `/usr/local/bin/headroom`, a symlink to `/opt/headroom/bin/headroom`. Its interpreter is `/opt/headroom/bin/python3`, linked to `/usr/bin/python3`. The launcher invokes `headroom.cli:main`.

### Comparison with the official wheel

The published metadata came from [PyPI's Headroom 0.41.0 release API](https://pypi.org/pypi/headroom-ai/0.41.0/json).

| Measurement | Result |
|---|---|
| Wheel | `headroom_ai-0.41.0-cp310-abi3-manylinux_2_28_x86_64.whl` |
| Download size | 15,642,717 bytes |
| Installed payload files compared | 580, including 569 Python files and `_core.abi3.so` |
| Uncompressed payload compared | 40,040,922 bytes |
| Missing or mismatched payload files | 0 |
| Extra non-bytecode files in the Headroom package | 0 |

The downloaded wheel matched PyPI's published SHA-256:

```text
f4db5e5119a73af3ed952b1c10caff2430831d899eb17d995a27574ae6e6b306
```

This comparison did not reproduce the native build from source or verify the publisher account's security.

### Installed dependency files

| Measurement | Result |
|---|---|
| Installed distributions checked | 176 |
| RECORD rows checked | 67,218 |
| Rows with matching hashes and sizes | 43,547 |
| Expected unhashed RECORD or bytecode rows | 23,665 |
| Initial hash and size mismatches | 6 |
| Missing files or RECORD files | 0 |
| Unexpected unhashed rows | 0 |

Five mismatched scripts matched their recorded hashes after reconstructing only the original `#!python` shebang. The remaining mismatch was NumPy bytecode whose decoded code object equaled a fresh compilation of its RECORD-verified source. That comparison compiled source without executing it. No unexplained mismatch remained.

An attacker with permission to replace installed files may also replace their RECORD metadata. The independent PyPI comparison above covered Headroom itself; it did not authenticate every dependency artifact.

LiteLLM 1.106.0 records installation from a local wheel in a historical temporary directory. Its `direct_url.json` contains no archive hash or repository revision. That leaves a provenance gap, with no affirmative evidence that the wheel was malicious.

### Startup hooks and native components

The inventory found 47 console entrypoints across 37 distributions, no editable-install metadata and no `.egg-link` files. All 176 distributions recorded pip as their installer.

The two venv `.pth` startup files were the setuptools distutils shim and a coloredlogs hook that runs conditionally when `COLOREDLOGS_AUTO_INSTALL` is set. No venv `sitecustomize.py` or `usercustomize.py` was found. System-interpreter integrity and process-environment injection were not comprehensively assessed.

Native inspection covered an inventory of 850 executable or native-file candidates, including 708 ELF files. `readelf` completed for 703 ELF files; five large Triton, Torch and NVIDIA libraries exceeded the inspection timeout. Strings screening covered six prioritized binaries, including Headroom's compiled extension. No supported evidence of malicious behavior emerged from those checks. Strings and linkage metadata cannot establish what all native code does.

The Hugging Face cache contained model payload references for `chopratejas/kompress-v2-base` and `convaiinnovations/laya`. Their authenticity and contents were not verified, and their presence does not establish that Headroom loaded them.

## Recommendations, not applied

Authenticate loopback clients and administrative operations. On a shared host, use per-user transport isolation rather than assuming that a loopback connection belongs to the service owner.

If HTTP MCP is required, add authentication and explicit Host/Origin protection. Restrict file-reading tools to approved directories and give that capability only to clients that need it.

Authorize secret headers against an exact approved origin, including scheme and port. Reject plaintext downgrades before attaching those headers.

Review pip upgrades before further package installation. For privacy-sensitive use, separately decide whether the beacon, cloud compression and other reporting integrations are acceptable. A strict provider-only or offline policy should be enforced at the network boundary.

These are recommendations only. The installation was left unchanged.

## Supporting evidence

Machine-local audit artifacts were kept on the audit machine.

| Evidence | Contents |
|---|---|
| `wheel-comparison.json`, `headroom-pypi.json` | Published artifact metadata, wheel hash and per-file Headroom comparison. |
| `provenance-local.json`, `installed-distributions.txt`, `console-entrypoints.json` | Installed-package inventory, RECORD checks, startup metadata and entrypoints. |
| `record-mismatch-followup.json`, `numpy-bytecode-followup.json` | Explanations for the six initial integrity differences. |
| `native-inventory.json`, `native-linkage.json`, `native-strings-summary.json` | Native-file inventory and the results and limits of binary inspection. |
| `cache-coverage.json` | Cache inventory and model payload references. |
| `dependency-advisories-complete.json` | Merged public advisory query results. |
| `dependency-advisory-coverage.json`, `dependency-advisory-matches.json` | Exact query coverage, matched advisories and exploitability caveats. |

The evidence files are not bundled with this README and require access to the original machine. This report records a point-in-time review of Headroom 0.41.0; later updates or configuration changes need a fresh assessment.
