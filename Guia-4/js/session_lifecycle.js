(function initializeSessionLifecycle(globalScope) {
  class SessionTransitionError extends Error {
    constructor() {
      super("");
      this.name = "SessionTransitionError";
      this.silent = true;
    }
  }

  function createSessionLifecycle({
    reset,
    showLoading,
    showAccess,
    showApplication,
    scheduleAccess = (callback) => callback(),
    AbortControllerClass = globalScope.AbortController,
  }) {
    if (typeof AbortControllerClass !== "function") {
      throw new Error("AbortController no esta disponible");
    }

    let generation = 0;
    let controller = null;

    function begin() {
      controller?.abort();
      generation += 1;
      controller = new AbortControllerClass();
      const context = Object.freeze({
        generation,
        signal: controller.signal,
      });
      reset();
      showLoading();
      return context;
    }

    function isCurrent(context) {
      return Boolean(
        context &&
          context.generation === generation &&
          !context.signal.aborted,
      );
    }

    function assertCurrent(context) {
      if (!isCurrent(context)) throw new SessionTransitionError();
    }

    function ready(context) {
      assertCurrent(context);
      showApplication();
    }

    function fail(context) {
      if (!isCurrent(context)) return false;
      controller.abort();
      generation += 1;
      controller = null;
      reset();
      showAccess();
      return true;
    }

    function resetToAccess() {
      controller?.abort();
      generation += 1;
      controller = null;
      reset();
      showAccess();
    }

    function logout() {
      const context = begin();
      scheduleAccess(() => {
        if (isCurrent(context)) showAccess();
      });
      return context;
    }

    return Object.freeze({
      begin,
      isCurrent,
      assertCurrent,
      ready,
      fail,
      resetToAccess,
      logout,
    });
  }

  const api = Object.freeze({
    SessionTransitionError,
    createSessionLifecycle,
  });

  globalScope.SIGDOCS_SESSION_LIFECYCLE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
