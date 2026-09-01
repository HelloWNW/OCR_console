# OCR_console deployment runbook

Document dewarping model ([hanquansanren/DvD](https://github.com/hanquansanren/DvD))
as a self-hosted service: GPU inference on `wserver`, website on Cloudflare
Pages, `api.hello-wnw.org` reverse-proxied by native Caddy on wserver,
everything gated by free Cloudflare Access.

## What's already verified (live, 2026-09-01)
- SSH to wserver works fine for running commands non-interactively. The
  thing that looked like "SSH blocks docker" was actually Docker Desktop's
  credential helper breaking without a live interactive Windows session
  (`error getting credentials... A specified logon session does not exist`).
- wserver already has a **separate**, working native Docker Engine inside
  the `Ubuntu-24.04` WSL distro (systemd, `docker.service` enabled). `docker
  pull` works cleanly there over SSH — this is what everything below builds
  on, not Docker Desktop.
- GPU 1 (the "2nd slot") = GTX 1080 Ti. GPU 0 is an RTX 3060, left alone.
- Gaps closed by the scripts in `deploy/wserver/`: nvidia-container-toolkit
  wasn't installed in Ubuntu-24.04 (GPU passthrough failed until step 1);
  nothing booted that WSL distro at Windows startup without a login (fixed
  by step 2's Task Scheduler entry).
- **GPU isolation under WSL2**: Docker's own `--gpus device=1` flag does
  *not* restrict which GPU a container can see here — verified live,
  `device=0` and `device=1` both exposed both GPUs identically (a WSL2
  GPU-passthrough limitation, not a config mistake). The actual restriction
  to GPU 1 happens at the application level via `CUDA_VISIBLE_DEVICES=1`
  (set in step 3's run command) — confirmed working with a real PyTorch
  container: `torch.cuda.device_count()` reports 1 and
  `torch.cuda.get_device_name(0)` correctly reports the GTX 1080 Ti. This is
  a convention CUDA-aware code honors, not an OS-level security boundary —
  fine for our own trusted model code, worth knowing if anything else ever
  runs in this container.

## Order of operations

1. **`deploy/wserver/01-install-nvidia-toolkit.sh`** — run once as root
   inside Ubuntu-24.04. Installs nvidia-container-toolkit, wires it to
   Docker, verifies GPU 1 passthrough.
2. **`deploy/wserver/02-setup-wsl-boot-task.ps1`** — run once as
   Administrator on wserver. Registers a SYSTEM-level scheduled task that
   boots Ubuntu-24.04 (and therefore `docker.service`) at every Windows
   startup, no login required.
3. Copy this whole repo to `C:\Docker\OCR_console` on wserver (`scp -r` or
   your own method), then **`deploy/wserver/03-build-and-run.sh`** — run
   inside Ubuntu-24.04 with `DVD_API_KEY` exported. Builds the image, runs
   the `OCR` container (name = hostname = `OCR`, `--gpus all` +
   `CUDA_VISIBLE_DEVICES=1` to pin it to GPU 1 specifically, `--restart
   unless-stopped`, bound to `127.0.0.1:8000` only). GPU stays empty until
   the first real inference request; idles back down after
   `DVD_IDLE_TIMEOUT_SECONDS` (default 600s) of inactivity.
4. **Manual — Caddy binary**: download a Caddy build with the Cloudflare DNS
   module from https://caddyserver.com/download (tick
   `github.com/caddy-dns/cloudflare`), extract `caddy.exe` to
   `C:\Caddy\caddy.exe`. Can't be scripted without a Go build toolchain.
5. Copy `deploy/wserver/Caddyfile` to `C:\Caddy\Caddyfile`. Set
   `CLOUDFLARE_API_TOKEN` as a machine-level environment variable (from
   `~/Documents/credentials/cloudflare/credentials`). Run
   **`deploy/wserver/04-install-caddy-service.ps1`** as Administrator —
   installs Caddy as an auto-start Windows service.
6. **Manual — router port-forward**: forward inbound TCP 443 to wserver's
   LAN IP (192.168.1.3). Caddy's DNS-01 challenge means port 80 is never
   needed for cert issuance, but 443 still has to reach Caddy for real
   traffic. Not something I can do from here — no router credentials on
   file.
7. **Manual — domain nameservers**: `hello-wnw.org` is registered elsewhere;
   add it as a site in the Cloudflare dashboard and point its nameservers at
   Cloudflare per the dashboard's instructions.
8. **`deploy/cloudflare/setup-dns-access.sh`** — run once you have
   `WSERVER_PUBLIC_IP` and the zone is active. Creates the proxied A record
   for `api.hello-wnw.org` with the API key noted in its comment field, and
   sets up free Cloudflare Access apps (owner + your additional email list)
   in front of both the site and the API. **This makes live changes to your
   Cloudflare account — run it deliberately, not as part of an automated
   pipeline.**
9. Deploy the frontend: `cd frontend && npm install && npm run build`, then
   `npx wrangler pages deploy dist --project-name=ocr-console` (or connect
   the repo in the Pages dashboard for git-based deploys). Set
   `VITE_API_BASE=https://api.hello-wnw.org` as a Pages build environment
   variable.

## Known limitations
- Job queue and results are in-memory only inside the `OCR` container — a
  container restart drops anything queued or completed but not yet
  downloaded. Acceptable for a personal-use tool; would need persistence
  for anything heavier.
- One GPU, one worker: all sessions share a single serialized queue. Matches
  "don't hog the GPU" but means concurrent users wait on each other.
- DNS record comments in Cloudflare are visible to anyone with DNS-read
  access on the zone — used here as a personal memo field per your request,
  not a secrets vault.
- This repo is public. No secrets are hardcoded anywhere in it — every
  credential (Cloudflare API token, backend API key, wserver login) is
  supplied at runtime via environment variables you export yourself, never
  committed. See `.gitignore` and `deploy/cloudflare/setup-dns-access.sh`'s
  header comment for what's expected to come from your own environment.
