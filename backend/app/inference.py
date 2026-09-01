"""Lazy-loading wrapper around DvD's single-image dewarping pipeline.

Ported from the reference inference path published on the model's HuggingFace
Space (hanquansanren/DvD, app.py::run_single_docunet) — that function is a real
single-image-in/single-image-out entrypoint, unlike the base repo's
run_sampling.py which is a dataset-config-driven research CLI.

The Space's app.py loads every model onto 'cuda' eagerly at module import.
That's wrong for this deployment: the GPU must stay empty until a user
actually submits a job. DvDEngine defers all of that into _load_locked(),
called on first inference, and releases it again after IDLE_TIMEOUT_SECONDS
of inactivity via a background watchdog thread.
"""
import io
import os
import threading
import time
from typing import Optional

import cv2 as cv
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from huggingface_hub import hf_hub_download

import admin.settings as ws_settings
from train_settings.dvd.improved_diffusion import logger as dvd_logger
from train_settings.dvd.improved_diffusion.script_util import (
    args_to_dict,
    create_model_and_diffusion,
    model_and_diffusion_defaults,
)
from train_settings.models.geotr.geotr_core import GeoTr_Seg_Inf, Seg, reload_segmodel
from train_settings.models.geotr.unet_model import UNet
from train_settings.dvd.feature_backbones.VGG_features import VGGPyramid
from train_settings.dvd.eval_utils import extract_raw_features_single2
from datasets.utils.warping import register_model2

_REPO_ID = "hanquansanren/DvD"
_REG_MODEL_BILIN = register_model2((512, 512), "bilinear")


def _stage(msg: str):
    try:
        alloc = torch.cuda.memory_allocated() / 1e9
        reserved = torch.cuda.memory_reserved() / 1e9
        print(f"[STAGE] {msg} | alloc={alloc:.2f}GB reserved={reserved:.2f}GB", flush=True)
    except Exception as e:  # noqa: BLE001 - diagnostic only, never let logging break inference
        print(f"[STAGE] {msg} | (mem read failed: {e})", flush=True)


def _coords_grid_tensor(shape):
    im_x, im_y = np.mgrid[0 : shape[0] - 1 : complex(shape[0]), 0 : shape[1] - 1 : complex(shape[1])]
    coords = np.stack((im_y, im_x), axis=2)
    coords = torch.from_numpy(coords).float().permute(2, 0, 1).to("cuda")
    return coords.unsqueeze(0)


