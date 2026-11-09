(function initializeAuthClient(globalScope) {
  const AUTH_MODES = new Set(["bearer", "cookie"]);
  const MUTABLE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const TOKEN_STORAGE_KEY = "sigdocs_token";

  class AuthenticationStateError extends Error {
    constructor(message = "No existe una sesion autenticada") {
      super(message);
      this.name = "AuthenticationStateError";
      this.silent = true;
    }
  }

  function createAuthClient({
    mode = "bearer",
    localStorage = globalScope.localStorage,
    sessionStorage = globalScope.sessionStorage,
  } = {}) {
    const normalizedMode = String(mode).trim().toLowerCase();
    if (!AUTH_MODES.has(normalizedMode)) {
      throw new Error("Modo de autenticacion no valido");
    }

    let bearerToken = null;
    let csrfToken = null;
    let authenticationConfirmed = false;

    if (normalizedMode === "bearer") {
      bearerToken = readStorage(localStorage, TOKEN_STORAGE_KEY);
      authenticationConfirmed = Boolean(bearerToken);
    } else {
      removeStorage(localStorage, TOKEN_STORAGE_KEY);
      removeStorage(sessionStorage, TOKEN_STORAGE_KEY);
    }

    function clear() {
      bearerToken = null;
      csrfToken = null;
      authenticationConfirmed = false;
      removeStorage(localStorage, TOKEN_STORAGE_KEY);
      removeStorage(sessionStorage, TOKEN_STORAGE_KEY);
    }

    function captureLogin(payload) {
      if (normalizedMode === "cookie") {
        const nextCsrfToken = String(payload?.csrf_token || "").trim();
        if (!nextCsrfToken) {
          throw new AuthenticationStateError(
            "El servidor no entrego la proteccion de sesion esperada",
          );
        }
        csrfToken = nextCsrfToken;
        bearerToken = null;
        authenticationConfirmed = true;
        removeStorage(localStorage, TOKEN_STORAGE_KEY);
        removeStorage(sessionStorage, TOKEN_STORAGE_KEY);
        return;
      }

      const nextBearerToken = String(payload?.access_token || "").trim();
      if (!nextBearerToken) {
        throw new AuthenticationStateError("El servidor no entrego un token valido");
      }
      bearerToken = nextBearerToken;
      authenticationConfirmed = true;
      writeStorage(localStorage, TOKEN_STORAGE_KEY, bearerToken);
    }

    function confirmAuthentication() {
      authenticationConfirmed = true;
    }

    function captureCsrf(payload) {
      if (normalizedMode !== "cookie") return;
      const nextCsrfToken = String(payload?.csrf_token || "").trim();
      if (!nextCsrfToken) {
        throw new AuthenticationStateError(
          "No fue posible renovar la proteccion de la sesion",
        );
      }
      csrfToken = nextCsrfToken;
    }

    function prepareRequest({ method = "GET", skipAuth = false } = {}) {
      const normalizedMethod = String(method || "GET").toUpperCase();
      const headers = {};

      if (normalizedMode === "cookie") {
        if (!skipAuth && MUTABLE_METHODS.has(normalizedMethod)) {
          if (!csrfToken) throw new AuthenticationStateError();
          headers["X-CSRF-Token"] = csrfToken;
        }
        return { headers, credentials: "include" };
      }

      if (!skipAuth) {
        if (!bearerToken) throw new AuthenticationStateError();
        headers.Authorization = `Bearer ${bearerToken}`;
      }
      return { headers };
    }

    return Object.freeze({
      mode: normalizedMode,
      loginPath:
        normalizedMode === "cookie" ? "/auth/session/login" : "/auth/login",
      contextPath:
        normalizedMode === "cookie" ? "/auth/session" : "/auth/me",
      isCookie: normalizedMode === "cookie",
      canBootstrap: () => normalizedMode === "cookie" || Boolean(bearerToken),
      hasCsrf: () => Boolean(csrfToken),
      hasConfirmedAuthentication: () => authenticationConfirmed,
      getBearerToken: () => bearerToken,
      clear,
      captureLogin,
      captureCsrf,
      confirmAuthentication,
      prepareRequest,
    });
  }

  function isCsrfRejection(status, detail) {
    return Number(status) === 403 && /csrf/i.test(String(detail || ""));
  }

  function readStorage(storage, key) {
    try {
      return storage?.getItem(key) || null;
    } catch (_) {
      return null;
    }
  }

  function writeStorage(storage, key, value) {
    try {
      storage?.setItem(key, value);
    } catch (_) {
      throw new AuthenticationStateError(
        "No fue posible guardar la sesion en este navegador",
      );
    }
  }

  function removeStorage(storage, key) {
    try {
      storage?.removeItem(key);
    } catch (_) {
      // El modo cookie sigue siendo seguro aunque el storage este bloqueado.
    }
  }

  const api = Object.freeze({
    AuthenticationStateError,
    createAuthClient,
    isCsrfRejection,
  });
  globalScope.SIGDOCS_AUTH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
