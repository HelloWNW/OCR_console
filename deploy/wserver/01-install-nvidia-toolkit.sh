#!/usr/bin/env bash
# Run once, as root, inside the Ubuntu-24.04 WSL distro on wserver:
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Docker/OCR_console/deploy/wserver/01-install-nvidia-toolkit.sh
#
# Confirmed via live SSH check (2026-09-01): this distro's native Docker
# Engine (systemd-managed, separate from Docker Desktop) can pull images fine
# but fails GPU passthrough with "failed to discover GPU vendor from CDI: no
# known GPU vendor found" because nvidia-container-toolkit isn't installed
# here yet. This installs and wires it up.
set -euo pipefail

curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

apt-get update
apt-get install -y nvidia-container-toolkit

nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

# Verified live (2026-09-01): under this WSL2 setup, `--gpus device=N` does
# NOT isolate individual GPUs — device=0 and device=1 both expose every GPU
# on the host to the container (a WSL2 GPU-passthrough limitation, no CDI
# spec is even involved here, and both selectors give identical
# `nvidia-smi -L` output). The actual restriction to GPU 1 (the 2nd slot /
# GTX 1080 Ti) happens at the application level via CUDA_VISIBLE_DEVICES=1,
# set in 03-build-and-run.sh — confirmed working: PyTorch reports
# device_count()==1 and the correct GPU name with that env var set,
# regardless of the --gpus flag's value.
echo "Confirming basic GPU passthrough into containers works at all:"
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L
echo "(Both GPUs will be listed above — that's expected here. Actual restriction to"
echo " GPU 1 happens via CUDA_VISIBLE_DEVICES=1 in 03-build-and-run.sh, not this flag.)"
