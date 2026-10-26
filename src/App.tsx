import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  BookOpenCheck,
  Check,
  CircleHelp,
  Download,
  FileText,
  Files,
  HardDrive,
  LockKeyhole,
  Menu,
  ScanText,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { processPdfBatch, type OutputFormat, type RecoveredImage, type BookMetadata, type CoverAsset, type CoverSelection, type CoverSelectionRequest } from "./conversion";
import { BookcliWasmClient } from "@semantica/semantica-wasm/client";
import type {
  ClassificationEvent,
  BookcliLabel,
  InferenceSettings,
  ReviewQuestion,
  ReviewHandler as WasmReviewHandler,
} from "@semantica/semantica-wasm/browser";
import Reader, { type ReaderDocument, type ReaderFormat } from "./Reader";
import { getConversionFile, saveConversionFiles } from "./session-files";

type Section = "inicio" | "convertir" | "biblioteca" | "lector" | "documentacion" | "configuracion";
type AppInferenceSettings = InferenceSettings & { ocrLanguages: string; ocrRenderScale: number; ocrPageMode: "auto" | "single-column" };
type CoverReviewState = {
  request: CoverSelectionRequest;
  selectedId: string;
  metadata: BookMetadata;
  cover: CoverAsset | null;
  expiresAt: number;
  remainingMs: number;
  paused: boolean;
  resolve: (selection: CoverSelection) => void;
};
type QueueItem = {
  id: string;
  file: File;
  status: "queued" | "processing" | "done" | "error";
  error?: string;
};
const SETTINGS_KEY = "semantica-inference-settings";
const LAYA_MODEL_BACKUP_URL = "https://raw.githubusercontent.com/SemanticaBook/laya-weights/main/";
const LAYA_MODEL_DEFAULT_URL = "https://huggingface.co/SemanticaBook/semantica-laya-multilingual-onnx/resolve/main/";
const DEFAULT_SETTINGS: AppInferenceSettings = {
  instructions: "Clasifica SOLO el bloque entre [BLOQUE A CLASIFICAR] y su cierre. Usa el contexto anterior y posterior como referencia, no lo clasifiques. No corrijas, resumas ni inventes contenido. Clasifica el texto tal como aparece. Distingue title (título de obra), heading (capítulo/sección), subheading (subsección), paragraph (prosa), list_item (lista), caption (leyenda), noise (ruido OCR) y other (contenido válido restante). Los números de página suelen ser noise. Un índice es list_item, no heading.",
  minContextLevel: 3,
  maxContextLevel: 5,
  autoAcceptThreshold: 0.85,
  keepNoise: true,
  ocrLanguages: "spa+eng",
  ocrRenderScale: 2.2,
  ocrPageMode: "single-column",
};
function readInferenceSettings(): AppInferenceSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    return value ? { ...DEFAULT_SETTINGS, ...value } : DEFAULT_SETTINGS;
  } catch { return DEFAULT_SETTINGS; }
}
function describeModelLoadError(cause: unknown) {
  const detail = cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause || "Error desconocido al cargar Laya.");
  if (/memory|allocate|out of memory|array buffer|memoria/i.test(detail)) {
    const diagnostics: string[] = [];
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (deviceMemory) diagnostics.push(`RAM total estimada por el navegador: ${deviceMemory} GB; no representa RAM libre.`);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (memory) {
      const used = memory.usedJSHeapSize / (1024 * 1024);
      const limit = memory.jsHeapSizeLimit / (1024 * 1024);
      diagnostics.push(`Heap JS de Chromium: ${used.toFixed(0)} MiB usados de ${limit.toFixed(0)} MiB; quedan aproximadamente ${Math.max(0, limit - used).toFixed(0)} MiB de heap. Esta cifra no incluye toda la memoria del sistema.`);
    } else {
      diagnostics.push("Este navegador no expone la memoria libre del sistema; no es posible medir con precisión cuánto RAM queda disponible desde una página web.");
    }
    const size = /(?:pesos|modelo|verificar)[^\d]{0,40}(\d+(?:\.\d+)?)\s*MiB/i.exec(detail)?.[1];
    if (size) diagnostics.push(`Los pesos ocupan ${size} MiB. La inicialización necesita además memoria para el runtime WASM y la sesión; el pico puede superar ampliamente ese tamaño.`);
    diagnostics.push("Cierra otras pestañas y aplicaciones y vuelve a intentar.");
    return `${detail} ${diagnostics.join(" ")}`;
  }
  if (/quota|storage|cache|disk/i.test(detail)) {
    return `${detail} El almacenamiento del navegador está lleno o bloqueado. Libera espacio del sitio y vuelve a intentar.`;
  }
  if (/fetch|network|download|descarga|40[134]|failed to load|modelo|CORS/i.test(detail)) {
    return `${detail} Semantica intenta primero la fuente principal y, si falla, el respaldo versionado de GitHub. Ambos deben ser públicos y permitir solicitudes CORS; los bloques descargados se verifican y se guardan en Cache Storage.`;
  }
  if (/webgpu|wasm|simd|runtime|onnx/i.test(detail)) {
    return `${detail} Actualiza el navegador a una versión reciente de Chrome o Firefox y vuelve a cargar.`;
  }
  return detail;
}
type Job = {
  id: string;
  name: string;
  date: string;
  format: string;
  status: string;
  size: string;
};
type ActiveReview = ReviewQuestion & {
  answer: (label: string) => Promise<void>;
};

const HISTORY_KEY = "semantica-conversion-history";

function readSessionJobs(): Job[] {
  try {
    const saved = sessionStorage.getItem(HISTORY_KEY);
    const parsed = saved ? (JSON.parse(saved) as Job[]) : [];
    return Array.isArray(parsed)
      ? parsed.filter((job) => typeof job?.id === "string")
      : [];
  } catch {
    return [];
  }
}

async function loadLayaClientWithBackup(
  onProgress: (label: string, value: number) => void,
): Promise<BookcliWasmClient> {
  const primaryUrl = import.meta.env.VITE_LAYA_MODEL_BASE_URL || LAYA_MODEL_DEFAULT_URL;
  try {
    return await BookcliWasmClient.load(primaryUrl, onProgress);
  } catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const memoryFailure = /memory|allocate|out of memory|array buffer|memoria/i.test(detail);
    const sourceUnavailable = !memoryFailure && /40[134]|failed to fetch|network|download|descarga|manifest|CORS|recurso del modelo|No se pudo cargar|no pudo descargar|HTTP 5\d\d/i.test(detail);
    if (!sourceUnavailable || primaryUrl.replace(/\/$/, "") === LAYA_MODEL_BACKUP_URL.replace(/\/$/, "")) throw cause;
    onProgress("No se pudo recuperar la fuente principal; descargando el respaldo versionado…", 0);
    return BookcliWasmClient.load(LAYA_MODEL_BACKUP_URL, onProgress);
  }
}

