> Server address placeholders: `<gateway-origin>` (HTTPS domain), `<gateway-host>` (server address) and `<existing-site>.conf` (existing Nginx vhost). The real values are kept only in the git-ignored `.secrets/deploy-target.md` on the maintenance computer; never commit them.

> Git history was rewritten on 2026-10-18 to remove the server address. Commit IDs in the records below predate the rewrite; server release directories keep those names. Old → new: `405850e` → `15c1607`, `4677ee2` → `9a305c4`, `303757f` → `499f722`, `cc19367` → `00c5c19`, `050067f` → `85559d2`.

> MEXC gateway placeholder: `<mexc-host>` (server address). It has no domain, so the app connects to `https://<mexc-host>`. The real value is kept only in the git-ignored `.secrets/mexc-target.md`; never commit it.

# MEXC futures gateway (running since 2026-11-02, no real order placed yet)

A gateway for MEXC USDT perpetuals on its own host. It holds no Schwab credentials and shares nothing with the Schwab gateway: its own process, vault, device keys and unknown-outcome marker, so neither can lock the other.

- **Current state:** see the record at the end of this section. Another unrelated service runs on this host; this deployment does not touch it. Host details are in `.secrets/mexc-target.md`. `ths-mexc-gateway.service` refuses to start while the API key is still the placeholder.
- **Layout:** releases in `/opt/ths-mexc/releases/<name>` with a `current` symlink, Node in `/opt/ths-mexc/node`, vault and process lock in `/var/lib/ths-mexc/` (0700), config and encryption key in `/etc/ths-mexc/` (directory 0700, files 0600, owned by the `ths-mexc` service user).
- **Setup:** `node server/mexcInit.mjs /etc/ths-mexc` creates `mexc.config.json` and `mexc-vault.key` with fresh device tokens and never overwrites existing files. Set `dataDirectory` to `/var/lib/ths-mexc`. Install `server/deploy/ths-mexc-gateway.service`. Nginx uses `server/deploy/ths-mexc-http.conf` and `ths-mexc-https.conf`, with `ths-mexc-locations.conf` in `/etc/nginx/snippets/`. `/rpc` is the only proxied route, and port 80 serves only certificate challenges. The Lightsail firewall must allow TCP 80 and 443.
- **Certificate:** Let's Encrypt issues to the IP address with the `shortlived` profile, valid about six days, using lego 5.6.0 (`/opt/ths-mexc/lego`, checksum verified) over HTTP-01. `ths-mexc-cert-renew.timer` checks every six hours and lego renews once half the lifetime has passed. After every check `ths-mexc-cert-deploy.sh` compares the files and, if they differ, copies them to `/etc/ths-mexc-tls/` and reloads Nginx, which does not touch the gateway process. Install it owned by root with mode 0755. Check with `systemctl list-timers ths-mexc-cert-renew.timer` and `journalctl -u ths-mexc-cert-renew.service`; that log contains the address, so never paste it anywhere. If the certificate expires, the app cannot connect and sends nothing; positions and resting orders stay on MEXC. There is no alert yet when renewal keeps failing. If the IP changes, update `/etc/ths-mexc-tls/lego.env`, the API key's binding and the app's connection.
- **API key:** the account owner creates it and writes `apiKey` and `apiSecret` into the config on the server themselves; it never passes through chat, the repository or the phone. Bind it to `<mexc-host>`. Grant contract account read, contract order read and order placing. Never grant transfer or withdrawal. Order placing requires KYC on the account.
- **Key check:** with `keyCheck: true` (the default) the gateway reads the key's own settings through `apiKeyInfo`, which also needs spot account read. If the key has no IP binding, can move money or has any other permission, reads keep working, new orders are refused, and `status` reports why in `tradingBlocked`. If the lookup itself fails, opening is refused but closing stays possible. Cancelling is never blocked. This host runs `keyCheck: false` at the owner's decision, because the owner keeps spot access off the key: nothing checks the binding or permissions automatically, so changing them at MEXC is the owner's responsibility.
- **Limits:** `limits.maxLeverage`, `limits.maxOrderNotional` (USDT per opening order) and `limits.marketProtection` live in the server config and the app cannot change them. Changing them takes a restart.
- **First activation:** run all tests on the server's Node in the staged release and confirm the host can reach MEXC. With `keyCheck: false`, `status` always reports authenticated and proves nothing about the key, so the account read is what shows it works. Before the first real order the owner confirms on the MEXC page that the key is bound to `<mexc-host>`, has no transfer or withdrawal permission and has no spot permission. Nothing here places an order. The first real order is placed by the owner in the app.
- **Before any restart:** both devices must report `unresolvedOperation=false`. Keep the previous release for rollback and add a record here using only placeholders.
- **Rollback:** releases older than `mexc-keycheck-20261102` ignore `keyCheck`, so they keep checking the key, cannot read its settings, refuse opening orders and allow closing ones.
- **Record, 2026-11-03, second release:** `releases/mexc-stops-20261103` is active, built from commit `bbac735` (tar SHA256 `d9f38f742a96be23…`, kept in `/opt/ths-mexc/backups/`), with `releases/mexc-v1-20261103` kept for rollback. It adds setting, changing and cancelling take-profit and stop-loss, carrying them on an opening order, and the `stopOrders` read. Nginx, `/etc/ths-mexc/`, the unit file and the certificate job are unchanged, and `keyCheck` stays false. 167 server and 420 client tests passed on the host's Node 24.22.2 inside the release before the switch. Both devices reported `unresolvedOperation=false` before and after the restart. Read-only checks passed: status, limits, contract list, quotes, intraday history and live candles, plus malformed leverage, stop and order drafts and a malformed stop list request, each refused by format before any exchange request. This deployment read no account data and placed, changed or cancelled nothing. Phones on IPA 1.0.0 (14) have no stop screens, so this path is idle until the next package. Not yet tested: a real order, cancel, leverage change or take-profit and stop-loss, and an iPhone connecting to the IP certificate. To roll back, stop the service, `ln -sfn releases/mexc-v1-20261103 /opt/ths-mexc/current` and start it again; that release has no stop paths, and a locked stop request stays locked under it, with its lookup reported as failed.
- **Earlier record, 2026-11-03:** `releases/mexc-v1-20261103` was activated, built from commit `06c4c02` (tar SHA256 `6becaf3f6b9ff190…`, kept in `/opt/ths-mexc/backups/`). It adds the `live` RPC and changing the leverage of an open position, and treats MEXC code 9073 (stock market closed) as a refusal. Nginx, `/etc/ths-mexc/`, the unit file and the certificate job are unchanged, and `keyCheck` stays false. 149 server and 396 client tests passed on the host's Node 24.22.2 inside the release before the switch. Both devices reported `unresolvedOperation=false` before and after the restart. Read-only checks passed: status, limits, contract list, quotes, intraday history and live candles, plus a leverage draft with a malformed id, which was refused by format before any exchange request. This deployment read no account data and placed, changed or cancelled nothing. Not yet tested: a real order, a real cancel, a real leverage change, and an iPhone connecting to the IP certificate. To roll back, stop the service, `ln -sfn releases/mexc-keycheck-20261102 /opt/ths-mexc/current` and start it again; that release has no `live` RPC or leverage change, and a locked leverage change stays locked under it, with its lookup reported as failed.
- **Earlier record, 2026-11-02:** `releases/mexc-keycheck-20261102` was activated, with `releases/mexc-initial-20261102` kept for rollback; both tars are in `/opt/ths-mexc/backups/`. It was built from the tree on top of commit `64268fa` that added `keyCheck` (tar SHA256 `61b086d62dd86218…`). 126 server and 365 client tests passed on the host's Node 24.22.2 inside the release before the switch, with `unresolvedOperation=false` before and after. Read-only checks against the real account passed: status, contract list, quotes, 1-minute to daily history, account, positions, open and closed orders. Reviews were built and never submitted. No order was placed, changed or cancelled by this deployment. Not yet tested: a real order, a real cancel, and an iPhone connecting to the IP certificate.
- **Unknown outcome:** stop the gateway, then run `node server/mexcReconcile.mjs /etc/ths-mexc/mexc.config.json`. It shows the locked operation and what MEXC reports for it, and only reads. Not finding an order does not prove it was never placed, so verify in the MEXC order history; for a locked leverage change, check the position's leverage at MEXC instead, and for a locked take-profit or stop-loss, check the ones waiting on the position, since still seeing the old value proves nothing either. Only then add `--confirmed-at-exchange` to clear the lock, start the gateway, and acknowledge on the affected devices.

