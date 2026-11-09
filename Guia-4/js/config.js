(function initializeRuntimeConfig(globalScope) {
  const PRODUCTION_API_URL = "https://sigdocs-lab-api.onrender.com";
  const STAGING_API_URL = "https://sigdocs-lab-api-staging.onrender.com";

  function isPrivateLanHostname(hostname) {
    const parts = hostname.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return false;
    }

    return (
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }

  function isNetlifyDeployPreview(hostname) {
    return /^deploy-preview-\d+--sigdocs-lab\.netlify\.app$/.test(hostname);
  }

  function isNetlifyStagingBranchDeploy(hostname) {
    const match = hostname.match(
      /^([a-z0-9-]+)--sigdocs-lab\.netlify\.app$/,
    );
    if (!match) return false;

    const branchName = match[1];
    return (
      branchName === "feature" ||
      branchName.startsWith("feature-") ||
      branchName === "staging" ||
      branchName.startsWith("staging-")
    );
  }

  function resolveRuntimeConfig(location) {
    const hostname = String(location.hostname || "").trim().toLowerCase();
    const isLocalFrontend =
      location.protocol === "file:" ||
      ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(
        hostname,
      ) ||
      isPrivateLanHostname(hostname);

    if (isLocalFrontend) {
      return {
        API_URL: "",
        ENVIRONMENT: "local",
        AUTH_MODE: "bearer",
        AI_CLASSIFICATION_UI_ENABLED: false,
      };
    }

    if (
      isNetlifyDeployPreview(hostname) ||
      isNetlifyStagingBranchDeploy(hostname)
    ) {
      return {
        API_URL: STAGING_API_URL,
        ENVIRONMENT: "staging",
        AUTH_MODE: "cookie",
        AI_CLASSIFICATION_UI_ENABLED: false,
      };
    }

    return {
      API_URL: PRODUCTION_API_URL,
      ENVIRONMENT: "production",
      AUTH_MODE: "bearer",
      AI_CLASSIFICATION_UI_ENABLED: false,
    };
  }

  const api = Object.freeze({ resolveRuntimeConfig });
  if (globalScope.location) {
    globalScope.SIGDOCS_CONFIG = Object.freeze(
      resolveRuntimeConfig(globalScope.location),
    );
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
