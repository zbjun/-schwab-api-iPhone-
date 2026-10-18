# 2026-10-18 broker-held exits and timed orders deployment

Release `releases/exits-schedule-20261018` is active (built from commit `405850e`; tar SHA256 `a4f4d339…8eedc65`, kept in `/opt/ths-gateway/backups/`). It was activated at 21:12 CST on Sunday with the market closed. SSH access, Nginx, `/etc/ths-gateway/` and the unit file are unchanged.

- Adds `server/schedule.mjs` and the `schedule`/`scheduled`/`cancelScheduled` RPCs. Timed orders live in the existing encrypted vault under `ths.gateway.scheduled.v1` and are submitted once through `broker.submitQuick` under the gateway's shared write lock. An entry interrupted mid-submit becomes `unknown` and is never resent. An entry whose time passes while the service is down becomes `missed` and is never caught up. **Before any future restart, check `scheduled` for pending entries.** Also ships the OCO/TRIGGER/TRAILING_STOP exit rules, `freezeDraft` and the new sell-reservation rule in `mobile/src/orderRules.ts`, `broker.ts` and `types.ts`.
- 127 server, client integration and broker fixtures passed on the server's Node 24.21.0 before activation; locally 50 server and 314 mobile tests passed.
- Before restarting, both devices reported unresolvedOperation=false, the gateway had no open upstream connections, and `scheduled` returned `methodNotAllowed`. After a graceful stop/start, the scheduler loaded without warnings. Both devices report configured/authenticated, reauthorizationRequired=false and unresolvedOperation=false. `scheduled` now returns an empty list (0 entries). No timed orders were created, and no orders were placed, modified or cancelled.
- Rollback: `/opt/ths-gateway/backups/exits-schedule-20261018/previous-release.txt` records `releases/orderhistory-20261018`, which remains in place. Check `scheduled` first: timed orders stay in the vault but are not executed by the older code. Then stop the service, `ln -sfn releases/orderhistory-20261018 /opt/ths-gateway/current`, and start it again.

# 2026-10-18 order history deployment

Superseded by the record above; `releases/orderhistory-20261018` is now the rollback release. It was built from commit `4677ee2` (tar SHA256 `7b0b6007…ab4e9`, kept in `/opt/ths-gateway/backups/`). SSH access is unchanged: port 80 with the existing host key.

- Adds the read-only `orderHistory` RPC (one window of at most 60 days per call) for the phones' CSV fill export. Compared with the previous release, the only runtime changes are `server/gateway.mjs`, `mobile/src/broker.ts` and the type-only `mobile/src/types.ts`. Write paths, Nginx, config and the vault are unchanged.
- 117 server, client integration and broker fixtures passed on the server's Node 24.21.0 before activation; locally 42 server and 297 mobile tests passed.
- Before restarting, both devices reported unresolvedOperation=false and the gateway had no open upstream connections; the restart was on Sunday with the market closed. After a graceful stop/start, both devices report configured/authenticated, reauthorizationRequired=false and unresolvedOperation=false. A zero-argument `orderHistory` probe returns `invalidRequest` (it returned `methodNotAllowed` before), confirming the route without any Schwab call. No orders were placed, modified or cancelled; no real order-history read was performed.
- Rollback: `/opt/ths-gateway/backups/orderhistory-20261018/previous-release.txt` records `releases/optimization-20260928`, which remains in place. Stop the service, `ln -sfn releases/optimization-20260928 /opt/ths-gateway/current`, then start it again.

# 2026-09-28 optimization deployment

Superseded by the 2026-10-18 record above; `releases/optimization-20260928` is now the rollback release. The existing authorized SSH maintenance entry uses port **80** (`http-ssh-mux`); ports 22/2222 close before negotiation from this client. Use the existing verified host key and local SSH identity; no new access credential or persistence was created.

- Deployed the authorization retry fix, atomic quick RPC, shared account activity, incremental subscriptions, maintenance and encrypted minute archive.
- All 115 server, client integration and broker fixtures passed on the server's Node 24.21.0 before activation. Fixtures use fictional data only.
- Added exact `/activity` Nginx forwarding; `nginx -t` passed. The existing site remains reachable.
- A graceful stop/start preserved the encrypted vault and device keys. Both devices report configured/authenticated, reauthorizationRequired=false and unresolvedOperation=false after activation. `/activity` returns the expected authenticated method rejection for a read-only GET probe.
- Previous release `releases/latency-20260922` and the former Nginx locations file remain under `/opt/ths-gateway/backups/optimization-20260928/` for rollback. No real orders were submitted.
- Client 0.6.4 (11) device1/device2 packages were built and verified separately; this deployment does not update an installed IPA. Physical-device trading and live account-event entitlement remain unverified.

The records below describe earlier states, superseded by this deployment.

# 2026-09-28 authorization retry fix — source only, deployment blocked

The gateway previously retained its cached authorization URL for up to nine minutes when callback completion failed. The broker consumes pending OAuth state before token exchange, so a subsequent login could reuse an already consumed attempt. The source now evicts the cached URL after expired/declined attempts and exchange failures; an unrelated invalid callback still preserves the active attempt. Thirty server tests pass, including a regression that failed before the fix.