# 2026-10-19 overnight intraday deployment

Release `releases/overnight-intraday-20261019` is active (built from commit `e1ce436`, the same 80-file layout as the previous release; tar SHA256 `de36711ff3204818…`). It was activated at 10:24 CST on Monday, which was 22:24 Sunday in New York during the overnight session. Before the switch both devices reported unresolvedOperation=false, `scheduled` held 0 entries, and the gateway had no device or upstream connections; the restart took about one second. SSH access, Nginx, `/etc/ths-gateway/` and the unit file are unchanged.

- Intraday history now requests two days (`day/2/minute/1`) and trims to the 24/5 trading day that opens at 20:00 New York time the evening before, taking the previous close from the last regular-session bar before it. Schwab starts a one-day response at 07:00, so the old intraday chart lacked the overnight session and the 04:00–07:00 premarket for every symbol the archive was not collecting. The archive merge uses the same 20:00 boundary.
- Only `mobile/src/broker.ts`, `chartData.ts`, `liveHistory.ts`, `server/minuteArchive.ts` and their tests changed for the server, plus the client-only `ServerBroker.ts` guard committed earlier.
- 356 tests passed on the server's Node 24.21.0 inside the staged release before activation; locally 318 mobile and 51 server tests passed.
- After the restart both devices report configured/authenticated, reauthorizationRequired=false and unresolvedOperation=false; `scheduled` is still empty. A read-only intraday probe shows full nights from 20:00 the evening before (QQQ 474, NVDA 480, META 394, MSFT 410, SNDK 480 overnight minutes), where META, MSFT and SNDK previously had none. REST quotes did not update during the live overnight session (quote times stayed at Friday 19:59), so the current night appears only once Schwab adds it to history or the archive observes it.
- Rollback: check `scheduled` for pending entries, then stop the service, `ln -sfn releases/exits-schedule-20261018 /opt/ths-gateway/current`, and start it again.

