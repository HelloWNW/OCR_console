# Run once, as Administrator, on wserver.
#
# Prerequisite (manual, one time): download a Caddy build that includes the
# Cloudflare DNS module from https://caddyserver.com/download — tick
# "github.com/caddy-dns/cloudflare" in the module picker, download the
# windows/amd64 zip, and extract caddy.exe to C:\Caddy\caddy.exe. Caddy
# doesn't support runtime plugin loading, so this can't be scripted without
# either xcaddy (a Go build toolchain) or that prebuilt download.
#
# Also requires CLOUDFLARE_API_TOKEN set as a machine-level environment
# variable (System Properties > Environment Variables > System variables) —
# read by the Caddyfile's `dns cloudflare {env.CLOUDFLARE_API_TOKEN}` block.

$caddyExe = "C:\Caddy\caddy.exe"
$configPath = "C:\Caddy\Caddyfile"

if (-not (Test-Path $caddyExe)) {
    Write-Error "C:\Caddy\caddy.exe not found. Download it first (see comment at the top of this script)."
    exit 1
}

sc.exe create Caddy binPath= "`"$caddyExe`" run --config `"$configPath`" --environ" start= auto obj= LocalSystem
sc.exe description Caddy "Caddy reverse proxy for DvD (api.hello-wnw.org -> 127.0.0.1:8000)"
sc.exe failure Caddy reset= 86400 actions= restart/5000/restart/5000/restart/5000

Start-Service Caddy
Write-Host "Caddy installed as a Windows service (LocalSystem, auto-start) and started."
Write-Host "Check status: Get-Service Caddy"
