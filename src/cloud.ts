import type { OutputFormat } from "./conversion";

type ConversionProgress = (value: number, label: string) => void;
export type ReviewQuestion = {
  block: string;
  suggested_label: string | null;
  confidence: number | null;
  previous_context: string[];
  next_context: string[];
  labels: { id: string; description: string }[];
  style_rules: string | null;
  expiresAt: number;
};
type ReviewHandler = (
  question: ReviewQuestion,
  answer: (label: string) => Promise<void>,
) => void;

export async function convertInCloud(
  file: File,
  format: OutputFormat,
  mode: "scan" | "inference",
  onProgress: ConversionProgress,
  onReview: ReviewHandler,
): Promise<{ blob: Blob; filename: string; pages: number }> {
  onProgress(5, "Subiendo archivo al servicio…");
  const body = new FormData();
  body.append("file", file);
  body.append("format", format);
  body.append("mode", mode);
  const sessionId = crypto.randomUUID();
  body.append("sessionId", sessionId);
  let finished = false;
  let currentReview = "";
  const monitorReviews = async () => {
    while (!finished && mode === "inference") {
      try {
        const reviewResponse = await fetch(
          `/api/conversions/review/${sessionId}`,
          { cache: "no-store" },
        );
        const question = (await reviewResponse.json()) as ReviewQuestion | null;
        if (question) {
          const key = `${question.block}:${question.expiresAt}`;
          if (key !== currentReview) {
            currentReview = key;
            onReview(question, async (label) => {
              await fetch(`/api/conversions/review/${sessionId}/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label }),
              });
            });
          }
        } else {
          currentReview = "";
        }
      } catch {
        // A temporary poll failure should not interrupt the conversion.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  };
  const reviewMonitor = monitorReviews();
  let response: Response;
  try {
    response = await fetch("/api/conversions", { method: "POST", body });
  } finally {
    finished = true;
    await reviewMonitor;
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      detail?.message ?? "El servicio en nube no pudo completar la conversión.",
    );
  }
  onProgress(90, "Descargando resultado…");
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename = encodedFilename
    ? decodeURIComponent(encodedFilename)
    : `${file.name.replace(/\.pdf$/i, "")}.${format === "epub" ? "epub" : "zip"}`;
  const blob = await response.blob();
  onProgress(100, "Conversión completada");
  return { blob, filename, pages: 0 };
}
