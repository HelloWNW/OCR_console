const API_BASE = import.meta.env.VITE_API_BASE ?? "https://api.hello-wnw.org";
// Defense-in-depth behind Cloudflare Access, checked by the backend's
// _check_key(). Baking it into the public bundle is fine here since Access
// already gates network access to the API host - this just stops requests
// that reach the origin some other way.
const API_KEY = import.meta.env.VITE_DVD_API_KEY ?? "";

export type JobStatus = "queued" | "processing" | "done" | "error" | "canceled";

export interface QueueItem {
  job_id: string;
  filename: string;
  status: JobStatus;
  error: string | null;
}

function authHeaders(): HeadersInit {
  return API_KEY ? { "X-Api-Key": API_KEY } : {};
}

export async function submitJob(sessionId: string, file: File | Blob, filename: string) {
  const form = new FormData();
  form.append("file", file, filename);
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/jobs`, {
    method: "POST",
    body: form,
    headers: authHeaders(),
    credentials: "include", // carries the Cloudflare Access session cookie
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as { job_id: string; status: JobStatus };
}

export async function getQueue(sessionId: string): Promise<QueueItem[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/queue`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`queue fetch failed: ${res.status}`);
  return res.json();
}

export async function cancelJob(sessionId: string, jobId: string) {
  await fetch(`${API_BASE}/sessions/${sessionId}/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "include",
  });
}

export async function pauseQueue() {
  await fetch(`${API_BASE}/queue/pause`, { method: "POST", headers: authHeaders(), credentials: "include" });
}

export async function resumeQueue() {
  await fetch(`${API_BASE}/queue/resume`, { method: "POST", headers: authHeaders(), credentials: "include" });
}

// Plain <a href> can't set custom headers, so the download link falls back
// to a query-param key - the backend accepts either.
export function downloadUrl(sessionId: string, format: "png" | "pdf") {
  const key = API_KEY ? `&key=${encodeURIComponent(API_KEY)}` : "";
  return `${API_BASE}/sessions/${sessionId}/download?format=${format}${key}`;
}

// A single job's result image, used by the result-preview dialog. Fetched
// as an authenticated blob (same header limitation as above doesn't apply
// here since this is a JS fetch, not a plain <img src>) and handed back as
// an object URL the caller must revoke when done with it.
export async function fetchJobResult(sessionId: string, jobId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/jobs/${jobId}/result`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`result fetch failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
