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
