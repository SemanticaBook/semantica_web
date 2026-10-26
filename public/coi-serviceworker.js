/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, MIT License.
 * Enables COOP/COEP on static hosts such as GitHub Pages so browsers can use
 * SharedArrayBuffer and ONNX Runtime WebAssembly threads.
 */
let coepCredentialless = false;

if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("message", (event) => {
    if (event.data?.type === "deregister") {
      self.registration.unregister().then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (event.data?.type === "coepCredentialless") {
      coepCredentialless = Boolean(event.data.value);
    }
  });
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
    const intercepted = coepCredentialless && request.mode === "no-cors"
      ? new Request(request, { credentials: "omit" })
      : request;
    event.respondWith(fetch(intercepted).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      if (!coepCredentialless) headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }));
  });
} else {
  (() => {
    const reloaded = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const degrading = reloaded === "coepdegrade";
    const config = {
      shouldRegister: () => !reloaded,
      shouldDeregister: () => false,
      coepCredentialless: () => true,
      coepDegrade: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };
    const serviceWorker = navigator.serviceWorker;
    const controller = serviceWorker?.controller;
    if (controller && !window.crossOriginIsolated) {
      window.sessionStorage.setItem("coiCoepHasFailed", "true");
    }
    const previousFailure = window.sessionStorage.getItem("coiCoepHasFailed");
    if (controller) {
      const retryWithoutCredentialless = config.coepDegrade() && !(degrading || window.crossOriginIsolated);
      controller.postMessage({
        type: "coepCredentialless",
        value: retryWithoutCredentialless || (previousFailure && config.coepDegrade())
          ? false
          : config.coepCredentialless(),
      });
      if (retryWithoutCredentialless) {
        window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
        config.doReload("coepdegrade");
      }
      if (config.shouldDeregister()) controller.postMessage({ type: "deregister" });
    }
    if (window.crossOriginIsolated !== false || !config.shouldRegister() || !window.isSecureContext || !serviceWorker) return;
    serviceWorker.register(document.currentScript.src).then((registration) => {
      registration.addEventListener("updatefound", () => {
        window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
        config.doReload();
      });
      if (registration.active && !serviceWorker.controller) {
        window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
        config.doReload();
      }
    }).catch((error) => {
      if (!config.quiet) console.error("COOP/COEP service worker failed to register:", error);
    });
  })();
}

// MIT License: https://github.com/gzuidhof/coi-serviceworker
