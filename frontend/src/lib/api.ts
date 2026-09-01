const API_BASE = import.meta.env.VITE_API_BASE ?? "https://api.hello-wnw.org";

export type JobStatus = "queued" | "processing" | "done" | "error" | "canceled";

export interface QueueItem {
  job_id: string;
  filename: string;
  status: JobStatus;
  error: string | null;
}

export async function submitJob(sessionId: string, file: File | Blob, filename: string) {
  const form = new FormData();
  form.append("file", file, filename);
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/jobs`, {
    method: "POST",
    body: form,
    credentials: "include", // carries the Cloudflare Access session cookie
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as { job_id: string; status: JobStatus };
}

export async function getQueue(sessionId: string): Promise<QueueItem[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/queue`, { credentials: "include" });
  if (!res.ok) throw new Error(`queue fetch failed: ${res.status}`);
  return res.json();
}

export async function cancelJob(sessionId: string, jobId: string) {
  await fetch(`${API_BASE}/sessions/${sessionId}/jobs/${jobId}/cancel`, {
    method: "POST",
    credentials: "include",
  });
}

export async function pauseQueue() {
  await fetch(`${API_BASE}/queue/pause`, { method: "POST", credentials: "include" });
}

export async function resumeQueue() {
  await fetch(`${API_BASE}/queue/resume`, { method: "POST", credentials: "include" });
}

export function downloadUrl(sessionId: string, format: "png" | "pdf") {
  return `${API_BASE}/sessions/${sessionId}/download?format=${format}`;
}