class DvDEngine:
    def __init__(self, idle_timeout_seconds: int = 600, hf_token: Optional[str] = None):
        self.idle_timeout_seconds = idle_timeout_seconds
        self.hf_token = hf_token
        self._lock = threading.RLock()
        self._loaded = False
        self._last_used = time.time()
        self._watchdog_started = False

        self._settings = None
        self._model = None
        self._diffusion = None
        self._pretrained_dewarp_model = None
        self._pretrained_line_seg_model = None
        self._pretrained_seg_model = None

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def _start_watchdog(self):
        if self._watchdog_started:
            return
        self._watchdog_started = True

        def loop():
            while True:
                time.sleep(30)
                with self._lock:
                    if self._loaded and time.time() - self._last_used > self.idle_timeout_seconds:
                        self._unload_locked()

        threading.Thread(target=loop, daemon=True).start()

    def _load_locked(self):
        if self._loaded:
            return
        dvd_logger.configure(dir="/tmp/dvd_logs")

        settings = ws_settings.Settings()
        settings.module_name = "dvd"
        settings.script_name = "val_TDiff"
        settings.project_path = "train_settings/dvd/val_TDiff"
        settings.seed = 1992
        settings.name = "service"
        settings.severity = 0
        settings.corruption_number = 0
        # Repo default is True and tries to save a debug PNG to a hardcoded
        # 'vis_hp/debug_vis/' path that doesn't exist in this container -
        # confirmed by a live failure: "[Errno 2] No such file or directory:
        # 'vis_hp/debug_vis/dewarped_f2.png'" after a fully successful
        # inference run. We don't need the debug visualization for the API.
        settings.env.visualize = False

        _stage("before create_model_and_diffusion")
        model, diffusion = create_model_and_diffusion(
            device="cuda",
            train_mode=settings.env.train_mode,
            tv=settings.env.time_variant,
            **args_to_dict(settings, model_and_diffusion_defaults().keys()),
        )
        setattr(diffusion, "settings", settings)
        _stage("after create_model_and_diffusion (diffusion U-Net on GPU)")

        pretrained_dewarp_model = GeoTr_Seg_Inf()
        _stage("GeoTr_Seg_Inf() constructed on CPU")
        seg_model_path = hf_hub_download(repo_id=_REPO_ID, filename="seg.pth", token=self.hf_token)
        _stage("seg.pth downloaded")
        reload_segmodel(pretrained_dewarp_model.msk, seg_model_path)
        _stage("seg.pth state dict loaded into .msk (still CPU)")
        pretrained_dewarp_model.to("cuda")
        _stage("pretrained_dewarp_model.to('cuda') done")
        pretrained_dewarp_model.eval()
        _stage("after pretrained_dewarp_model (GeoTr_Seg_Inf) to cuda")

        pretrained_line_seg_model = None
        pretrained_seg_model = None
        if settings.env.use_line_mask:
            pretrained_line_seg_model = UNet(n_channels=3, n_classes=1)
            pretrained_seg_model = Seg()

            line_seg_model_path = hf_hub_download(repo_id=_REPO_ID, filename="line_model2.pth", token=self.hf_token)
            line_ckpt = torch.load(line_seg_model_path, map_location="cpu")["model"]
            pretrained_line_seg_model.load_state_dict(line_ckpt, strict=True)
            pretrained_line_seg_model.to("cuda").eval()
            _stage("after pretrained_line_seg_model (UNet) to cuda")

            new_seg_model_path = hf_hub_download(repo_id=_REPO_ID, filename="seg_model.pth", token=self.hf_token)
            seg_ckpt = torch.load(new_seg_model_path, map_location="cpu")["model"]
            pretrained_seg_model.load_state_dict(seg_ckpt, strict=True)
            pretrained_seg_model.to("cuda").eval()
            _stage("after pretrained_seg_model (Seg) to cuda")

        model_path = hf_hub_download(repo_id=_REPO_ID, filename="model1852000.pt", token=self.hf_token)
        model_ckpt = torch.load(model_path, map_location="cpu")
        model.cpu().load_state_dict(model_ckpt, strict=False)
        model.to("cuda").eval()
        _stage("after main diffusion model weights loaded to cuda")

        self._settings = settings
        self._model = model
        self._diffusion = diffusion
        self._pretrained_dewarp_model = pretrained_dewarp_model
        self._pretrained_line_seg_model = pretrained_line_seg_model
        self._pretrained_seg_model = pretrained_seg_model
        self._loaded = True
        self._start_watchdog()

    def _unload_locked(self):
        if not self._loaded:
            return
        self._settings = None
        self._model = None
        self._diffusion = None
        self._pretrained_dewarp_model = None
        self._pretrained_line_seg_model = None
        self._pretrained_seg_model = None
        self._loaded = False
        torch.cuda.empty_cache()

    def infer(self, input_image_ori: Image.Image) -> np.ndarray:
        with self._lock:
            self._load_locked()
            try:
                return self._run(
                    input_image_ori,
                    self._settings,
                    self._model,
                    self._diffusion,
                    self._pretrained_dewarp_model,
                    self._pretrained_line_seg_model,
                    self._pretrained_seg_model,
                )
            finally:
                self._last_used = time.time()

    def infer_bytes(self, image_bytes: bytes) -> bytes:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        result = self.infer(image)
        buf = io.BytesIO()
        Image.fromarray(result).save(buf, format="PNG")
        return buf.getvalue()

    @staticmethod
    def _run(input_image_ori, settings, model, diffusion,
              pretrained_dewarp_model, pretrained_line_seg_model, pretrained_seg_model):
        # diffusion.ddim_sample_loop's iterative-refinement branch (the repo's
        # default 'iter' mode) unconditionally saves a per-step debug PNG to
        # this hardcoded relative path - confirmed by a live failure after an
        # otherwise fully successful run. settings.env.visualize does NOT
        # gate this call (verified against the actual library source), so the
        # correct fix is just making sure the directory exists.
        os.makedirs("vis_hp/debug_vis", exist_ok=True)
        cv.setNumThreads(0)
        input_image_ori = np.array(input_image_ori, dtype=np.uint8)
        input_image_resized = cv.resize(input_image_ori, (512, 512))

        source_vis = torch.tensor(np.transpose(input_image_ori, (2, 0, 1))).unsqueeze(0)
        input_image = torch.tensor(np.transpose(input_image_resized, (2, 0, 1)) / 255).unsqueeze(0).float()

        _, _, h_ori, w_ori = source_vis.shape
        source = input_image.to("cuda")
        source_256 = F.interpolate(input=source.float(), size=(256, 256), mode="area").to("cuda")

        _stage("before VGGPyramid to cuda")
        pyramid = VGGPyramid(train=False).to("cuda")
        _stage("after VGGPyramid to cuda")
        source_288 = F.interpolate(input_image, size=288, mode="bilinear", align_corners=True).to("cuda")

        if settings.env.time_variant:
            init_feat = torch.zeros((input_image.shape[0], 256, 64, 64), dtype=torch.float32).to("cuda")
        else:
            init_feat = None

        _stage("before pretrained_dewarp_model forward")
        with torch.inference_mode():
            ref_bm, mask_x = pretrained_dewarp_model(source_288)
        _stage("after pretrained_dewarp_model forward")

        init_flow = torch.zeros((input_image.shape[0], 2, 64, 64), dtype=torch.float32).to("cuda")

        _stage("before pretrained_seg_model forward")
        with torch.no_grad():
            mskx, d0, hx6, hx5d, hx4d, hx3d, hx2d, hx1d = pretrained_seg_model(source_288)
            hx6 = F.interpolate(hx6, size=64, mode="bilinear", align_corners=False)
            hx5d = F.interpolate(hx5d, size=64, mode="bilinear", align_corners=False)
            hx4d = F.interpolate(hx4d, size=64, mode="bilinear", align_corners=False)
            hx3d = F.interpolate(hx3d, size=64, mode="bilinear", align_corners=False)
            hx2d = F.interpolate(hx2d, size=64, mode="bilinear", align_corners=False)
            hx1d = F.interpolate(hx1d, size=64, mode="bilinear", align_corners=False)
            seg_map_all = torch.cat((hx6, hx5d, hx4d, hx3d, hx2d, hx1d), dim=1)
            _stage("after pretrained_seg_model forward")

            textline_map = None
            if settings.env.use_line_mask:
                _stage("before pretrained_line_seg_model forward")
                textline_map, _ = pretrained_line_seg_model(mskx)
                textline_map = F.interpolate(textline_map, size=64, mode="bilinear", align_corners=False)
                _stage("after pretrained_line_seg_model forward")

        feature_size = 64
        c20 = None
        if not settings.env.train_VGG:
            _stage("before VGG feature extraction")
            with torch.no_grad():
                c20 = extract_raw_features_single2(pyramid, source, source_256, feature_size)
            _stage("after VGG feature extraction")

        model_kwargs = {
            "init_flow": init_flow,
            "src_feat": c20,
            "src_64": None,
            "y512": source,
            "tmode": settings.env.train_mode,
            "mask_cat": mask_x,
            "init_feat": init_feat,
            "iter": settings.env.iter,
        }
        if not settings.env.use_gt_mask:
            model_kwargs["mask_y512"] = seg_map_all
        if settings.env.use_line_mask:
            model_kwargs["line_msk"] = textline_map

        _stage("before diffusion.ddim_sample_loop")
        sample, _ = diffusion.ddim_sample_loop(
            model,
            (1, 2, feature_size, feature_size),
            noise=None,
            clip_denoised=settings.env.clip_denoised,
            model_kwargs=model_kwargs,
            eta=0.0,
            progress=False,
            denoised_fn=None,
            sampling_kwargs={"src_img": source},
            logger=dvd_logger,
            n_batch=settings.env.n_batch,
            time_variant=settings.env.time_variant,
            pyramid=pyramid,
        )
        _stage("after diffusion.ddim_sample_loop")
        sample = torch.clamp(sample, min=-1, max=1)

        sample = F.interpolate(sample, size=(h_ori, w_ori), mode="bilinear", align_corners=True)
        base = F.interpolate(
            _coords_grid_tensor((512, 512)) / 511.0, size=(h_ori, w_ori), mode="bilinear", align_corners=True
        )
        sample = (((sample + base.to(sample.device)) * 1) * 2 - 1) * 0.987

        _stage("before final warp")
        warped_src = _REG_MODEL_BILIN([source_vis.to(sample.device).float(), sample])
        warped_src = warped_src[0].permute(1, 2, 0).detach().cpu().numpy()
        _stage("after final warp - inference complete")
        return warped_src.astype(np.uint8)
