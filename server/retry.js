// Gemini fails in two ways that look alike but need opposite handling.
//
// 5xx means the model is momentarily out of capacity ("experiencing high
// demand"). Those clear in a second or two, so retrying in-request is worth it.
//
// 429 means a quota was exceeded, and on the free tier that quota is
// per-minute. Retrying inside the request spends the very budget it is waiting
// on and still returns an error, just slower, so it fails immediately with a
// message the UI can show.
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

export class ModelUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelUnavailableError";
    this.status = 503;
  }
}

export async function withGeminiRetry(call, { attempts = 3, baseDelayMs = 600 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (err?.status === 429) {
        throw new ModelUnavailableError("Too many requests just now. Wait a moment and try again.");
      }
      if (!TRANSIENT_STATUSES.has(err?.status)) throw err;
      if (attempt >= attempts) {
        throw new ModelUnavailableError("The nutrition model is busy. Give it a moment and try again.");
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`Gemini returned ${err.status}; retrying in ${delayMs}ms (${attempt}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