function App() {
  const [section, setSection] = useState<Section>("inicio");
  const [inferenceSettings, setInferenceSettings] = useState<AppInferenceSettings>(readInferenceSettings);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [format, setFormat] = useState<OutputFormat>("epub");
  const [useOcr, setUseOcr] = useState(true);
  const [useWasmClassifier, setUseWasmClassifier] = useState(true);
  const [wasmClassifier, setWasmClassifier] =
    useState<BookcliWasmClient | null>(null);
  const wasmLoadPromiseRef = useRef<Promise<BookcliWasmClient | null> | null>(null);
  const [wasmLoading, setWasmLoading] = useState(false);
  const [wasmProgress, setWasmProgress] = useState(0);
  const [wasmStatus, setWasmStatus] = useState("");
  const [wasmError, setWasmError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [activeReview, setActiveReview] = useState<ActiveReview | null>(null);
  const [coverReview, setCoverReview] = useState<CoverReviewState | null>(null);
  const [reviewNow, setReviewNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>(readSessionJobs);
  const [readerDocument, setReaderDocument] = useState<ReaderDocument | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [extractionMode, setExtractionMode] = useState<"text" | "ocr">("text");
  const [recoveredImages, setRecoveredImages] = useState<RecoveredImage[]>([]);
  const [classificationEvent, setClassificationEvent] =
    useState<ClassificationEvent | null>(null);
  const [classificationResults, setClassificationResults] = useState<Record<number, BookcliLabel>>({});
  const [libraryError, setLibraryError] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const readerInputRef = useRef<HTMLInputElement>(null);
  const processingScrollRef = useRef<HTMLDivElement>(null);
  const currentBlockRef = useRef<HTMLDivElement>(null);
  const notificationAudioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(jobs));
    } catch {
      // The conversion remains usable if browser storage is unavailable.
    }
  }, [jobs]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(inferenceSettings));
  }, [inferenceSettings]);

  async function loadWasmModel(): Promise<BookcliWasmClient | null> {
    if (wasmClassifier) return wasmClassifier;
    if (wasmLoadPromiseRef.current) return wasmLoadPromiseRef.current;
    setWasmLoading(true);
    setError("");
    setWasmStatus("");
    setWasmError("");
    const loading = (async () => {
      try {
      const classifier = await loadLayaClientWithBackup((label, value) => {
          setWasmStatus(label);
          setWasmProgress(value);
        });
      setWasmClassifier(classifier);
      setWasmStatus("Modelo Laya listo en este dispositivo");
      return classifier;
    } catch (cause) {
      const detail = describeModelLoadError(cause);
      setWasmError(detail);
      setWasmStatus("No se pudo iniciar el modelo Laya");
      return null;
    } finally {
      setWasmLoading(false);
      wasmLoadPromiseRef.current = null;
      }
    })();
    wasmLoadPromiseRef.current = loading;
    return loading;
  }

  const reviewLocally: WasmReviewHandler = (question) =>
    new Promise((resolve) => {
      signalNotification("question", "Laya necesita tu ayuda", "Hay un bloque que necesita clasificación.");
      const timeout = window.setTimeout(
        () => {
          const update = () => setActiveReview(null);
          const transitions = document as Document & {
            startViewTransition?: (callback: () => void) => unknown;
          };
          if (transitions.startViewTransition) transitions.startViewTransition(update);
          else update();
          resolve(question.suggested_label);
        },
        Math.max(0, question.expiresAt - Date.now()),
      );
      setReviewNow(Date.now());
      const update = () => setActiveReview({
          ...question,
          answer: async (label) => {
            window.clearTimeout(timeout);
            resolve(label as typeof question.suggested_label);
          },
        });
      const transitions = document as Document & {
        startViewTransition?: (callback: () => void) => unknown;
      };
      if (transitions.startViewTransition) transitions.startViewTransition(update);
      else update();
    });

  useEffect(() => {
    if (!activeReview && !coverReview) return;
    const timer = window.setInterval(() => setReviewNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [activeReview, coverReview]);

  function finishCoverReview(selection?: CoverSelection, automatic = false) {
    if (!coverReview) return;
    coverReview.resolve(selection ?? { metadata: coverReview.metadata, cover: coverReview.cover, automatic });
    setCoverReview(null);
  }

  useEffect(() => {
    if (coverReview && !coverReview.paused && reviewNow >= coverReview.expiresAt) {
      finishCoverReview(undefined, true);
    }
  }, [coverReview, reviewNow]);

  function prepareNotifications() {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
    try {
      if (!notificationAudioRef.current && typeof window.AudioContext !== "undefined") {
        notificationAudioRef.current = new window.AudioContext();
      }
      void notificationAudioRef.current?.resume().catch(() => undefined);
    } catch {
      // Notifications are an enhancement; conversion still runs if audio is unavailable.
    }
  }

  function signalNotification(kind: "question" | "complete", title: string, body: string) {
    const context = notificationAudioRef.current;
    try {
    if (context?.state === "running") {
      const notes = kind === "question" ? [660, 880] : [523, 659, 784];
      const startAt = context.currentTime;
      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const at = startAt + index * 0.14;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.055, at + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.13);
      });
    }
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      document.visibilityState === "hidden"
    ) {
      new Notification(title, {
          body,
          tag: `semantica-${kind}-${Date.now()}`,
          silent: true,
        });
    }
    } catch {
      // Browser notification and audio APIs may be restricted by user settings.
    }
  }

  useEffect(() => {
    const viewport = processingScrollRef.current;
    const block = currentBlockRef.current;
    if (viewport && block) {
      const viewportRect = viewport.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      viewport.scrollTo({
        top: viewport.scrollTop + blockRect.top - viewportRect.top - viewport.clientHeight / 2 + blockRect.height / 2,
        behavior: "smooth",
      });
    }
  }, [classificationEvent?.index, classificationEvent?.phase]);

  function addFiles(selected?: FileList | File[]) {
    if (!selected || busy) return;
    const incoming = Array.from(selected);
    const pdfs = incoming.filter((item) => item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf"));
    const rejected = incoming.length - pdfs.length;
    setQueue((current) => {
      const known = new Set(current.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
      const additions: QueueItem[] = [];
      for (const file of pdfs) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (known.has(key)) continue;
        known.add(key);
        additions.push({ id: crypto.randomUUID(), file, status: "queued" });
      }
      return [
        ...current,
        ...additions,
      ];
    });
    setError(rejected ? "Se omitieron los archivos que no son PDF." : "");
    if (inputRef.current) inputRef.current.value = "";
  }

  function removeQueueItem(id: string) {
    if (busy) return;
    setQueue((current) => current.filter((item) => item.id !== id));
  }

  function openReaderFile(next?: File) {
    if (!next) return;
    const extension = next.name.split(".").pop()?.toLowerCase();
    const format: ReaderFormat | null = extension === "pdf"
      ? "pdf"
      : extension === "epub"
        ? "epub"
        : extension === "md" || extension === "markdown"
          ? "markdown"
          : null;
    if (!format) {
      setError("El lector acepta archivos PDF, EPUB y Markdown.");
      return;
    }
    setReaderDocument({ name: next.name, format, blob: next });
    setError("");
    navigate("lector");
  }

  async function openHistoryFile(job: Job, format: ReaderFormat) {
    try {
      setLibraryError("");
      const blob = await getConversionFile(job.id, format);
      const name = format === "pdf"
        ? job.name
        : `${job.name.replace(/\.pdf$/i, "")}.${format === "markdown" ? "md" : format}`;
      setReaderDocument({ name, format, blob });
      navigate("lector");
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : "No se pudo abrir el archivo guardado.");
    }
  }

  async function downloadHistoryFile(job: Job, format: ReaderFormat) {
    try {
      setLibraryError("");
      const blob = await getConversionFile(job.id, format);
      const name = format === "pdf"
        ? job.name
        : `${job.name.replace(/\.pdf$/i, "")}.${format === "markdown" ? "md" : format}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : "No se pudo descargar el archivo guardado.");
    }
  }

  async function startConversion() {
    const pending = queue.filter((item) => item.status === "queued" || item.status === "error");
    if (!pending.length || busy) return;
    prepareNotifications();
    setBusy(true);
    setError("");
    setProgress(0);
    setCoverReview(null);
    try {
      let classifier: BookcliWasmClient | undefined = wasmClassifier ?? undefined;
      if (useWasmClassifier && !classifier) {
        setProgressText("Descargando e iniciando Laya en este dispositivo…");
        const loadedClassifier = await loadWasmModel();
        classifier = loadedClassifier ?? undefined;
        if (!classifier) throw new Error(wasmError || "No se pudo cargar Laya desde la fuente configurada del modelo.");
      }
      const failures: string[] = [];
      let completed = 0;
      let currentFile = pending[0].file;
      await processPdfBatch(
        pending.map((item) => item.file),
        format,
        useOcr,
        (fileIndex, total, value, label) => {
          const item = pending[fileIndex - 1];
          currentFile = item.file;
          if (label === "Preparando el PDF…") {
            setQueue((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "processing", error: undefined } : entry));
            setOcrText("");
            setExtractionMode("text");
            setRecoveredImages([]);
            setClassificationEvent(null);
            setClassificationResults({});
            setCoverReview(null);
          }
          setProgress(Math.round(((fileIndex - 1 + value / 100) / total) * 95));
          setProgressText(`${currentFile.name} · ${label}`);
        },
        {
              classifier: useWasmClassifier ? classifier : undefined,
              bookMetadata: { mode: "manual", googleBooksApiKey: import.meta.env.VITE_GOOGLE_BOOKS_API_KEY },
              onReview: useWasmClassifier ? reviewLocally : undefined,
              onOcrText: setOcrText,
              onExtractionMode: setExtractionMode,
              onCoverSelection: format === "epub"
                ? (request) => new Promise<CoverSelection>((resolve) => {
                    const suggested = request.candidates[0];
                    const hasOriginal = Boolean(request.originalCoverDataUrl);
                    setReviewNow(Date.now());
                    setProgressText(`${currentFile.name} · elige portada y metadatos`);
                    setCoverReview({
                      request,
                      selectedId: suggested?.id ?? (hasOriginal ? "original" : "none"),
                      metadata: suggested?.metadata ?? request.initialMetadata,
                      cover: suggested
                        ? { url: suggested.coverUrl }
                        : hasOriginal
                          ? { dataUrl: request.originalCoverDataUrl }
                          : null,
                      expiresAt: Date.now() + 180_000,
                      remainingMs: 180_000,
                      paused: false,
                      resolve,
                    });
                  })
                : undefined,
              onClassification: (event) => {
                setClassificationEvent(event);
                if (event.phase === "decided" && event.label) {
                  setClassificationResults((current) => ({ ...current, [event.index]: event.label! }));
                }
              },
              onImageRecovered: (image) => setRecoveredImages((current) => [...current, image]),
              inferenceSettings,
        },
        {
          onResult: async (result, fileIndex, _total, file) => {
            const item = pending[fileIndex - 1];
            const id = crypto.randomUUID();
            setProgress(Math.round((fileIndex / pending.length) * 96));
            setProgressText(`${file.name} · guardando los archivos`);
            await saveConversionFiles({ id, pdf: result.pdfBlob, epub: result.epubBlob, markdown: result.markdownBlob });
            const url = URL.createObjectURL(result.blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = result.filename;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
            setJobs((current) => [
              {
                id,
                name: file.name,
                date: new Intl.DateTimeFormat("es-MX", { dateStyle: "short", timeStyle: "short" }).format(new Date()),
                format: format.toUpperCase(),
                status: "Listo",
                size: `${result.pages} páginas`,
              },
              ...current,
            ]);
            setQueue((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "done", error: undefined } : entry));
            setActiveReview(null);
            completed += 1;
          },
          onError: (cause, fileIndex, _total, file) => {
            const item = pending[fileIndex - 1];
            const detail = cause instanceof Error ? cause.message : "No se pudo procesar el PDF.";
            failures.push(`${file.name}: ${detail}`);
            setQueue((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "error", error: detail } : entry));
            setActiveReview(null);
            setCoverReview(null);
          },
        },
      );
      setProgress(100);
      setProgressText(`Lote completado · ${completed} de ${pending.length} PDFs procesados`);
      setError(failures.length ? failures.join("\n") : "");
      signalNotification("complete", "Lote de conversiones completado", `${completed} de ${pending.length} archivos listos${failures.length ? `; ${failures.length} con error` : ""}.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "No se pudo iniciar el lote de PDFs.",
      );
      setActiveReview(null);
    } finally {
      setBusy(false);
    }
  }

  const navigate = (next: Section) => {
    setSection(next);
    setMobileOpen(false);
  };

  if (section === "inicio") {
    return (
      <main className="landing-page">
        <header className="landing-header">
          <a className="landing-brand" href="#inicio" aria-label="Semantica, inicio">
            <img
    className="brand-logo"
    src={`${import.meta.env.BASE_URL}imagenes/logo.png`}
    alt=""
  />
            <span>semantica<span className="brand-period">.</span></span>
          </a>
          <nav className="landing-nav" aria-label="Navegación de la página">
            <a href="#como-funciona">Cómo funciona</a>
            <a href="#acerca">Acerca de</a>
            <button onClick={() => navigate("documentacion")}>Documentación</button>
          </nav>
          <button className="landing-header-cta" onClick={() => navigate("convertir")}>
            Abrir Semantica <ArrowRight size={15} />
          </button>
        </header>

        <section className="landing-hero" id="inicio">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> LECTURA DIGITAL, CON SENTIDO</div>
            <h1>Un PDF puede volver a sentirse como un <em>libro.</em></h1>
            <p>Convierte tus PDFs a EPUB o Markdown. Semantica recupera títulos, párrafos y capítulos con modelos locales, incluso cuando el documento viene de un escaneo.</p>
            <div className="hero-actions">
              <button className="hero-primary" onClick={() => navigate("convertir")}>
                Empezar a convertir <ArrowRight size={17} />
              </button>
              <a className="hero-secondary" href="#como-funciona">Conoce cómo funciona <ArrowDownToLine size={15} /></a>
            </div>
            <div className="hero-trust"><span><LockKeyhole size={14} /> Procesamiento en tu dispositivo</span><i /> Sin instalar <i /> Sin pagar
            </div>
          </div>
          <div className="hero-art" aria-label="Ilustración de un PDF que se transforma en un libro EPUB">
            <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
            <div className="pdf-sheet parallax-sheet"><span className="pdf-label">DOCUMENTO PDF</span><span className="pdf-title-line" /><span className="pdf-line wide" /><span className="pdf-line" /><span className="pdf-heading-line" /><span className="pdf-line wide" /><span className="pdf-line" /><span className="pdf-line short" /><span className="pdf-stamp">PDF</span></div>
            <div className="transform-mark"><Sparkles size={19} /><span>estructura<br />recuperada</span></div>
            <div className="epub-book parallax-book"><div className="book-spine" /><span className="epub-label">SEMANTICA</span><span className="epub-rule" /><strong>El placer<br />de leer</strong><small>EPUB · LISTO</small></div>
            <span className="art-spark spark-a">✳</span><span className="art-spark spark-b">✳</span>
            <div className="art-caption"><span className="status-dot" /> Tu biblioteca, en un formato más cómodo</div>
          </div>
          <a className="scroll-cue" href="#como-funciona"><span /> Desliza para explorar</a>
        </section>

        <section className="landing-benefits" id="como-funciona">
          <div className="section-intro">
            <div className="eyebrow"><span className="eyebrow-line" /> DE PDF A LECTURA</div>
            <h2>El texto importa.<br /><em>Su estructura también.</em></h2>
            <p>Un PDF guarda páginas. Semantica ayuda a encontrar el libro que hay dentro.</p>
          </div>
          <div className="benefit-grid">
            <article className="benefit-card"><span className="benefit-index">01</span><span className="benefit-icon"><ScanText size={20} /></span><h3>Lee incluso los escaneos</h3><p>El OCR reconoce el texto de cada página cuando el PDF no tiene una capa de texto seleccionable.</p></article>
            <article className="benefit-card"><span className="benefit-index">02</span><span className="benefit-icon"><Sparkles size={20} /></span><h3>Reconstruye la estructura</h3><p>Un modelo pequeño identifica títulos, capítulos, párrafos y fragmentos que no aportan al contenido.</p></article>
            <article className="benefit-card"><span className="benefit-index">03</span><span className="benefit-icon"><BookOpen size={20} /></span><h3>Elige cómo seguir</h3><p>Genera un EPUB para tu lector electrónico o Markdown para trabajar con el texto.</p></article>
          </div>
        </section>

        <section className="landing-process">
          <div className="process-visual"><div className="process-page"><span>CAPÍTULO III</span><i /><i /><i /><b>Una historia<br />por descubrir</b><i /><i /><i /></div><div className="process-tag tag-title"><span /> Título detectado</div><div className="process-tag tag-text"><span /> Párrafo conservado</div><div className="process-tag tag-noise"><span /> Ruido descartado</div></div>
          <div className="process-copy"><div className="eyebrow"><span className="eyebrow-line" /> INTELIGENCIA LOCAL</div><h2>Una lectura más clara, sin mandar tus archivos a otro lado.</h2><p>Semantica ejecuta el reconocimiento y la clasificación en tu navegador. Los modelos Laya son compactos y especializados: ayudan a recuperar la jerarquía del documento usando los recursos de tu equipo.</p><ul><li><Check size={16} /> Tus PDFs permanecen en tu dispositivo</li><li><Check size={16} /> Sin cuenta, suscripción ni instalación</li><li><Check size={16} /> Revisa las decisiones cuando el modelo tenga dudas</li></ul><button className="text-link" onClick={() => navigate("documentacion")}>Lee la documentación <ArrowRight size={15} /></button></div>
        </section>

        <section className="about-section" id="acerca">
          <div className="about-mark"><BookOpen size={27} /><span>Una idea<br />para leer mejor.</span></div>
          <div className="about-copy"><div className="eyebrow"><span className="eyebrow-line" /> ACERCA DE SEMANTICA</div><h2>Nació de un lector de bolsillo y un PDF incómodo.</h2><p>Compré un lector electrónico y descubrí que leer PDFs en una pantalla pequeña no era lo que esperaba. Convertir cada libro a EPUB a mano tomaba demasiado tiempo. Así nació Semantica: primero como una librería para transformar PDFs y después como una forma de resolver algo más difícil.</p><p>Los documentos escaneados y los PDFs sin estructura necesitan un procesamiento más cuidadoso. La idea es recuperar sus títulos, párrafos y capítulos con modelos pequeños que puedan ejecutarse localmente, sin instalaciones ni costos de servicio.</p></div>
        </section>

        <section className="landing-cta">
          <span className="cta-decoration">✳</span><div className="eyebrow">TU PRÓXIMO LIBRO TE ESPERA</div><h2>Haz espacio para una<br /><em>mejor lectura.</em></h2><button className="hero-primary" onClick={() => navigate("convertir")}>Iniciar Semantica <ArrowRight size={17} /></button><small>Gratis · Local · Sin cuenta</small>
        </section>
        <footer className="landing-footer"><a className="landing-brand" href="#inicio">
<img
    className="brand-logo-mini"
    src={`${import.meta.env.BASE_URL}imagenes/logo.png`}
    alt=""
  />
<span>semantica<span className="brand-period">.</span></span></a><span>Una nueva forma de volver a tus libros.</span><button onClick={() => navigate("documentacion")}>Documentación <ArrowRight size={14} /></button></footer>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <a
          className="brand"
          href="#inicio"
          onClick={() => navigate("inicio")}
        >
          <img
    className="brand-logo-mini"
    src={`${import.meta.env.BASE_URL}imagenes/logo.png`}
    alt=""
  />
          <span>
            semantica<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">ESPACIO DE TRABAJO</div>
        <nav className="primary-nav" aria-label="Principal">
          <button
            className={section === "convertir" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("convertir")}
          >
            <Sparkles size={17} /> Convertir
          </button>
          <button
            className={
              section === "biblioteca" ? "nav-item active" : "nav-item"
            }
            onClick={() => navigate("biblioteca")}
          >
            <Files size={17} /> Mi biblioteca{" "}
            <span className="nav-count">{jobs.length}</span>
          </button>
          <button
            className={section === "lector" ? "nav-item active" : "nav-item"}
            onClick={() => { readerInputRef.current?.click(); }}
          >
            <BookOpenCheck size={17} /> Abrir lector
          </button>
        </nav>
        <div className="workspace-label nav-spacer">RECURSOS</div>
        <nav className="primary-nav">
          <button
            className={
              section === "documentacion" ? "nav-item active" : "nav-item"
            }
            onClick={() => navigate("documentacion")}
          >
            <CircleHelp size={17} /> Documentación
          </button>
          <button className={section === "configuracion" ? "nav-item active" : "nav-item"} onClick={() => navigate("configuracion")}>
            <ScanText size={17} /> Inferencia
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            <span>
              <strong>Procesamiento local</strong>
              <small>Tus archivos no salen de tu equipo</small>
            </span>
          </div>
          <button className="account-button" onClick={() => navigate("inicio")}>
            <span className="avatar"><BookOpen size={14} /></span>
            <span><strong>Semantica</strong><small>Conversión local</small></span>
            <ArrowRight size={15} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Abrir menú"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            Semantica <span>/</span> <strong>{sectionLabel(section)}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-chip">
              <HardDrive size={14} /> Modo local
            </span>
          </div>
        </header>
        <input
          ref={readerInputRef}
          type="file"
          accept=".pdf,.epub,.md,.markdown,application/pdf,application/epub+zip,text/markdown"
          hidden
          onChange={(event) => {
            openReaderFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        {section === "lector" && readerDocument && (
          <Reader file={readerDocument} onClose={() => navigate("biblioteca")} />
        )}

        {section === "configuracion" && (
          <section className="page-content inner-page inference-settings-page">
            <div className="eyebrow"><span className="eyebrow-line" /> CONFIGURACIÓN DE INFERENCIA</div>
            <h1>Cómo analiza Semantica.</h1>
            <p className="intro-copy">Ajusta el contexto de Laya y el reconocimiento OCR. Estas preferencias se guardan localmente en este navegador.</p>
            <div className="settings-grid">
              <article className="settings-card settings-wide">
                <div className="field-label">INSTRUCCIONES PARA LAYA</div>
                <p className="field-hint">Guían la clasificación estructural de cada bloque.</p>
                <textarea value={inferenceSettings.instructions} rows={7} onChange={(event) => setInferenceSettings({ ...inferenceSettings, instructions: event.target.value })} />
              </article>
              <article className="settings-card">
                <div className="field-label">CONTEXTO MÍNIMO · {inferenceSettings.minContextLevel}</div>
                <p className="field-hint">Bloques anteriores y posteriores desde el primer ciclo. Por defecto empieza en 3.</p>
                <input type="range" min="1" max={inferenceSettings.maxContextLevel} value={inferenceSettings.minContextLevel} onChange={(event) => setInferenceSettings({ ...inferenceSettings, minContextLevel: Number(event.target.value) })} />
              </article>
              <article className="settings-card">
                <div className="field-label">CONTEXTO MÁXIMO · {inferenceSettings.maxContextLevel}</div>
                <p className="field-hint">Límite antes de preguntar. Máximo permitido: 5 bloques a cada lado.</p>
                <input type="range" min={inferenceSettings.minContextLevel} max="5" value={inferenceSettings.maxContextLevel} onChange={(event) => setInferenceSettings({ ...inferenceSettings, maxContextLevel: Number(event.target.value) })} />
              </article>
              <article className="settings-card">
                <div className="field-label">CONFIANZA PARA ACEPTAR · {Math.round(inferenceSettings.autoAcceptThreshold * 100)}%</div>
                <p className="field-hint">Por debajo de este nivel, Laya solicita revisión.</p>
                <input type="range" min="50" max="99" value={Math.round(inferenceSettings.autoAcceptThreshold * 100)} onChange={(event) => setInferenceSettings({ ...inferenceSettings, autoAcceptThreshold: Number(event.target.value) / 100 })} />
              </article>
              <article className="settings-card">
                <div className="field-label">IDIOMAS OCR TESSERACT</div>
                <p className="field-hint">Códigos separados por +, por ejemplo spa+eng.</p>
                <input value={inferenceSettings.ocrLanguages} onChange={(event) => setInferenceSettings({ ...inferenceSettings, ocrLanguages: event.target.value.replace(/[^a-z+]/gi, "") || "spa" })} />
              </article>
              <article className="settings-card">
                <div className="field-label">RESOLUCIÓN DE OCR · {inferenceSettings.ocrRenderScale.toFixed(1)}×</div>
                <p className="field-hint">Un valor mayor mejora escaneos pequeños, con más uso de memoria y tiempo.</p>
                <input type="range" min="1.5" max="3" step="0.1" value={inferenceSettings.ocrRenderScale} onChange={(event) => setInferenceSettings({ ...inferenceSettings, ocrRenderScale: Number(event.target.value) })} />
              </article>
              <article className="settings-card">
                <div className="field-label">SEGMENTACIÓN TESSERACT</div>
                <p className="field-hint">Una columna reduce la mezcla de texto con ilustraciones laterales.</p>
                <select value={inferenceSettings.ocrPageMode} onChange={(event) => setInferenceSettings({ ...inferenceSettings, ocrPageMode: event.target.value as AppInferenceSettings["ocrPageMode"] })}>
                  <option value="single-column">Una columna</option>
                  <option value="auto">Automática</option>
                </select>
              </article>
              <article className="settings-card settings-toggle-card">
                <div><div className="field-label">CONSERVAR BLOQUES DE RUIDO</div><p className="field-hint">Mantiene fragmentos clasificados como ruido OCR en la salida.</p></div>
                <button className={`toggle ${inferenceSettings.keepNoise ? "toggle-on" : ""}`} role="switch" aria-checked={inferenceSettings.keepNoise} onClick={() => setInferenceSettings({ ...inferenceSettings, keepNoise: !inferenceSettings.keepNoise })}><span /></button>
              </article>
              <button className="settings-reset" onClick={() => setInferenceSettings(DEFAULT_SETTINGS)}>Restablecer valores predeterminados</button>
            </div>
          </section>
        )}

        {section === "convertir" && (
          <section className="page-content convert-page">
            <div className="intro-row">
              <div>
                <div className="eyebrow">
                  <span className="eyebrow-line" /> CONVERSIÓN INTELIGENTE
                </div>
                <h1>
                  Tus PDFs, una nueva
                  <br className="desktop-break" /> forma de leer.
                </h1>
                <p className="intro-copy">
                  Añade varios archivos y conviértelos en orden, uno tras otro.
                  Todo ocurre en tu equipo, sin subir los PDFs a un servidor.
                </p>
              </div>
              <div className="book-illustration" aria-hidden="true">
                <div className="book-shadow" />
                <div className="book-cover">
                  <span className="cover-kicker">UN LIBRO</span>
                  <span className="cover-rule" />
                  <span className="cover-title">
                    en su
                    <br />
                    mejor forma
                  </span>
                  <span className="cover-author">SEMANTICA · 2025</span>
                </div>
                <span className="sparkle sparkle-one">✳</span>
                <span className="sparkle sparkle-two">✳</span>
              </div>
            </div>

            <div className="converter-layout">
              <div className="converter-main">
                <div
                  className={`dropzone ${queue.length ? "has-file has-queue" : ""} ${busy ? "queue-busy" : ""}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    addFiles(event.dataTransfer.files);
                  }}
                  onClick={() => !busy && inputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ")
                      inputRef.current?.click();
                  }}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    multiple
                    hidden
                    onChange={(event) => addFiles(event.currentTarget.files ?? undefined)}
                  />
                  {queue.length ? (
                    <>
                      <div className="file-queue">
                        {queue.map((item) => (
                          <div className={`file-queue-item queue-${item.status}`} key={item.id}>
                            <span className="file-icon"><FileText size={19} /></span>
                            <span className="file-info"><strong>{item.file.name}</strong><small>{(item.file.size / (1024 * 1024)).toFixed(2)} MB · {item.error ?? ({ queued: "En espera", processing: "Procesando", done: "Listo", error: "Error" }[item.status])}</small></span>
                            {item.status === "processing" && <span className="queue-item-spinner" aria-label="Procesando" />}
                            {item.status !== "processing" && !busy && <button className="remove-file icon-button" aria-label={`Quitar ${item.file.name}`} onClick={(event) => { event.stopPropagation(); removeQueueItem(item.id); }}><X size={16} /></button>}
                          </div>
                        ))}
                      </div>
                      <span className="queue-add-hint"><Upload size={15} /> Arrastra más PDFs o haz clic para agregarlos</span>
                    </>
                  ) : (
                    <>
                      <span className="upload-icon">
                        <Upload size={20} />
                      </span>
                      <span className="drop-copy">
                        <strong>Arrastra tu PDF aquí</strong>
                        <small>
                          o <span>explora tus archivos</span>
                        </small>
                      </span>
                      <span className="file-limit">PDF · selecciona varios archivos</span>
                    </>
                  )}
                </div>

                <div className="format-row">
                  <div>
                    <div className="field-label">FORMATO DE SALIDA</div>
                    <p className="field-hint">
                      Elige cómo quieres continuar la lectura.
                    </p>
                  </div>
                  <div
                    className="format-switch"
                    role="group"
                    aria-label="Formato de salida"
                  >
                    <button
                      className={
                        format === "epub"
                          ? "format-option selected"
                          : "format-option"
                      }
                      onClick={() => setFormat("epub")}
                    >
                      <BookOpen size={16} /> EPUB
                    </button>
                    <button
                      className={
                        format === "markdown"
                          ? "format-option selected"
                          : "format-option"
                      }
                      onClick={() => setFormat("markdown")}
                    >
                      <FileText size={16} /> Markdown
                    </button>
                  </div>
                </div>

                <div className="processing-row">
                  <span className="processing-icon">
                    <ScanText size={18} />
                  </span>
                  <span className="processing-copy">
                    <strong>
                      {useWasmClassifier
                        ? "OCR y estructura con Laya WASM"
                        : "OCR y estructura local"}
                    </strong>
                    <small>
                      {useWasmClassifier
                        ? "Laya multilingüe clasifica tus bloques en este dispositivo"
                        : "Reconoce escaneos y estima títulos y párrafos"}
                    </small>
                  </span>
                  <button
                    className={`toggle ${useOcr ? "toggle-on" : ""}`}
                    role="switch"
                    aria-checked={useOcr}
                    aria-label="Activar OCR"
                    onClick={() => setUseOcr(!useOcr)}
                  >
                    <span />
                  </button>
                </div>
                <>
                    <div className="local-engine-row">
                      <div>
                        <div className="field-label">CLASIFICADOR LOCAL</div>
                        <p className="field-hint">
                          {useWasmClassifier
                            ? "Laya multilingüe · inferencia WebAssembly"
                            : "Reglas rápidas · sin modelo descargable"}
                        </p>
                      </div>
                      <div
                        className="engine-switch"
                        role="group"
                        aria-label="Clasificador local"
                      >
                        <button
                          className={useWasmClassifier ? "selected" : ""}
                          onClick={() => setUseWasmClassifier(true)}
                        >
                          Laya WASM
                        </button>
                        <button
                          className={!useWasmClassifier ? "selected" : ""}
                          onClick={() => setUseWasmClassifier(false)}
                        >
                          Reglas
                        </button>
                      </div>
                    </div>
                    {useWasmClassifier && (
                      <div className="wasm-model-row">
                        <span
                          className={`model-status-dot ${wasmClassifier ? "ready" : wasmLoading ? "loading" : ""}`}
                        />
                        <div className="wasm-model-copy">
                          <strong>
                            {wasmClassifier
                              ? "Modelo listo en este dispositivo"
                              : wasmLoading
                                ? wasmStatus
                                : wasmError
                                  ? "No se pudo cargar el modelo"
                                  : "Modelo multilingüe no cargado"}
                          </strong>
                          <small>
                            {wasmClassifier
                              ? "El modelo queda en la caché del navegador."
                              : wasmError
                                ? "Revisa el detalle del error y vuelve a intentar."
                                : "Descarga inicial de varios cientos de MB; se guarda localmente."}
                          </small>
                        </div>
                        {!wasmClassifier && (
                          <button
                            className="load-model-button"
                            disabled={wasmLoading}
                            onClick={() => void loadWasmModel()}
                          >
                            {wasmLoading ? `${wasmProgress}%` : "Cargar modelo"}
                          </button>
                        )}
                      </div>
                    )}
                    {wasmError && (
                      <div className="model-load-error" role="alert">
                        <strong>Detalle técnico</strong>
                        <span>{wasmError}</span>
                      </div>
                    )}
                    {wasmLoading && (
                      <div className="model-progress-track">
                        <span style={{ width: `${wasmProgress}%` }} />
                      </div>
                    )}
                </>
                <div className="processing-note">
                  <LockKeyhole size={14} />
                  <span>
                    El texto se extrae en tu navegador; el OCR solo se aplica a páginas escaneadas que lo necesitan. Tu archivo permanece en este dispositivo.
                  </span>
                </div>
                {error && (
                  <div className="error-message" role="alert">
                    {error}
                  </div>
                )}
                {busy && (
                  <ProcessingAnimation
                    text={ocrText}
                    extractionMode={extractionMode}
                    recoveredImages={recoveredImages}
                    event={classificationEvent}
                    decisions={classificationResults}
                    progressText={progressText}
                    reviewing={Boolean(activeReview)}
                    scrollRef={processingScrollRef}
                    blockRef={currentBlockRef}
                  />
                )}
                {busy && (
                  <div className="progress-wrap">
                    <div className="progress-caption">
                      <span>{progressText}</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="progress-track">
                      <span style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}
                {coverReview && (
                  <CoverReviewPanel
                    review={coverReview}
                    now={reviewNow}
                    onSelect={(id) => {
                      setCoverReview((current) => {
                        if (!current) return null;
                        if (id === "original") return {
                          ...current,
                          selectedId: id,
                          cover: current.request.originalCoverDataUrl
                            ? { dataUrl: current.request.originalCoverDataUrl }
                            : null,
                        };
                        const candidate = current.request.candidates.find((item) => item.id === id);
                        return candidate ? {
                          ...current,
                          selectedId: id,
                          metadata: candidate.metadata,
                          cover: { url: candidate.coverUrl },
                        } : current;
                      });
                    }}
                    onMetadataChange={(metadata) => setCoverReview((current) => current ? { ...current, metadata } : null)}
                    onCustomCover={(cover, id) => setCoverReview((current) => current ? { ...current, selectedId: id, cover } : null)}
                    onPause={() => setCoverReview((current) => {
                      if (!current) return null;
                      return current.paused
                        ? { ...current, paused: false, expiresAt: Date.now() + current.remainingMs }
                        : { ...current, paused: true, remainingMs: Math.max(0, current.expiresAt - Date.now()) };
                    })}
                    onConfirmStarting={() => setCoverReview((current) => current && !current.paused
                      ? { ...current, paused: true, remainingMs: Math.max(0, current.expiresAt - Date.now()) }
                      : current)}
                    onConfirm={(selection) => finishCoverReview(selection)}
                  />
                )}
                {activeReview && (
                  <section className="review-panel" aria-live="polite" style={{ viewTransitionName: "laya-question" }}>
                    <div className="review-header">
                      <span className="review-kicker">
                        REVISIÓN DE ESTRUCTURA
                      </span>
                      <span className="review-confidence">
                        {activeReview.confidence == null
                          ? "Confianza desconocida"
                          : `Confianza ${Math.round(activeReview.confidence * 100)}%`}
                      </span>
                    </div>
                    <h3>¿Qué deberíamos hacer con este texto?</h3>
                    {activeReview.previous_context.length > 0 && (
                      <div className="review-context context-before">
                        <span>CONTEXTO ANTERIOR</span>
                        {activeReview.previous_context.map((text, index) => (
                          <p key={`before-${index}`}>{text}</p>
                        ))}
                      </div>
                    )}
                    <div className="review-block">{activeReview.block}</div>
                    {activeReview.next_context.length > 0 && (
                      <div className="review-context context-after">
                        <span>CONTEXTO POSTERIOR</span>
                        {activeReview.next_context.map((text, index) => (
                          <p key={`after-${index}`}>{text}</p>
                        ))}
                      </div>
                    )}
                    {activeReview.style_rules && (
                      <p className="review-rule">
                        Indicios de estilo: {activeReview.style_rules}
                      </p>
                    )}
                    <div className="review-labels">
                      {activeReview.labels.map((label) => (
                        <button
                          key={label.id}
                          title={label.description}
                          className={
                            label.id === activeReview.suggested_label
                              ? "review-label suggested"
                              : "review-label"
                          }
                          onClick={() => {
                            void activeReview
                              .answer(label.id)
                              .then(() => setActiveReview(null));
                          }}
                        >
                          {reviewLabelName(label.id)}
                          {label.id === activeReview.suggested_label && (
                            <small>SUGERENCIA</small>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="review-timer">
                      <div className="review-timer-caption">
                        <span>Se aceptará la sugerencia automáticamente</span>
                        <strong>
                          {Math.max(
                            0,
                            Math.ceil(
                              (activeReview.expiresAt - reviewNow) / 1000,
                            ),
                          )}{" "}
                          s
                        </strong>
                      </div>
                      <div className="review-timer-track">
                        <span
                          style={{
                            width: `${Math.max(0, Math.min(100, ((activeReview.expiresAt - reviewNow) / 30_000) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  </section>
                )}
                {progress === 100 && !busy && !error && (
                  <div className="success-message">
                    <Check size={15} /> {queue.length > 1 ? "Lote procesado y descargas iniciadas." : "Archivo generado y descarga iniciada."}
                  </div>
                )}
                <button
                  className="convert-button"
                  disabled={
                    !queue.some((item) => item.status === "queued" || item.status === "error") ||
                    busy
                  }
                  onClick={startConversion}
                >
                  {busy ? (
                    "Procesando…"
                  ) : (
                    <>
                      <Sparkles size={17} />
                      {queue.filter((item) => item.status === "queued" || item.status === "error").length > 1
                        ? `Procesar ${queue.filter((item) => item.status === "queued" || item.status === "error").length} PDFs en orden`
                        : "Convertir en este dispositivo"}{" "}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>

              <aside className="side-notes">
                <div className="note-heading">
                  <span className="note-icon">
                    <ScanText size={16} />
                  </span>
                  <span>Una lectura más clara</span>
                </div>
                <p>
                  {useWasmClassifier
                      ? "Laya multilingüe se ejecuta con WebAssembly en tu dispositivo, aplica reglas estructurales de BookCLI y solicita revisión cuando duda."
                      : "En local, el texto se extrae y organiza con reglas rápidas sin descargar el modelo."}
                </p>
                <div className="structure-sample">
                  <div className="sample-line sample-title">
                    <span /> Capítulo primero
                  </div>
                  <div className="sample-line">
                    <span /> Las palabras recuperan su lugar
                  </div>
                  <div className="sample-line sample-short">
                    <span />
                  </div>
                  <div className="sample-line sample-short">
                    <span />
                  </div>
                </div>
                <div className="note-footer">
                  <span>OCR</span>
                  <span>ESTRUCTURA</span>
                  <span>PRIVADO</span>
                </div>
              </aside>
            </div>
            <div className="bottom-strip">
              <span>HECHO PARA TUS LIBROS</span>
              <span className="strip-detail">
                Local por defecto <i /> Sin cuenta <i /> Código abierto
              </span>
              <button onClick={() => navigate("documentacion")}>
                Cómo funciona <ArrowRight size={14} />
              </button>
            </div>
          </section>
        )}

        {section === "biblioteca" && (
          <section className="page-content inner-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span className="eyebrow-line" /> TU COLECCIÓN
                </div>
                <h1>Mi biblioteca</h1>
                <p className="intro-copy">
                  Tus conversiones recientes, organizadas en un solo lugar.
                </p>
              </div>
              <button
                className="small-primary"
                onClick={() => navigate("convertir")}
              >
                <Upload size={15} /> Añadir PDF
              </button>
            </div>
            <div className="library-table">
              {libraryError && <div className="error-message" role="alert">{libraryError}</div>}
              <div className="table-head">
                <span>ARCHIVO</span>
                <span>FORMATO</span>
                <span>FECHA</span>
                <span>ESTADO</span>
                <span>ARCHIVOS</span>
              </div>
              {jobs.length === 0 ? (
                <div className="library-empty">
                  <span className="benefit-icon"><Files size={19} /></span>
                  <strong>Aún no hay conversiones</strong>
                  <p>Los archivos que conviertas durante esta sesión aparecerán aquí.</p>
                </div>
              ) : jobs.map((job, index) => (
                <div className="table-row" key={`${job.name}-${index}`}>
                  <span className="table-file">
                    <span className="table-file-icon">
                      <FileText size={17} />
                    </span>
                    <span>
                      <strong>{job.name}</strong>
                      <small>{job.size}</small>
                    </span>
                  </span>
                  <span className="table-format">{job.format}</span>
                  <span className="table-date">{job.date}</span>
                  <span className="ready-status">
                    <i /> {job.status}
                  </span>
                  <div className="history-actions">
                    {(["pdf", "epub", "markdown"] as const).map((kind) => (
                      <span className="history-file-actions" key={kind}>
                        <button title={`Leer ${kind.toUpperCase()}`} onClick={() => void openHistoryFile(job, kind)}>
                          {kind === "pdf" ? "PDF" : kind === "epub" ? "EPUB" : "MD"}
                        </button>
                        <button title={`Descargar ${kind.toUpperCase()}`} onClick={() => void downloadHistoryFile(job, kind)}>
                          <Download size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="library-footnote">
              <LockKeyhole size={14} /> Esta lista se guarda solo durante la sesión actual de este navegador.
            </div>
          </section>
        )}

        {section === "documentacion" && (
          <section className="page-content inner-page docs-page">
            <div className="eyebrow">
              <span className="eyebrow-line" /> DOCUMENTACIÓN
            </div>
            <h1>Cómo funciona Semantica.</h1>
            <p className="intro-copy docs-intro">
              Del PDF original a un EPUB o Markdown legible: conoce las etapas
              que sigue Semantica y qué sucede con tus archivos.
            </p>
            <div className="docs-layout">
              <nav className="docs-nav">
                <a href="#flujo">Flujo de conversión</a>
                <a href="#extraccion">Texto y OCR</a>
                <a href="#estructura">Estructura y Laya</a>
                <a href="#salida">EPUB, Markdown y portadas</a>
                <a href="#privacidad">Privacidad</a>
                <a href="#futuro">CLI y librería</a>
              </nav>
              <div className="docs-body">
                <article id="flujo">
                  <span className="doc-index">01 / FLUJO DE CONVERSIÓN</span>
                  <h2>Una lectura, varias etapas</h2>
                  <p>
                    Puedes añadir varios PDFs a la cola. Semantica los procesa
                    en orden, uno por uno: lee las páginas, recupera texto e
                    ilustraciones, decide si necesita reconocer la estructura
                    y prepara el EPUB y el Markdown para cada archivo.
                  </p>
                </article>
                <article id="extraccion">
                  <span className="doc-index">02 / RECUPERAR EL CONTENIDO</span>
                  <h2>Texto directo cuando el PDF lo permite</h2>
                  <p>
                    Primero intenta extraer la capa de texto que ya existe en el
                    PDF. Por eso, cuando el documento tiene texto seleccionable,
                    el avance indica «Extrayendo texto del PDF» y evita pasar
                    esas páginas por OCR.
                  </p>
                  <p>
                    En páginas escaneadas, con poco texto embebido o con una
                    capa que no explica el contenido visible, Tesseract reconoce
                    el texto de la imagen. La interfaz lo muestra como
                    «Reconociendo texto con OCR». El idioma y el modo de página
                    se pueden ajustar en Inferencia.
                  </p>
                </article>
                <article id="estructura">
                  <span className="doc-index">03 / RECUPERAR LA JERARQUÍA</span>
                  <h2>Conservar la estructura o reconstruirla</h2>
                  <p>
                    Si un PDF digital ya presenta una jerarquía tipográfica
                    consistente, Semantica la conserva y no necesita llamar a
                    Laya. Cuando el contenido es texto plano o viene de OCR,
                    Laya ayuda a reconocer títulos, capítulos, párrafos, listas,
                    pies de imagen e índices.
                  </p>
                  <p>
                    Laya se ejecuta localmente con WebAssembly. Empieza con
                    contexto alrededor de cada bloque y, cuando no tiene
                    suficiente confianza, pide una revisión. Las preferencias
                    de instrucciones, contexto y OCR están en la pestaña
                    Inferencia. La animación muestra el bloque analizado y la
                    decisión que se va incorporando al libro.
                  </p>
                </article>
                <article id="salida">
                  <span className="doc-index">04 / PREPARAR LOS ARCHIVOS</span>
                  <h2>Imágenes, portada y formatos</h2>
                  <p>
                    Semantica compara la capa de texto con el contenido visible
                    de las páginas para recuperar ilustraciones y páginas
                    escaneadas completas. Al generar un EPUB puedes elegir una
                    portada sugerida, conservar la primera página del PDF o
                    subir una imagen. También puedes revisar y editar título,
                    autores, editorial, año, idioma, ISBN y descripción.
                  </p>
                  <p>
                    La búsqueda de portadas consulta el título del archivo en
                    catálogos externos; el PDF no se envía. La elección se
                    confirma después de tres minutos si no la haces antes, y
                    puedes pausar el temporizador. Las portadas remotas deben
                    permitir acceso desde el navegador.
                  </p>
                </article>
                <article id="privacidad">
                  <span className="doc-index">05 / ARCHIVOS Y PRIVACIDAD</span>
                  <h2>El procesamiento ocurre en tu dispositivo</h2>
                  <p>
                    El PDF se mantiene en el navegador durante la conversión.
                    El modelo Laya se descarga desde los recursos publicados
                    por la aplicación y puede quedar en la caché del navegador
                    para próximas sesiones. El historial de conversiones se
                    conserva solo durante la sesión actual.
                  </p>
                </article>
                <article id="futuro" className="docs-future">
                  <span className="doc-index">06 / EN PREPARACIÓN</span>
                  <h2>CLI y librerías: próximamente</h2>
                  <p>
                    Estamos preparando la documentación para usar el núcleo de
                    Semantica desde código y desde la línea de comandos. Esas
                    guías aún no están disponibles; por ahora esta página
                    describe el flujo y las funciones de la aplicación web.
                  </p>
                </article>
              </div>
            </div>
          </section>
        )}
      </main>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          aria-label="Cerrar menú"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </div>
  );
}

function sectionLabel(section: Section): string {
  return {
    inicio: "Inicio",
    convertir: "Convertir",
    biblioteca: "Mi biblioteca",
    lector: "Lector",
    documentacion: "Documentación",
    configuracion: "Inferencia",
  }[section];
}

function reviewLabelName(label: string): string {
  return (
    {
      title: "Título",
      heading: "Encabezado",
      subheading: "Subencabezado",
      paragraph: "Párrafo",
      list_item: "Elemento de lista",
      caption: "Leyenda",
      noise: "Ruido OCR",
      other: "Otro",
    }[label] ?? label
  );
}

function CoverReviewPanel({
  review,
  now,
  onSelect,
  onMetadataChange,
  onCustomCover,
  onPause,
  onConfirmStarting,
  onConfirm,
}: {
  review: CoverReviewState;
  now: number;
  onSelect: (id: string) => void;
  onMetadataChange: (metadata: BookMetadata) => void;
  onCustomCover: (cover: CoverAsset, id: string) => void;
  onPause: () => void;
  onConfirmStarting: () => void;
  onConfirm: (selection: CoverSelection) => void;
}) {
  const [coverUrl, setCoverUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const original = review.request.originalCoverDataUrl;
  const remaining = review.paused
    ? review.remainingMs
    : Math.max(0, review.expiresAt - now);
  const choices = [
    ...review.request.candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.metadata.title,
      author: candidate.metadata.authors.join(", "),
      image: candidate.coverUrl,
      source: candidate.source === "openlibrary" ? "Open Library" : "Google Books",
    })),
    ...(review.cover && (review.selectedId === "upload" || review.selectedId === "custom-url") ? [{
      id: review.selectedId,
      title: review.selectedId === "upload" ? "Portada cargada" : "Portada por URL",
      author: "",
      image: review.cover.dataUrl ?? review.cover.url ?? "",
      source: "Personalizada",
    }] : []),
    ...(original ? [{ id: "original", title: "Portada original del PDF", author: "", image: original, source: "PDF original" }] : []),
  ];
  const readCover = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(jpeg|png)$/i.test(file.type)) {
      setUrlError("Elige una imagen PNG o JPEG.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setUrlError("");
        onCustomCover({ dataUrl: reader.result, mimeType: file.type }, "upload");
      }
    };
    reader.onerror = () => setUrlError("No se pudo leer la imagen seleccionada.");
    reader.readAsDataURL(file);
  };
  const useUrl = () => {
    try {
      const url = new URL(coverUrl);
      if (!/^https?:$/.test(url.protocol)) throw new Error("URL no válida");
      setUrlError("");
      onCustomCover({ url: url.toString() }, "custom-url");
    } catch {
      setUrlError("Escribe una URL completa que comience con https:// o http://.");
    }
  };
  const confirmSelection = async () => {
    setUrlError("");
    setCoverLoading(true);
    onConfirmStarting();
    try {
      let cover = review.cover;
      if (cover?.url && !cover.dataUrl) {
        const response = await fetch(cover.url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`El servidor de la portada respondió ${response.status}.`);
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("No se pudo preparar la portada."));
          reader.onerror = () => reject(new Error("No se pudo leer la portada descargada."));
          reader.readAsDataURL(blob);
        });
        cover = { dataUrl, mimeType: blob.type || "image/jpeg" };
      }
      onConfirm({ metadata: review.metadata, cover });
    } catch (cause) {
      setUrlError(`${cause instanceof Error ? cause.message : "No se pudo descargar la portada."} Prueba otra opción o sube la imagen desde tu dispositivo.`);
    } finally {
      setCoverLoading(false);
    }
  };
  return (
    <section className="cover-review-panel" aria-live="polite">
      <div className="cover-review-heading">
        <div><span className="cover-review-kicker">PORTADA Y METADATOS</span><h3>Elige cómo aparecerá tu libro</h3><p>Busca por el título del archivo. El PDF permanece en tu dispositivo; solo se consulta el título.</p></div>
        <div className="cover-review-timer">
          <span>{review.paused ? "Selección automática pausada" : "Selección automática en"}</span>
          <strong>{String(Math.floor(Math.ceil(remaining / 1000) / 60)).padStart(2, "0")}:{String(Math.ceil(remaining / 1000) % 60).padStart(2, "0")}</strong>
          <button type="button" onClick={onPause}>{review.paused ? "Reanudar" : "Pausar"}</button>
        </div>
      </div>
      <div className="cover-choice-grid">
        {choices.map((choice) => (
          <button type="button" key={choice.id} className={`cover-choice ${review.selectedId === choice.id ? "selected" : ""}`} onClick={() => onSelect(choice.id)}>
            <span className="cover-choice-image"><img src={choice.image} alt={`Portada de ${choice.title}`} /></span>
            <strong>{choice.title}</strong>
            {choice.author && <small>{choice.author}</small>}
            <small className="cover-choice-source">{choice.source}{review.selectedId === choice.id ? " · SELECCIÓN ACTUAL" : ""}</small>
          </button>
        ))}
        {!choices.length && <p className="cover-search-empty">No encontramos portadas con este título. Puedes cargar una imagen o pegar su URL.</p>}
      </div>
      <div className="cover-metadata-fields selected">
        <label>Título<input value={review.metadata.title} onChange={(event) => onMetadataChange({ ...review.metadata, title: event.target.value })} /></label>
        <label>Autor(es)<input value={review.metadata.authors.join(", ")} onChange={(event) => onMetadataChange({ ...review.metadata, authors: event.target.value.split(",").map((author) => author.trim()).filter(Boolean) })} placeholder="Separados por comas" /></label>
        <label>Editorial<input value={review.metadata.publisher ?? ""} onChange={(event) => onMetadataChange({ ...review.metadata, publisher: event.target.value })} /></label>
        <label>Año<input value={review.metadata.publishedDate ?? ""} onChange={(event) => onMetadataChange({ ...review.metadata, publishedDate: event.target.value })} /></label>
        <label>Idioma<input value={review.metadata.language ?? ""} onChange={(event) => onMetadataChange({ ...review.metadata, language: event.target.value })} placeholder="es" /></label>
        <label>ISBN<input value={review.metadata.isbn ?? ""} onChange={(event) => onMetadataChange({ ...review.metadata, isbn: event.target.value })} /></label>
        <label className="cover-description-field">Descripción<input value={review.metadata.description ?? ""} onChange={(event) => onMetadataChange({ ...review.metadata, description: event.target.value })} /></label>
      </div>
      <div className="cover-custom-actions">
        <label className="cover-upload-button">Subir portada<input type="file" accept="image/png,image/jpeg" onChange={(event) => readCover(event.currentTarget.files?.[0])} /></label>
        <div className="cover-url-input"><input type="url" value={coverUrl} onChange={(event) => setCoverUrl(event.target.value)} placeholder="https://…/portada.jpg" aria-label="URL de la portada" /><button type="button" onClick={useUrl}>Usar URL</button></div>
        <button type="button" className="cover-confirm-button" disabled={coverLoading} onClick={() => void confirmSelection()}>{coverLoading ? "Descargando portada…" : "Usar esta selección"}</button>
      </div>
      {urlError && <p className="cover-url-error" role="alert">{urlError}</p>}
    </section>
  );
}

function ProcessingAnimation({
  text,
  extractionMode,
  recoveredImages,
  event,
  decisions,
  progressText,
  reviewing,
  scrollRef,
  blockRef,
}: {
  text: string;
  extractionMode: "text" | "ocr";
  recoveredImages: RecoveredImage[];
  event: ClassificationEvent | null;
  decisions: Record<number, BookcliLabel>;
  progressText: string;
  reviewing: boolean;
  scrollRef: RefObject<HTMLDivElement>;
  blockRef: RefObject<HTMLDivElement>;
}) {
  const paragraphs = text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  // Classification events share the same split sequence as the OCR text.
  // Resolve by index so repeated paragraphs can never point the highlight backward.
  const selectedIndex = event && event.index < paragraphs.length ? event.index : -1;
  const visibleStart = selectedIndex < 0 ? Math.max(0, paragraphs.length - 18) : Math.max(0, selectedIndex - 5);
  const visibleParagraphs = paragraphs.slice(visibleStart, Math.min(paragraphs.length, visibleStart + 30));
  const stage = event?.phase === "thinking"
    ? "Laya está encontrando el lugar de este bloque"
    : event?.phase === "review"
      ? "Laya necesita tu criterio para este bloque"
      : event?.phase === "decided"
        ? `Estructura encontrada · ${reviewLabelName(event.label ?? "other")}`
        : progressText || "Recuperando el texto del PDF";
  return (
    <section className="processing-animation" aria-live="polite">
      <div className="processing-animation-heading">
        <span className="processing-pulse"><Sparkles size={15} /></span>
        <span><strong>Semantica está leyendo tu libro</strong><small>{stage}</small></span>
        {event && <small className="processing-counter">Bloque {event.index + 1} / {event.total}</small>}
      </div>
      <div className="processing-paper-scroll" ref={scrollRef}>
        <article className="processing-paper">
          <div className="processing-paper-label">{extractionMode === "ocr" ? "TEXTO RECONOCIDO POR OCR" : "TEXTO EXTRAÍDO DEL PDF"}</div>
          {recoveredImages
            .filter((image) => image.anchorAfterBlock < 0)
            .map((image) => <RecoveredImagePreview key={image.id} image={image} />)}
          {visibleParagraphs.length ? visibleParagraphs.map((paragraph, index) => {
            const actualIndex = visibleStart + index;
            const current = actualIndex === selectedIndex;
            const decision = decisions[actualIndex];
            return <div
              key={`${actualIndex}-${paragraph.slice(0, 24)}`}
              ref={current && !reviewing ? blockRef : undefined}
              className={`processing-text-block ${decision ? `classified-${decision}` : ""} ${current ? "processing-current" : ""} ${current && event?.phase === "decided" ? "processing-decided" : ""}`}
              style={{ viewTransitionName: current && event?.phase === "review" && !reviewing ? "laya-question" : "none" }}
            >
              {paragraph}
              {decision && <span className="classification-badge">{reviewLabelName(decision)}</span>}
              {recoveredImages
                .filter((image) => image.anchorAfterBlock === actualIndex)
                .map((image) => <RecoveredImagePreview key={image.id} image={image} />)}
              {current && event?.phase === "thinking" && <span className="thinking-indicator"><i /><i /><i /> Laya está pensando</span>}
              {current && event?.phase === "decided" && <span className="decision-particles" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>}
            </div>;
          }) : <div className="processing-placeholder"><span /><span /><span /><span /><span /></div>}
          {recoveredImages.length > 0 && (
            <div className="image-recovery-count"><Check size={12} /> {recoveredImages.length} {recoveredImages.length === 1 ? "imagen recuperada" : "imágenes recuperadas"}</div>
          )}
          {paragraphs.length > visibleParagraphs.length && <div className="processing-more">· · ·</div>}
        </article>
      </div>
    </section>
  );
}

function RecoveredImagePreview({ image }: { image: RecoveredImage }) {
  return (
    <figure className="recovered-image-preview">
      <img src={image.dataUrl} alt={`Ilustración recuperada de la página ${image.page}`} />
      <figcaption><Check size={11} /> Imagen · página {image.page}</figcaption>
    </figure>
  );
}

export default App;
