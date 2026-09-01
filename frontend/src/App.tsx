import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  downloadUrl,
  getQueue,
  pauseQueue,
  QueueItem,
  resumeQueue,
  submitJob,
} from "./lib/api";

type Mode = "camera" | "upload";
type OutputFormat = "png" | "pdf";

const sessionId = crypto.randomUUID();

export default function App() {
  const [mode, setMode] = useState<Mode>("camera");
  const [format, setFormat] = useState<OutputFormat>("png");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [paused, setPaused] = useState(false);

  // camera mode state
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await getQueue(sessionId));
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
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  async function takePhoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png")
    );
    setPreviewUrl(URL.createObjectURL(blob));
    const filename = `capture-${Date.now()}.png`;
    const job = await submitJob(sessionId, blob, filename);
    setLastJobId(job.job_id);
    refreshQueue();
  }

  async function retakePhoto() {
    if (lastJobId) await cancelJob(sessionId, lastJobId);
    setPreviewUrl(null);
    setLastJobId(null);
    refreshQueue();
  }

  async function onBulkFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      await submitJob(sessionId, file, file.name);
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

  const doneCount = queue.filter((j) => j.status === "done").length;

  return (
    <div className="app">
      <header className="topbar">
        <h1>DvD Document Dewarping</h1>
        <div className="mode-switch">
          <button className={mode === "camera" ? "active" : ""} onClick={() => setMode("camera")}>
            Camera
          </button>
          <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")}>
            Upload
          </button>
        </div>
      </header>

      {mode === "camera" && (
        <div className="camera-layout">
          <div className="main-window">
            <video ref={videoRef} autoPlay playsInline muted />
            <canvas ref={canvasRef} hidden />
            {!previewUrl && (
              <button className="take-photo" onClick={takePhoto}>
                Take a photo
              </button>
            )}
          </div>
          <div className="preview-window">
            <h2>Preview</h2>
            {previewUrl ? (
              <>
                <img src={previewUrl} alt="last capture" />
                <button onClick={retakePhoto}>Retake a photo</button>
              </>
            ) : (
              <p className="empty-hint">Take a photo to preview it here.</p>
            )}
          </div>
        </div>
      )}

      {mode === "upload" && (
        <div className="upload-layout">
          <label className="dropzone">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => onBulkFiles(e.target.files)}
            />
            Drop photos here or click to choose (bulk upload OK)
          </label>
          <div className="upload-controls">
            <button onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
            <button onClick={cancelAllQueued}>Cancel queued</button>
          </div>
        </div>
      )}

      <section className="queue-strip">
        <h2>Processing queue</h2>
        <div className="strip">
          {queue.length === 0 && <p className="empty-hint">No photos yet.</p>}
          {queue.map((j) => (
            <div key={j.job_id} className={`queue-item status-${j.status}`}>
              <span className="filename">{j.filename}</span>
              <span className="status">{j.status}</span>
              {j.status === "queued" && (
                <button className="cancel" onClick={() => cancelJob(sessionId, j.job_id).then(refreshQueue)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <footer className="output-bar">
        <label>
          Output:
          <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            <option value="png">PNG</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        <a
          className={`download-btn ${doneCount === 0 ? "disabled" : ""}`}
          href={doneCount > 0 ? downloadUrl(sessionId, format) : undefined}
        >
          Download {doneCount > 0 ? `(${doneCount} ready)` : ""}
        </a>
      </footer>
    </div>
  );
}
