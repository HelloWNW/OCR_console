import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  clearQueue,
  downloadUrl,
  fetchJobResult,
  getQueue,
  moveJob,
  pauseQueue,
  QueueItem,
  removeQueuedJob,
  resumeQueue,
  submitJob,
} from "./lib/api";

type Mode = "camera" | "upload";
type OutputFormat = "png" | "pdf";

const sessionId = crypto.randomUUID();

export default function App() {
  const [mode, setMode] = useState<Mode>("upload");
  const [format, setFormat] = useState<OutputFormat>("png");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [paused, setPaused] = useState(false);
  const thumbs = useRef<Record<string, string>>({});
  // Raw Blobs behind each thumb, kept alongside the object-URL versions so a
  // queued photo can be pulled back out and resubmitted later (retake).
  const blobs = useRef<Record<string, Blob>>({});
  // Job ids whose result image has already been fetched to replace the
  // input-photo thumbnail, so the swap only happens once per job.
  const resultApplied = useRef<Set<string>>(new Set());
  const [useNumbering, setUseNumbering] = useState(false);
  const numberCounter = useRef(1);

  // camera mode state
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [rotation, setRotation] = useState(0);
  const [cameraError, setCameraError] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The most recently captured shot, tracked separately from React state so
  // a fast second capture can't race the first one's submit in flight.
  // reinsertIndex is set only when this capture came from retaking a queued
  // photo, so it can go back to the same spot instead of the end of the line.
  const pendingCapture = useRef<{ blob: Blob; filename: string; reinsertIndex?: number } | null>(null);
  const [queueStatus, setQueueStatus] = useState<"idle" | "queuing" | "queued" | "error">("idle");
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultError, setResultError] = useState(false);

  function nextFilename(defaultName: string, ext: string): string {
    if (!useNumbering) return defaultName;
    return `${String(numberCounter.current++).padStart(5, "0")}.${ext}`;
  }

  const refreshQueue = useCallback(async () => {
    try {
      const items = await getQueue(sessionId);
      setQueue(items);
      for (const item of items) {
        if (item.status !== "done" || resultApplied.current.has(item.job_id)) continue;
        resultApplied.current.add(item.job_id);
        fetchJobResult(sessionId, item.job_id)
          .then((url) => {
            const old = thumbs.current[item.job_id];
            thumbs.current[item.job_id] = url;
            if (old) URL.revokeObjectURL(old);
            setQueue((q) => [...q]); // re-render to pick up the swapped thumb
          })
          .catch(() => resultApplied.current.delete(item.job_id)); // retry next poll
      }
    } catch {
      // transient network hiccup - next poll will retry
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refreshQueue, 2000);
    refreshQueue();
    return () => clearInterval(id);
  }, [refreshQueue]);

  useEffect(() => {
    if (mode !== "camera") return;
    let cancelled = false;
    setCameraError(false);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setCameraError(true));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  // Takes a shot. It sits in preview only - not queued yet - so the shooter
  // can review it before committing. If a previous shot is still sitting in
  // preview when a new one is taken, that older one is queued now (its
  // review window is over) before the new shot takes its place; the "Queue"
  // button covers the single-shot case where there's no next photo to
  // trigger that handoff. Uses a fresh canvas per capture (not a shared ref)
  // so a fast second shot can't clear the first one's pixels out from under
  // it - setting canvas.width/height resets its contents synchronously, so
  // two overlapping captures sharing one canvas could otherwise both end up
  // reading the second frame, or lose the first entirely.
  async function takePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png")
    );

    if (pendingCapture.current) {
      await queueCurrentCapture();
    }

    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    const filename = nextFilename(`capture-${Date.now()}.png`, "png");
    pendingCapture.current = { blob, filename };
    setQueueStatus("idle");
  }

  // Submits whatever's currently in pendingCapture: automatically when the
  // next shot bumps it out of preview, and also exposed as the "Queue"
  // button for the last shot of a session (or a retry after a failed
  // submit), which has no next photo to trigger that handoff.
  async function queueCurrentCapture() {
    const capture = pendingCapture.current;
    if (!capture) return;
    setQueueStatus("queuing");
    try {
      const job = await submitJob(sessionId, capture.blob, capture.filename);
      thumbs.current[job.job_id] = URL.createObjectURL(capture.blob);
      blobs.current[job.job_id] = capture.blob;
      if (capture.reinsertIndex !== undefined) {
        await moveJob(sessionId, job.job_id, capture.reinsertIndex);
      }
      pendingCapture.current = null;
      setQueueStatus("queued");
      refreshQueue();
    } catch {
      setQueueStatus("error");
    }
  }

  // Pulls a still-queued photo back out to retake it, replacing whatever's
  // currently in preview (which is dropped, not auto-queued - the point of
  // this action is to redo that queued shot instead). Remembers its queue
  // position so the retaken shot goes back to the same spot, not the end.
  async function retakeFromQueue(jobId: string, filename: string) {
    try {
      const index = await removeQueuedJob(sessionId, jobId);
      const blob = blobs.current[jobId];
      if (blob) {
        setPreviewUrl(URL.createObjectURL(blob));
        pendingCapture.current = { blob, filename, reinsertIndex: index };
        setQueueStatus("idle");
      }
      delete thumbs.current[jobId];
      delete blobs.current[jobId];
    } finally {
      refreshQueue();
    }
  }

  // Fetch the actual processed result for the open dialog - the queue-strip
  // thumbnail is the local input photo (cheap, instant), but the dialog
  // should show what the model actually produced.
  useEffect(() => {
    if (!activeResultId) {
      setResultUrl(null);
      setResultError(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setResultUrl(null);
    setResultError(false);
    fetchJobResult(sessionId, activeResultId)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setResultUrl(url);
      })
      .catch(() => !cancelled && setResultError(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeResultId]);

  function rotateFlip() {
    setRotation((r) => (r + 90) % 360);
  }

  async function onBulkFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop() || "png";
      const filename = nextFilename(file.name, ext);
      const job = await submitJob(sessionId, file, filename);
      thumbs.current[job.job_id] = URL.createObjectURL(file);
      blobs.current[job.job_id] = file;
    }
    refreshQueue();
  }

  async function togglePause() {
    if (paused) {
      await resumeQueue();
    } else {
      await pauseQueue();
    }
    setPaused(!paused);
  }

  async function cancelAllQueued() {
    await Promise.all(
      queue.filter((j) => j.status === "queued").map((j) => cancelJob(sessionId, j.job_id))
    );
    refreshQueue();
  }

  async function clearAll() {
    if (!confirm("Clear the entire queue? This can't be undone.")) return;
    await clearQueue(sessionId);
    for (const url of Object.values(thumbs.current)) URL.revokeObjectURL(url);
    thumbs.current = {};
    blobs.current = {};
    resultApplied.current.clear();
    numberCounter.current = 1;
    refreshQueue();
  }

  const doneCount = queue.filter((j) => j.status === "done").length;
  const activeItem = queue.find((j) => j.job_id === activeResultId) || null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>OCR Console</h1>
          <span className="subtitle">Document dewarping</span>
          <span className="version">v{__APP_VERSION__}</span>
        </div>
        <div className="mode-switch">
          <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")}>
            Upload
          </button>
          <button className={mode === "camera" ? "active" : ""} onClick={() => setMode("camera")}>
            Camera
          </button>
        </div>
      </header>

      {mode === "upload" && (
        <div className="upload-layout">
          <label className="dropzone">
            <input type="file" accept="image/*" multiple onChange={(e) => onBulkFiles(e.target.files)} />
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="dropzone-icon">
              <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
            <div className="dropzone-title">Drop photos here or tap to choose</div>
            <div className="dropzone-hint">Bulk upload OK</div>
          </label>
          <div className="upload-controls">
            <button className="btn btn-secondary" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
            <button className="btn btn-ghost" onClick={cancelAllQueued}>Cancel</button>
          </div>
        </div>
      )}

      {mode === "camera" && (
        <div className="camera-layout">
          <div className="main-window">
            <video ref={videoRef} autoPlay playsInline muted style={{ transform: `rotate(${rotation}deg)` }} />
            {cameraError && (
              <div className="camera-error">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 2l20 20" /><path d="M9 5H6a2 2 0 0 0-2 2v9c0 .3 0 .5.1.8M20 15V9a2 2 0 0 0-2-2h-2l-1.6-2.4a1 1 0 0 0-.8-.6H11" /><path d="M14.5 14.5A3.5 3.5 0 1 1 9.5 9.5" />
                </svg>
                Camera unavailable
              </div>
            )}
            <div className="camera-controls">
              <button className="btn-icon flip-btn" onClick={rotateFlip} aria-label="Rotate 90�">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 1 2.6 6.4" /><path d="M3 21v-5h5" />
                </svg>
              </button>
              <button className="take-photo" onClick={takePhoto} aria-label="Take photo">
                <span />
              </button>
              <div className="controls-spacer" />
            </div>
          </div>
          <div className="preview-window">
            <h2>Preview</h2>
            {previewUrl ? (
              <>
                <img src={previewUrl} alt="last capture" />
                <button
                  className={`btn ${queueStatus === "error" ? "btn-danger" : "btn-secondary"} queue-btn`}
                  onClick={queueCurrentCapture}
                  disabled={queueStatus === "queuing" || queueStatus === "queued"}
                >
                  {queueStatus === "queuing" && "Queuing…"}
                  {queueStatus === "queued" && "Queued ✓"}
                  {queueStatus === "error" && "Retry queue"}
                  {queueStatus === "idle" && "Queue"}
                </button>
              </>
            ) : (
              <p className="empty-hint">Take a photo to preview it here.</p>
            )}
          </div>
        </div>
      )}

      <section className="queue-strip">
        <div className="queue-strip-header">
          <h2>Queue - {queue.length} item{queue.length === 1 ? "" : "s"}</h2>
          <div className="queue-strip-actions">
            <button
              className={`btn-pill ${useNumbering ? "active" : ""}`}
              onClick={() => setUseNumbering((v) => !v)}
              title="Name new photos 00001, 00002, ... instead of their original names"
            >
              00001 naming {useNumbering ? "on" : "off"}
            </button>
            <button className="btn-pill danger" onClick={clearAll} disabled={queue.length === 0}>
              Clear
            </button>
          </div>
        </div>
        <div className="strip">
          {queue.length === 0 && <p className="empty-hint">No photos yet.</p>}
          {[...queue].reverse().map((j) => {
            const thumb = thumbs.current[j.job_id];
            const openable = j.status === "done" && !!thumb;
            const retakeable = mode === "camera" && j.status === "queued";
            return (
              <div
                key={j.job_id}
                className={`queue-item status-${j.status}`}
                onClick={() => openable && setActiveResultId(j.job_id)}
                style={{ cursor: openable ? "pointer" : "default" }}
              >
                <div className="thumb">
                  {thumb ? (
                    <img src={thumb} alt="" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
                    </svg>
                  )}
                </div>
                <div className="queue-item-row">
                  <span className="filename">{j.filename}</span>
                  <div className="queue-item-buttons">
                    {retakeable && (
                      <button
                        className="retake"
                        title="Retake this photo"
                        onClick={(e) => {
                          e.stopPropagation();
                          retakeFromQueue(j.job_id, j.filename);
                        }}
                      >
                        ↺
                      </button>
                    )}
                    {j.status === "queued" && (
                      <button
                        className="cancel"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelJob(sessionId, j.job_id).then(refreshQueue);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
                <span className="status">{j.status}</span>
              </div>
            );
          })}
        </div>
      </section>

      <footer className="output-bar">
        <div className="format-switch">
          <button className={format === "png" ? "active" : ""} onClick={() => setFormat("png")}>PNG</button>
          <button className={format === "pdf" ? "active" : ""} onClick={() => setFormat("pdf")}>PDF</button>
        </div>
        <a
          className={`download-btn ${doneCount === 0 ? "disabled" : ""}`}
          href={doneCount > 0 ? downloadUrl(sessionId, format) : undefined}
        >
          Download {doneCount > 0 ? `(${doneCount})` : ""}
        </a>
      </footer>

      {activeItem && (
        <div className="dialog-backdrop" onClick={() => setActiveResultId(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">
              <span>{activeItem.filename}</span>
              <button className="btn-icon" onClick={() => setActiveResultId(null)} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
              </button>
            </div>
            {resultUrl ? (
              <img src={resultUrl} alt="" className="dialog-image" />
            ) : resultError ? (
              <p className="empty-hint">Could not load the result.</p>
            ) : (
              <p className="empty-hint">Loading result…</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
