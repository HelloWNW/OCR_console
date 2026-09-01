#!/usr/bin/env bash
# Run once, as root, inside the Ubuntu-24.04 WSL distro on wserver:
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Docker/DvD/deploy/wserver/01-install-nvidia-toolkit.sh
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

echo "Verifying GPU 1 (the 2nd slot / GTX 1080 Ti) is now visible to containers:"
docker run --rm --gpus device=1 nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L
