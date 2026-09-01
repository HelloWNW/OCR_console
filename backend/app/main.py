import io
import os
import zipfile
from typing import Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image

from .inference import DvDEngine
from .jobs import JobQueue, JobStatus

API_KEY = os.environ.get("DVD_API_KEY")
IDLE_TIMEOUT = int(os.environ.get("DVD_IDLE_TIMEOUT_SECONDS", "600"))
HF_TOKEN = os.environ.get("HF_TOKEN")
ALLOWED_ORIGINS = [o for o in os.environ.get("DVD_ALLOWED_ORIGINS", "").split(",") if o]

engine = DvDEngine(idle_timeout_seconds=IDLE_TIMEOUT, hf_token=HF_TOKEN)
queue = JobQueue(engine)

app = FastAPI(title="DvD Dewarping Service")

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.on_event("startup")
async def _startup():
    queue.start()


def _check_key(x_api_key: Optional[str], query_key: Optional[str] = None):
    # Defense in depth behind Cloudflare Access — the frontend/Access also
    # gate access at the edge, this catches anything that reaches the
    # container directly. query_key exists only for the plain <a href>
    # download link, which can't set a custom header.
    if API_KEY and API_KEY not in (x_api_key, query_key):
        raise HTTPException(status_code=401, detail="invalid API key")


@app.post("/sessions/{session_id}/jobs")
async def submit_job(session_id: str, file: UploadFile = File(...), x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    data = await file.read()
    job = queue.submit(session_id, file.filename or "photo", data)
    return {"job_id": job.id, "status": job.status}


@app.get("/sessions/{session_id}/queue")
async def session_queue(session_id: str, x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    return [
        {"job_id": j.id, "filename": j.filename, "status": j.status, "error": j.error}
        for j in queue.session_jobs(session_id)
    ]


@app.post("/sessions/{session_id}/jobs/{job_id}/cancel")
async def cancel_job(session_id: str, job_id: str, x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    ok = queue.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail="job already started or not found; cannot cancel")
    return {"status": "canceled"}


@app.post("/sessions/{session_id}/jobs/{job_id}/remove")
async def remove_job(session_id: str, job_id: str, x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    index = queue.remove(session_id, job_id)
    if index is None:
        raise HTTPException(status_code=409, detail="job already started or not found; cannot remove")
    return {"index": index}


@app.post("/sessions/{session_id}/jobs/{job_id}/move")
async def move_job(session_id: str, job_id: str, to_index: int, x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    ok = queue.move(session_id, job_id, to_index)
    if not ok:
        raise HTTPException(status_code=404, detail="job not found in session")
    return {"status": "moved"}


@app.post("/sessions/{session_id}/clear")
async def clear_session(session_id: str, x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    queue.clear(session_id)
    return {"status": "cleared"}


@app.post("/queue/pause")
async def pause_queue(x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    queue.pause()
    return {"paused": True}


@app.post("/queue/resume")
async def resume_queue(x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    queue.resume()
    return {"paused": False}


@app.get("/sessions/{session_id}/jobs/{job_id}/result")
async def job_result(session_id: str, job_id: str, x_api_key: Optional[str] = Header(None)):
    _check_key(x_api_key)
    job = queue.jobs.get(job_id)
    if not job or job.session_id != session_id:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != JobStatus.DONE:
        raise HTTPException(status_code=409, detail=f"job is {job.status}, not done")
    return Response(content=job.result_png, media_type="image/png")


@app.get("/sessions/{session_id}/download")
async def download_session(
    session_id: str,
    format: str = "png",
    key: Optional[str] = None,
    x_api_key: Optional[str] = Header(None),
):
    _check_key(x_api_key, key)
    if format not in ("png", "pdf"):
        raise HTTPException(status_code=400, detail="format must be 'png' or 'pdf'")

    done_jobs = [j for j in queue.session_jobs(session_id) if j.status == JobStatus.DONE]
    if not done_jobs:
        raise HTTPException(status_code=404, detail="no completed jobs in this session")

    if format == "pdf":
        images = [Image.open(io.BytesIO(j.result_png)).convert("RGB") for j in done_jobs]
        buf = io.BytesIO()
        images[0].save(buf, format="PDF", save_all=True, append_images=images[1:])
        return Response(
            content=buf.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{session_id}.pdf"'},
        )

    # format == "png": single photo -> raw PNG, bulk -> zip
    if len(done_jobs) == 1:
        job = done_jobs[0]
        base = os.path.splitext(job.filename)[0]
        return Response(
            content=job.result_png,
            media_type="image/png",
            headers={"Content-Disposition": f'attachment; filename="{base}.png"'},
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for j in done_jobs:
            base = os.path.splitext(j.filename)[0]
            zf.writestr(f"{base}.png", j.result_png)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{session_id}.zip"'},
    )


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": engine.is_loaded, "paused": queue.is_paused}