# 2026-10-18 broker-held exits and timed orders deployment

Superseded by the record above; `releases/exits-schedule-20261018` is now the rollback release. It was built from commit `405850e`; tar SHA256 `a4f4d339…8eedc65`, kept in `/opt/ths-gateway/backups/`). It was activated at 21:12 CST on Sunday with the market closed. SSH access, Nginx, `/etc/ths-gateway/` and the unit file are unchanged.

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

The gateway is running at the existing HTTPS domain **`<gateway-origin>`**, using its existing certificate. The existing website still serves `/`; exact `/rpc`, `/market` and `/oauth/callback` locations proxy to the new service. Phone clients use the origin only, without a path.

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

The fresh server has the existing Client ID/Secret and is configured for **`<gateway-origin>/oauth/callback`**. At deployment verification it has **no Schwab account authorization**. The browser-control connection was unavailable, so the existing developer app's registered callback has not been changed or verified by this deployment.

1. Add the exact hosted callback in the existing Schwab developer app. Do not create another API app or change its credentials. The old loopback callback can remain registered for compatibility.
2. Use an updated App/Expo Go source build with Settings -> Schwab connection -> Server shared. The installed older IPA does not receive these source changes automatically.
3. Enter `<gateway-origin>` and that device's private key, then leave demo mode. Independent private device files were prepared locally under ignored `artifacts/server-device-configs/`, with restricted Windows ACLs; they are not in Git or the deployment tarball.
4. Stop direct-mode use on both phones, then complete one official Schwab login from one updated device. The hosted callback stores authorization on the server; return to the App and refresh. The other device can then refresh without its own Schwab login.

The authenticated brokerage paths, real shared market stream, and two physical phones remain unverified until this login and device migration are completed. No real orders or new IPA builds were performed.

## Operations

`systemctl status ths-gateway`, `systemctl restart ths-gateway`, and `journalctl -u ths-gateway` inspect/control this service. Keep config/key/vault outside source releases; update code using a new release directory, stop gracefully, change the `current` symlink, and start once. Never copy an old vault over a newer unknown-order marker. The Nginx include can be removed and configuration tested/reloaded to withdraw only these three routes.
