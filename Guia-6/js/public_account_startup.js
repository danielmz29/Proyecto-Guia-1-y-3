(function attachPublicAccountStartup(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SIGDOCS_PUBLIC_ACCOUNT_STARTUP = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function hasPendingPasswordReset({ resetToken, passwordResetEnabled }) {
    return Boolean(resetToken && passwordResetEnabled);
  }

  function resolveAccessView(requestedView, resetState) {
    return hasPendingPasswordReset(resetState) ? "reset" : requestedView;
  }

  async function coordinateStartup({
    hasResetToken,
    configPromise,
    isResetReady,
    showLoading,
    showAccess,
    startSessionBootstrap,
  }) {
    if (!hasResetToken) {
      Promise.resolve(configPromise).catch(() => {});
      startSessionBootstrap();
      return "session";
    }

    showLoading();
    await configPromise;

    if (isResetReady()) {
      showAccess();
      return "reset";
    }

    startSessionBootstrap();
    return "session";
  }

  return {
    coordinateStartup,
    hasPendingPasswordReset,
    resolveAccessView,
  };
});
