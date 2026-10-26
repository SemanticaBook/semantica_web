import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ImagePlus,
  Pencil,
  Save,
  X,
} from "lucide-react";

export type ReaderFormat = "pdf" | "epub" | "markdown";
export type ReaderDocument = { name: string; format: ReaderFormat; blob: Blob };

type EpubItem = { id: string; href: string; mediaType: string };
type AddedImage = { name: string; blob: Blob; mediaType: string };

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function markdownToHtml(markdown: string) {
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  return body.split(/\n\s*\n/).map((part) => {
    const safe = escapeHtml(part.trim());
    const withImages = safe.replace(
      /!\[([^\]]*)\]\((data:image\/(?:png|jpeg|gif|webp);base64,[^)]+)\)/gi,
      '<img alt="$1" src="$2" />',
    );
    const anchoredHeading = /^<a id="([a-z0-9-]+)"><\/a>\s*\n(#{1,6})\s+(.+)$/i.exec(part.trim());
    const heading = anchoredHeading ?? /^(#{1,6})\s+(.+)$/.exec(part.trim());
    if (heading) {
      const id = anchoredHeading ? anchoredHeading[1] : undefined;
      const marks = anchoredHeading ? anchoredHeading[2] : heading[1];
      const content = anchoredHeading ? anchoredHeading[3] : heading[2];
      const level = marks.length;
      return `<h${level}${id ? ` id="${id}"` : ""}>${escapeHtml(content)}</h${level}>`;
    }
    if (/^\s*[-*+]\s+/m.test(part)) {
      const items = part.split("\n").map((line) => line.replace(/^\s*[-*+]\s+/, ""));
      return `<ul>${items.map((item) => {
        const linked = /^\[([^\]]+)\]\(#([a-z0-9-]+)\)$/i.exec(item);
        return `<li>${linked ? `<a href="#${linked[2]}">${escapeHtml(linked[1])}</a>` : escapeHtml(item)}</li>`;
      }).join("")}</ul>`;
    }
    return `<p>${withImages.replace(/\n/g, "<br />")}</p>`;
  }).join("\n");
}

