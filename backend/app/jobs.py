"""In-memory job queue driving the single GPU worker.

One GPU, one worker: jobs across all sessions serialize through a single
asyncio worker task, which matches the "don't hog the GPU" requirement and
avoids needing Redis/Celery for a single-machine, single-GPU service.

Jobs and their result bytes live in memory only — a container restart drops
anything in flight. Fine for a personal-use tool; not meant to survive a
crash mid-batch.
"""
import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    DONE = "done"
    ERROR = "error"
    CANCELED = "canceled"


@dataclass
class Job:
    id: str
    session_id: str
    filename: str
    input_bytes: bytes
    status: JobStatus = JobStatus.QUEUED
    result_png: Optional[bytes] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)


class JobQueue:
    def __init__(self, engine):
        self.engine = engine
        self.jobs: dict[str, Job] = {}
        self.sessions: dict[str, list[str]] = {}
        self._queue: "asyncio.Queue[str]" = asyncio.Queue()
        self._paused = asyncio.Event()
        self._paused.set()  # set = running, clear = paused
        self._worker_task: Optional[asyncio.Task] = None

    def start(self):
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker())

    def submit(self, session_id: str, filename: str, input_bytes: bytes) -> Job:
        job = Job(id=str(uuid.uuid4()), session_id=session_id, filename=filename, input_bytes=input_bytes)
        self.jobs[job.id] = job
        self.sessions.setdefault(session_id, []).append(job.id)
        self._queue.put_nowait(job.id)
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job and job.status == JobStatus.QUEUED:
            job.status = JobStatus.CANCELED
            return True
        return False

    def remove(self, session_id: str, job_id: str) -> Optional[int]:
        """Pull a not-yet-started job out of its session entirely, for
        retaking. Returns the index it was removed from (so the caller can
        reinsert a replacement at the same spot), or None if the job isn't
        queued anymore - already processing/done can't be safely un-submitted.
        """
        job = self.jobs.get(job_id)
        if not job or job.session_id != session_id or job.status != JobStatus.QUEUED:
            return None
        ids = self.sessions.get(session_id, [])
        if job_id not in ids:
            return None
        index = ids.index(job_id)
        ids.pop(index)
        job.status = JobStatus.CANCELED
        del self.jobs[job_id]
        return index

    def move(self, session_id: str, job_id: str, to_index: int) -> bool:
        """Reposition a job within its session's display/output order."""
        ids = self.sessions.get(session_id)
        if not ids or job_id not in ids:
            return False
        ids.remove(job_id)
        ids.insert(max(0, min(to_index, len(ids))), job_id)
        return True

    def clear(self, session_id: str) -> None:
        """Drop every job for a session except one still mid-inference,
        which can't be safely aborted - it just disappears once it finishes.
        """
        ids = self.sessions.get(session_id, [])
        keep = []
        for jid in ids:
            job = self.jobs.get(jid)
            if job and job.status == JobStatus.PROCESSING:
                keep.append(jid)
            elif job:
                del self.jobs[jid]
        self.sessions[session_id] = keep

    def pause(self):
        self._paused.clear()

    def resume(self):
        self._paused.set()

    @property
    def is_paused(self) -> bool:
        return not self._paused.is_set()

    def session_jobs(self, session_id: str) -> list[Job]:
        return [self.jobs[jid] for jid in self.sessions.get(session_id, []) if jid in self.jobs]

    async def _worker(self):
        loop = asyncio.get_event_loop()
        while True:
            job_id = await self._queue.get()
            await self._paused.wait()
            job = self.jobs.get(job_id)
            if not job or job.status == JobStatus.CANCELED:
                continue
            job.status = JobStatus.PROCESSING
            try:
                job.result_png = await loop.run_in_executor(None, self.engine.infer_bytes, job.input_bytes)
                job.status = JobStatus.DONE
            except Exception as exc:  # noqa: BLE001 - surface any inference failure to the client
                job.status = JobStatus.ERROR
                job.error = str(exc)
