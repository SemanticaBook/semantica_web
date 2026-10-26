export type SavedConversionFiles = {
  id: string;
  pdf: Blob;
  epub: Blob;
  markdown: Blob;
};

const DATABASE = "semantica-session-files";
const STORE = "conversions";
const volatile = new Map<string, SavedConversionFiles>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveConversionFiles(files: SavedConversionFiles) {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(files);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch {
    // Keep the files available in this page session when IndexedDB is blocked.
    volatile.set(files.id, files);
  }
}

export async function getConversionFile(
  id: string,
  format: "pdf" | "epub" | "markdown",
): Promise<Blob> {
  const inMemory = volatile.get(id);
  if (inMemory) return inMemory[format];
  const db = await openDatabase();
  const files = await new Promise<SavedConversionFiles>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () =>
      request.result ? resolve(request.result as SavedConversionFiles) : reject(new Error("El archivo de esta sesión ya no está disponible."));
    request.onerror = () => reject(request.error);
  });
  db.close();
  return files[format];
}