function readerShell(body: string, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{max-width:680px;margin:0 auto;padding:54px 38px 80px;color:#34464a;background:#fffefa;font:18px/1.85 Georgia,serif}
    h1,h2,h3,h4{color:#395952;font-weight:500;line-height:1.2}h1{font-size:2.1em}h2{font-size:1.65em}p{margin:0 0 1.25em}img{display:block;max-width:100%;height:auto;margin:1.6em auto}blockquote{margin:1.5em 0;padding-left:1em;border-left:2px solid #9dbbb2;color:#657875}li{margin:.4em 0}
    @media(max-width:520px){body{padding:34px 22px;font-size:16px}}
  </style></head><body>${body}</body></html>`;
}

function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function relativePath(fromFile: string, toFile: string) {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/");
}

function appendToEpubBody(source: string, html: string) {
  if (/<\/body\s*>/i.test(source)) return source.replace(/<\/body\s*>/i, `${html}</body>`);
  if (/<\/html\s*>/i.test(source)) return source.replace(/<\/html\s*>/i, `${html}</html>`);
  return `${source}${html}`;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function Reader({
  file,
  onClose,
}: {
  file: ReaderDocument;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [epubHtml, setEpubHtml] = useState("");
  const [epubZip, setEpubZip] = useState<JSZip | null>(null);
  const [opfPath, setOpfPath] = useState("");
  const [chapterPaths, setChapterPaths] = useState<string[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [addedImages, setAddedImages] = useState<AddedImage[]>([]);
  const [pdfDocument, setPdfDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [htmlPreview, setHtmlPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const canEdit = file.format !== "pdf";
  const currentChapter = chapterPaths[chapterIndex] ?? "";

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    setBusy(true);
    setError("");
    setEditing(false);
    setSaved(false);
    setPdfPage(1);
    setPdfDocument(null);
    setEpubZip(null);
    setEpubHtml("");
    setChapterPaths([]);
    setAddedImages([]);
    void (async () => {
      try {
        if (file.format === "pdf") {
          task = pdfjs.getDocument({ data: await file.blob.arrayBuffer() });
          const doc = await task.promise;
          if (cancelled) return;
          setPdfDocument(doc);
          setPdfPages(doc.numPages);
        } else if (file.format === "markdown") {
          setMarkdown(await file.blob.text());
        } else {
          const zip = await JSZip.loadAsync(file.blob);
          const container = await zip.file("META-INF/container.xml")?.async("string");
          if (!container) throw new Error("El EPUB no contiene META-INF/container.xml.");
          const containerXml = new DOMParser().parseFromString(container, "application/xml");
          const rootfile = containerXml.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
          if (!rootfile) throw new Error("No se encontró el paquete OPF del EPUB.");
          const opf = await zip.file(rootfile)?.async("string");
          if (!opf) throw new Error("No se pudo leer el paquete OPF del EPUB.");
          const opfXml = new DOMParser().parseFromString(opf, "application/xml");
          const items = Array.from(opfXml.getElementsByTagName("item")).map((item) => ({
            id: item.getAttribute("id") ?? "",
            href: item.getAttribute("href") ?? "",
            mediaType: item.getAttribute("media-type") ?? "",
          }));
          const manifest = new Map(items.map((item) => [item.id, item]));
          const paths = Array.from(opfXml.getElementsByTagName("itemref"))
            .map((item) => manifest.get(item.getAttribute("idref") ?? ""))
            .filter((item): item is EpubItem => Boolean(item?.href && (item.mediaType === "application/xhtml+xml" || item.mediaType === "application/x-dtbook+xml")))
            .map((item) => normalizePath(`${rootfile.split("/").slice(0, -1).join("/")}/${decodeURIComponent(item.href)}`));
          if (!paths.length) throw new Error("El EPUB no contiene capítulos legibles.");
          if (cancelled) return;
          setEpubZip(zip);
          setOpfPath(rootfile);
          setChapterPaths(paths);
          setChapterIndex(0);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudo abrir el archivo.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [file]);

  useEffect(() => {
    if (file.format !== "epub" || !epubZip || !currentChapter) return;
    let cancelled = false;
    void epubZip.file(currentChapter)?.async("string").then((source) => {
      if (!cancelled && source) setEpubHtml(source);
    });
    return () => { cancelled = true; };
  }, [file.format, epubZip, currentChapter]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return;
    let cancelled = false;
    void pdfDocument.getPage(pdfPage).then(async (page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: context, viewport }).promise;
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "No se pudo renderizar la página."));
    return () => { cancelled = true; };
  }, [pdfDocument, pdfPage]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let html = "";
        let title = file.name;
        if (file.format === "markdown") html = markdownToHtml(markdown);
        if (file.format === "epub" && epubZip && currentChapter && epubHtml) {
          const parsed = new DOMParser().parseFromString(epubHtml, "application/xhtml+xml");
          parsed.querySelectorAll("script,iframe,object,embed,form,link,style").forEach((node) => node.remove());
          for (const node of Array.from(parsed.querySelectorAll("*"))) {
            for (const attribute of Array.from(node.attributes)) {
              if (/^on/i.test(attribute.name) || attribute.name === "style") node.removeAttribute(attribute.name);
            }
          }
          for (const image of Array.from(parsed.querySelectorAll("img"))) {
            const sourcePath = image.getAttribute("src") ?? "";
            if (sourcePath.startsWith("data:image/")) continue;
            if (sourcePath.startsWith("semantica-image:")) {
              const name = decodeURIComponent(sourcePath.slice("semantica-image:".length));
              const added = addedImages.find((entry) => entry.name === name);
              if (added) image.setAttribute("src", await blobToDataUrl(added.blob));
            } else {
              const imagePath = normalizePath(`${currentChapter.split("/").slice(0, -1).join("/")}/${sourcePath}`);
              const imageBlob = await epubZip.file(imagePath)?.async("blob");
              if (imageBlob) image.setAttribute("src", await blobToDataUrl(imageBlob));
              else image.remove();
            }
          }
          const bodyElement =
            parsed.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "body")[0] ??
            parsed.getElementsByTagName("body")[0];
          html = bodyElement?.innerHTML ?? "";
          title = parsed.getElementsByTagName("title")[0]?.textContent ?? title;
        }
        if (!cancelled) setHtmlPreview(readerShell(html, title));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudo mostrar la vista de lectura.");
      }
    })();
    return () => { cancelled = true; };
  }, [file, markdown, epubZip, epubHtml, currentChapter, addedImages]);

  const fileTitle = useMemo(() => file.name.replace(/\.(pdf|epub|md|markdown)$/i, ""), [file.name]);

  async function selectImage(image?: File) {
    if (!image) return;
    if (!image.type.startsWith("image/")) {
      setError("Elige un archivo de imagen.");
      return;
    }
    setError("");
    const name = `${crypto.randomUUID()}-${image.name.replace(/[^\w.-]+/g, "_")}`;
    if (file.format === "markdown") {
      const dataUrl = await blobToDataUrl(image);
      setMarkdown((current) => `${current}\n\n![${image.name}](${dataUrl})`);
    } else {
      const opfDirectory = opfPath.split("/").slice(0, -1).join("/");
      const path = normalizePath(`${opfDirectory}/images/${name}`);
      setAddedImages((current) => [...current, { name, blob: image, mediaType: image.type }]);
      setEpubHtml((current) => appendToEpubBody(current, `\n<img src="semantica-image:${encodeURIComponent(name)}" alt="${escapeHtml(image.name)}" />`));
      setEpubZip((current) => {
        const next = current ?? new JSZip();
        next.file(path, image);
        return next;
      });
    }
    setSaved(false);
  }

  async function downloadEdited() {
    try {
      let blob: Blob;
      let suffix: string;
      if (file.format === "markdown") {
        blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
        suffix = ".md";
      } else if (epubZip) {
        let savedHtml = epubHtml;
        for (const image of addedImages) {
          const opfDirectory = opfPath.split("/").slice(0, -1).join("/");
          const path = normalizePath(`${opfDirectory}/images/${image.name}`);
          const relative = relativePath(currentChapter, path);
          savedHtml = savedHtml.replaceAll(`semantica-image:${encodeURIComponent(image.name)}`, relative);
          const mediaItem = `<item id="semantica-${image.name.replace(/[^\w-]/g, "-")}" href="images/${encodeURIComponent(image.name)}" media-type="${escapeHtml(image.mediaType)}"/>`;
          const opfFile = epubZip.file(opfPath);
          const opfText = opfFile ? await opfFile.async("string") : "";
          if (opfText && !opfText.includes(`semantica-${image.name}`)) {
            epubZip.file(opfPath, opfText.replace("</manifest>", `${mediaItem}</manifest>`));
          }
        }
        if (currentChapter) epubZip.file(currentChapter, savedHtml);
        blob = await epubZip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
        suffix = ".epub";
      } else return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileTitle}-editado${suffix}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar el archivo editado.");
    }
  }

  function changeEpubHtml(value: string) {
    setEpubHtml(value);
    if (epubZip && currentChapter) epubZip.file(currentChapter, value);
    setSaved(false);
  }

  return (
    <section className="reader-page">
      <header className="reader-toolbar">
        <button className="reader-back" onClick={onClose}><ArrowLeft size={16} /> Volver a Semantica</button>
        <div className="reader-file-title"><BookOpen size={16} /><span>{file.name}</span><small>{file.format.toUpperCase()}</small></div>
        <div className="reader-actions">
          {canEdit && <button className={editing ? "reader-tool active" : "reader-tool"} onClick={() => setEditing((value) => !value)}><Pencil size={15} /> {editing ? "Vista previa" : "Edición"}</button>}
          {canEdit && editing && <button className="reader-tool" onClick={() => imageInputRef.current?.click()}><ImagePlus size={15} /> Agregar imagen</button>}
          {canEdit && editing && <button className="reader-save" onClick={() => void downloadEdited()}><Save size={15} /> Descargar cambios</button>}
          <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => { void selectImage(event.target.files?.[0]); event.target.value = ""; }} />
          <button className="reader-close" aria-label="Cerrar lector" onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      {error && <div className="reader-error" role="alert">{error}</div>}
      {saved && <div className="reader-saved">Cambios descargados correctamente.</div>}
      {busy ? <div className="reader-loading">Preparando tu lectura…</div> : (
        <div className={`reader-content ${file.format === "pdf" ? "pdf-reader-content" : ""}`}>
          {file.format === "pdf" ? <>
            <div className="pdf-reader-page"><canvas ref={canvasRef} /></div>
            <div className="reader-pagination"><button disabled={pdfPage <= 1} onClick={() => setPdfPage((page) => Math.max(1, page - 1))}><ArrowLeft size={15} /> Anterior</button><span>Página {pdfPage} de {pdfPages}</span><button disabled={pdfPage >= pdfPages} onClick={() => setPdfPage((page) => Math.min(pdfPages, page + 1))}>Siguiente <ArrowRight size={15} /></button></div>
          </> : <>
            {file.format === "epub" && chapterPaths.length > 1 && <div className="reader-pagination"><button disabled={chapterIndex === 0} onClick={() => setChapterIndex((value) => Math.max(0, value - 1))}><ArrowLeft size={15} /> Capítulo anterior</button><span>{chapterIndex + 1} de {chapterPaths.length}</span><button disabled={chapterIndex + 1 >= chapterPaths.length} onClick={() => setChapterIndex((value) => Math.min(chapterPaths.length - 1, value + 1))}>Siguiente capítulo <ArrowRight size={15} /></button></div>}
            {editing ? <textarea className="reader-editor" aria-label={`Editar ${file.format}`} value={file.format === "markdown" ? markdown : epubHtml} onChange={(event) => file.format === "markdown" ? (setMarkdown(event.target.value), setSaved(false)) : changeEpubHtml(event.target.value)} spellCheck={false} /> : <iframe className="reader-frame" title={`Lector de ${file.name}`} sandbox="" srcDoc={htmlPreview} />}
          </>}
        </div>
      )}
    </section>
  );
}

export default Reader;
