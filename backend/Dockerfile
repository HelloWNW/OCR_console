# cu118 matches the repo's own pinned build: torch==2.1.1+cu118 / mmcv==2.2.0 (cu118, torch2.1)
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3-pip python3-dev git \
        build-essential \
        libopenmpi-dev openmpi-bin \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/python3.10 /usr/bin/python

WORKDIR /opt/dvd
RUN git clone --depth 1 https://github.com/hanquansanren/DvD.git repo
WORKDIR /opt/dvd/repo

# Upstream bug fix: train_settings/dvd/improved_diffusion/cross_model.py's
# `iter is True or tv is True` branch (our active code path - our settings
# always run with time_variant=True) references `block` without ever
# assigning it, because the `for block in self.blocks:` loop above it is
# commented out. The two sibling branches in the same if/elif/else both
# still have their loop intact, confirming this is a leftover debug comment,
# not deliberate. Confirmed live: this crashes every real inference request
# with "local variable 'block' referenced before assignment" until patched.
# Restoring the loop to match the working sibling branches.
RUN python3 - <<'PY'
path = "train_settings/dvd/improved_diffusion/cross_model.py"
src = open(path).read()
old = (
    "        if iter is True or tv is True: # true\n"
    "            # for block in self.blocks:\n"
    "            x4, x3, x2, x1  = block(x, t, tv, cond, msk6, msk_line, r)"
)
new = (
    "        if iter is True or tv is True: # true\n"
    "            for block in self.blocks:\n"
    "                x4, x3, x2, x1  = block(x, t, tv, cond, msk6, msk_line, r)"
)
assert old in src, "upstream cross_model.py no longer matches the expected buggy snippet - re-check the patch"
open(path, "w").write(src.replace(old, new))
PY

RUN pip install --no-cache-dir torch==2.1.1 torchvision==0.16.1 --index-url https://download.pytorch.org/whl/cu118 \
 && pip install --no-cache-dir mmcv==2.2.0 -f https://download.openmmlab.com/mmcv/dist/cu118/torch2.1/index.html \
 && pip install --no-cache-dir -r requirements.txt

COPY requirements-service.txt /opt/dvd/repo/requirements-service.txt
RUN pip install --no-cache-dir -r requirements-service.txt

COPY app /opt/dvd/repo/service

# Checkpoints are fetched lazily on first inference (see app/inference.py) into
# this dir, which the run script mounts as a named volume so a rebuild never
# has to redownload them and the image build never touches the network for
# model weights. Keeps "don't occupy GPU/resources until a user starts using
# it" true for weight storage too, not just VRAM.
ENV HF_HOME=/opt/dvd/repo/checkpoints
RUN mkdir -p /opt/dvd/repo/checkpoints

ENV PYTHONPATH=/opt/dvd/repo
EXPOSE 8000
CMD ["uvicorn", "service.main:app", "--host", "0.0.0.0", "--port", "8000"]