Live device status checks on September 28 returned configured=true, authenticated=false, unresolvedOperation=false for both devices. This does not establish the first failed exchange's cause. SSH port 22 accepted TCP then closed before the SSH banner over both the normal and configured proxy paths; no deployment/restart was performed. The fix is not yet confirmed on the live server. Do not present the source patch as deployed or authorization as complete.

# 2026-09-22 deployment update

Current release symlink selects `releases/latency-20260922`. This isolated update changes only broker `freshContext` scheduling: fresh-hash-dependent orders/replacement reads overlap accounts and quotes. Existing validation, write markers, gateway configuration and deployed history handling are preserved. The prior release `303757f` remains available for rollback. Both device status checks report authenticated with no unresolved operation; live account reads succeed. Before activation, 79 broker/server tests passed. Client background post-trade refresh is a separate source update and is not included in the existing 0.6.3 IPA. The following is the historical initial deployment record.

# Shared server deployment · 2026-09-10

The gateway is running at **<gateway-origin>**, using the existing domain and certificate. The existing website still serves `/`; exact `/rpc`, `/market` and `/oauth/callback` locations proxy to the new service. Phone clients use the origin only, without a path.

## Installed layout

- Host: `<gateway-host>`, Alibaba Cloud Linux 3, x86_64.
- Service: `ths-gateway.service`, enabled at boot, running as unprivileged `ths-gateway`.
- Code: `/opt/ths-gateway/releases/303757f`, selected by `/opt/ths-gateway/current`.
- Runtime: `/opt/ths-gateway/node` points to isolated Node v24.21.0. No system runtime or application dependencies were replaced.
- Config and encryption key: `/etc/ths-gateway/`, directory 0700, files 0600, owned by the service user.
- Encrypted vault and process lock: `/var/lib/ths-gateway/`, mode 0700.
- Listener: `127.0.0.1:8788` only. No public plain-HTTP listener was added.
- Nginx snippets: `/etc/nginx/snippets/ths-gateway-{locations,proxy}.conf`. Only one include was inserted into the existing HTTPS vhost `/etc/nginx/conf.d/<existing-site>.conf`; its original is backed up privately under `/opt/ths-gateway/backups/`.

Deployment templates are in `deploy/`. The service permits 75 seconds for graceful shutdown, retains the existing crash-lock safeguards, and limits memory to 384 MiB. Proxy retries and caching are off. OAuth query strings and device headers are not written to access/error logs for these locations. Do not strip Origin or add CORS: browser-origin RPC is intentionally rejected.

Node was fetched from the [official distribution](https://nodejs.org/dist/v24.21.0/) and verified against the [official SHA256 list](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt): `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` for `node-v24.21.0-linux-x64.tar.xz`. Exact-location forwarding follows the [Nginx proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

## Verified

- All 35 server/integration fixtures passed under the installed Linux Node runtime, with fictional brokerage data only.
- Two independent device keys each returned HTTPS 200 with configured=true, authenticated=false and unresolvedOperation=false. Requests from the Windows machine took about 78 ms each; these are local-state readiness calls, not brokerage order latency.
- The actual mobile `ServerBroker` class connected separately with both keys over public HTTPS.
- Missing key -> 401; browser Origin with a valid key -> 403; invalid OAuth callback -> 400. TLS certificate validation was enabled.
- Existing homepage -> 200; `nginx -t` passed; the gateway listener is loopback-only.
- A normal service restart preserved its key, encrypted vault and configuration and reacquired the process lock. Do not automatically remove locks after crashes; follow `README.md` recovery instructions.
- A distinctive fictional OAuth query probe was absent from the Nginx access/error log tails after the request. No real OAuth code or bearer token was used in the logging probe.
- Service active/running under `ths-gateway`; observed memory after readiness checks was approximately 50 MiB. This is not a production market-stream load measurement.
- An unauthenticated direct request from the server to Schwab returned HTTP 401, confirming connectivity (about 1.48 seconds total for that single probe).

## Remaining activation steps

The fresh server has the existing Client ID/Secret and is configured for **<gateway-origin>/oauth/callback**. At deployment verification it has **no Schwab account authorization**. The browser-control connection was unavailable, so the existing developer app's registered callback has not been changed or verified by this deployment.

1. Add the exact hosted callback in the existing Schwab developer app. Do not create another API app or change its credentials. The old loopback callback can remain registered for compatibility.
2. Use an updated App/Expo Go source build with Settings -> Schwab connection -> Server shared. The installed older IPA does not receive these source changes automatically.
3. Enter `<gateway-origin>` and that device's private key, then leave demo mode. Independent private device files were prepared locally under ignored `artifacts/server-device-configs/`, with restricted Windows ACLs; they are not in Git or the deployment tarball.
4. Stop direct-mode use on both phones, then complete one official Schwab login from one updated device. The hosted callback stores authorization on the server; return to the App and refresh. The other device can then refresh without its own Schwab login.

The authenticated brokerage paths, real shared market stream, and two physical phones remain unverified until this login and device migration are completed. No real orders or new IPA builds were performed.

## Operations

`systemctl status ths-gateway`, `systemctl restart ths-gateway`, and `journalctl -u ths-gateway` inspect/control this service. Keep config/key/vault outside source releases; update code using a new release directory, stop gracefully, change the `current` symlink, and start once. Never copy an old vault over a newer unknown-order marker. The Nginx include can be removed and configuration tested/reloaded to withdraw only these three routes.
