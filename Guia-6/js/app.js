const RUNTIME_CONFIG = window.SIGDOCS_CONFIG || {};
const API_BASE_URL = resolveApiBaseUrl(RUNTIME_CONFIG);
const RUNTIME_ENVIRONMENT = ["local", "staging", "production"].includes(
  RUNTIME_CONFIG.ENVIRONMENT,
)
  ? RUNTIME_CONFIG.ENVIRONMENT
  : "production";
const AUTH_MODE = resolveAuthMode(RUNTIME_CONFIG, RUNTIME_ENVIRONMENT);
const AI_CLASSIFICATION_UI_ENABLED =
  RUNTIME_CONFIG.AI_CLASSIFICATION_UI_ENABLED === true
  && RUNTIME_ENVIRONMENT !== "production";
const authClient = window.SIGDOCS_AUTH.createAuthClient({
  mode: AUTH_MODE,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
});
const PROCESS_TYPES = ["Estrategico", "Misional", "Apoyo"];
const STATUS_LABELS = {
  vigente: "Vigente",
  obsoleto: "Obsoleto",
};
const PROCESS_META = {
  Estrategico: {
    title: "Procesos Estrategicos",
    shortName: "Estrategico",
    description: "Direccion, planeacion y gestion del sistema de calidad.",
  },
  Misional: {
    title: "Procesos Misionales",
    shortName: "Misional",
    description: "Actividades clinicas centrales del servicio de laboratorio.",
  },
  Apoyo: {
    title: "Procesos de Apoyo",
    shortName: "Apoyo",
    description: "Recursos, soporte operativo y continuidad institucional.",
  },
};
const DEFAULT_BRANDING = {
  logoText: "SL",
  logoUrl: "./img/isotipo.png",
  name: "SIGDocs Lab",
  subtitle: "MVP documental",
};
const MAX_LOGO_MB = 2;
const ALLOWED_LOGO_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const ALLOWED_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg"];
const ALLOWED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
];
const PASSWORD_REQUIREMENTS_MESSAGE =
  "La contrasena debe tener minimo 8 caracteres, una mayuscula, una minuscula, un numero y un caracter especial.";
const PUBLIC_API_TIMEOUT_MS = 45000;
const PUBLIC_BACKEND_UNAVAILABLE_MESSAGE =
  "El servidor esta iniciando. Espera unos segundos e intentalo nuevamente.";
const DOCUMENT_UPLOAD_CONCURRENCY = 1;
const MAX_DOCUMENT_BATCH_FILES = 50;
const MAX_DOCUMENT_UPLOAD_MB = 10;
const DOCUMENT_TYPE_OPTIONS = Object.freeze({
  manual: "Manual",
  procedimiento: "Procedimiento",
  instructivo: "Instructivo",
  formato: "Formato",
  registro: "Registro",
  politica: "Política",
  programa: "Programa",
  matriz: "Matriz",
  informe: "Informe",
  guia: "Guía",
});

const state = {
  token: authClient.getBearerToken(),
  usuario: null,
  laboratorio: null,
  subprocesos: [],
  documentos: [],
  documentSummary: { total: 0, vigentes: 0, obsoletos: 0 },
  documentSummaryLoading: false,
  documentSummaryGeneration: 0,
  usuarios: [],
  currentSection: "dashboardSection",
  selectedDocumentId: null,
  documentUploadInProgress: false,
  documentUploadQueue: null,
  aiClassificationController: null,
  documentDownloadsInProgress: new Set(),
  masterListExporter: null,
  brandingSaveInProgress: false,
  brandingPreviewObjectUrl: null,
  runtimeLogoSource: "",
  runtimeLogoObjectUrl: null,
  sessionLifecycle: null,
  activeSession: null,
  dataLoadGeneration: 0,
  documentsQueryActive: false,
  documentQueryString: "",
  pendingModalAction: null,
  publicAuthConfig: {
    public_registration_enabled: false,
    password_reset_enabled: false,
    turnstile_enabled: false,
    turnstile_site_key: null,
  },
  publicAccountFlow: {
    email: "",
    completionToken: null,
    resetToken: null,
    resendTimer: null,
    turnstileScriptPromise: null,
    turnstileTokens: new Map(),
    turnstileWidgets: new Map(),
  },
};

const els = {};

function resolveApiBaseUrl(runtimeConfig) {
  const configuredUrl = String(runtimeConfig.API_URL || "").trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, "");

  if (window.location.protocol === "file:") {
    return "http://127.0.0.1:8000";
  }

  const hostname = window.location.hostname || "127.0.0.1";
  return `http://${hostname}:8000`;
}

function resolveAuthMode(runtimeConfig, environment) {
  const configuredMode = String(runtimeConfig.AUTH_MODE || "").trim().toLowerCase();
  if (environment === "staging") {
    if (configuredMode !== "cookie") {
      throw new Error("Staging requiere autenticacion por cookie");
    }
    return "cookie";
  }
  return "bearer";
}

function buildApiUrl(path = "") {
  const normalizedPath = String(path).replace(/^\/+/, "");
  return normalizedPath ? `${API_BASE_URL}/${normalizedPath}` : API_BASE_URL;
}

function isRemoteBackend() {
  return RUNTIME_ENVIRONMENT === "staging" || RUNTIME_ENVIRONMENT === "production";
}

async function requestApi(url, options) {
  const externalSignal = options?.signal || null;
  const isMultipartRequest =
    typeof FormData !== "undefined" && options?.body instanceof FormData;
  const shouldUseTimeout =
    isRemoteBackend() &&
    !isMultipartRequest &&
    typeof AbortController !== "undefined";
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  let abortedBySession = false;
  const abortFromSession = () => {
    abortedBySession = true;
    controller?.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) abortFromSession();
    else externalSignal.addEventListener("abort", abortFromSession, { once: true });
  }
  const timeoutId = shouldUseTimeout && controller
    ? window.setTimeout(() => controller.abort(), PUBLIC_API_TIMEOUT_MS)
    : null;

  try {
    return await fetch(url, {
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (abortedBySession || externalSignal?.aborted) {
      throw new window.SIGDOCS_SESSION_LIFECYCLE.SessionTransitionError();
    }
    const message = isRemoteBackend()
      ? PUBLIC_BACKEND_UNAVAILABLE_MESSAGE
      : "No fue posible conectar con el backend. Verifica que el servidor local este activo.";
    const networkError = new Error(message);
    networkError.kind = isRemoteBackend() ? "backend-unavailable" : "network";
    throw networkError;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromSession);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  initializeDocumentTypeControls();
  initializeSessionLifecycle();
  initializeDocumentUploadQueue();
  initializeMasterListExporter();
  bindEvents();
  initializePasswordToggles();
  applyRuntimeEnvironment();
  const publicAccountStartup = initializePublicAccountFlow();
  setMobileMenu(false);
  clearLegacyStoredContext();

  const startupApi = window.SIGDOCS_PUBLIC_ACCOUNT_STARTUP;
  if (!startupApi) throw new Error("No fue posible inicializar el acceso publico");
  await startupApi.coordinateStartup({
    hasResetToken: publicAccountStartup.hasResetToken,
    configPromise: publicAccountStartup.configPromise,
    isResetReady: hasPendingPasswordReset,
    showLoading: showSessionLoadingView,
    showAccess: () => state.sessionLifecycle.resetToAccess(),
    startSessionBootstrap: startInitialSessionBootstrap,
  });
});

function startInitialSessionBootstrap() {
  if (authClient.canBootstrap()) {
    const sessionContext = beginSessionTransition();
    loadInitialData({ sessionContext, initial: true });
  } else {
    state.sessionLifecycle.resetToAccess();
  }
}

window.addEventListener("beforeunload", () => {
  clearRuntimeLogoSource();
  releaseBrandingPreviewObjectUrl();
});

function cacheElements() {
  els.loginView = document.querySelector("#loginView");
  els.sessionLoadingView = document.querySelector("#sessionLoadingView");
  els.appView = document.querySelector("#appView");
  els.loginForm = document.querySelector("#loginForm");
  els.registerForm = document.querySelector("#registerForm");
  els.verificationForm = document.querySelector("#verificationForm");
  els.completionForm = document.querySelector("#completionForm");
  els.registrationSuccess = document.querySelector("#registrationSuccess");
  els.pendingVerificationForm = document.querySelector("#pendingVerificationForm");
  els.forgotPasswordForm = document.querySelector("#forgotPasswordForm");
  els.resetPasswordForm = document.querySelector("#resetPasswordForm");
  els.createAccountTab = document.querySelector("#createAccountTab");
  els.forgotPasswordLink = document.querySelector("#forgotPasswordLink");
  els.pendingVerificationLink = document.querySelector("#pendingVerificationLink");
  els.resendCodeButton = document.querySelector("#resendCodeButton");
  els.resendCountdown = document.querySelector("#resendCountdown");
  els.verificationMessage = document.querySelector("#verificationMessage");
  els.completionMessage = document.querySelector("#completionMessage");
  els.pendingVerificationMessage = document.querySelector("#pendingVerificationMessage");
  els.forgotPasswordMessage = document.querySelector("#forgotPasswordMessage");
  els.resetPasswordMessage = document.querySelector("#resetPasswordMessage");
  els.loginMessage = document.querySelector("#loginMessage");
  els.loginError = document.querySelector("#loginError");
  els.registerMessage = document.querySelector("#registerMessage");
  els.authTitle = document.querySelector("#authTitle");
  els.authSubtitle = document.querySelector("#authSubtitle");
  els.loginLogoText = document.querySelector("#loginLogoText");
  els.loginLogoImage = document.querySelector("#loginLogoImage");
  els.sidebarLogoText = document.querySelector("#sidebarLogoText");
  els.sidebarLogoImage = document.querySelector("#sidebarLogoImage");
  els.sidebarBrandName = document.querySelector("#sidebarBrandName");
  els.sidebarBrandSubtitle = document.querySelector("#sidebarBrandSubtitle");
  els.sidebar = document.querySelector("#mainSidebar");
  els.mobileMenuButton = document.querySelector("#mobileMenuButton");
  els.mobileMenuCloseButton = document.querySelector("#mobileMenuCloseButton");
  els.mobileMenuBackdrop = document.querySelector("#mobileMenuBackdrop");
  els.mobileLabName = document.querySelector("#mobileLabName");
  els.mobileUserName = document.querySelector("#mobileUserName");
  els.mobileUserRole = document.querySelector("#mobileUserRole");
  els.openBrandEditorButton = document.querySelector("#openBrandEditorButton");
  els.brandEditorOverlay = document.querySelector("#brandEditorOverlay");
  els.brandEditorForm = document.querySelector("#brandEditorForm");
  els.closeBrandEditorButton = document.querySelector("#closeBrandEditorButton");
  els.resetBrandingButton = document.querySelector("#resetBrandingButton");
  els.brandNameInput = document.querySelector("#brandNameInput");
  els.brandSubtitleInput = document.querySelector("#brandSubtitleInput");
  els.brandLogoTextInput = document.querySelector("#brandLogoTextInput");
  els.brandLogoUrlInput = document.querySelector("#brandLogoUrlInput");
  els.brandLogoFileInput = document.querySelector("#brandLogoFileInput");
  els.brandLogoPreviewImage = document.querySelector("#brandLogoPreviewImage");
  els.brandLogoPreviewText = document.querySelector("#brandLogoPreviewText");
  els.brandSaveButton = document.querySelector("#brandSaveButton");
  els.brandSaveStatus = document.querySelector("#brandSaveStatus");
  els.logoutButton = document.querySelector("#logoutButton");
  els.labName = document.querySelector("#labName");
  els.userName = document.querySelector("#userName");
  els.userRole = document.querySelector("#userRole");
  els.toast = document.querySelector("#toast");
  els.refreshAllButton = document.querySelector("#refreshAllButton");
  els.subprocessForm = document.querySelector("#subprocessForm");
  els.subprocessTableBody = document.querySelector("#subprocessTableBody");
  els.processMap = document.querySelector("#processMap");
  els.documentForm = document.querySelector("#documentForm");
  els.documentSubmitButton = document.querySelector("#documentSubmitButton");
  els.documentUploadStatus = document.querySelector("#documentUploadStatus");
  els.documentFileInput = els.documentForm.querySelector("input[name=\"archivo\"]");
  els.bulkUploadPanel = document.querySelector("#bulkUploadPanel");
  els.bulkUploadList = document.querySelector("#bulkUploadList");
  els.bulkUploadSummary = document.querySelector("#bulkUploadSummary");
  els.bulkUploadProgress = document.querySelector("#bulkUploadProgress");
  els.bulkUploadProgressLabel = document.querySelector("#bulkUploadProgressLabel");
  els.bulkSelectionCounter = document.querySelector("#bulkSelectionCounter");
  els.documentDropZone = document.querySelector("#documentDropZone");
  els.retryFailedUploadsButton = document.querySelector("#retryFailedUploadsButton");
  els.stopBulkUploadButton = document.querySelector("#stopBulkUploadButton");
  els.clearCompletedUploadsButton = document.querySelector("#clearCompletedUploadsButton");
  els.aiSuggestButton = document.querySelector("#aiSuggestButton");
  els.aiFeatureNotice = document.querySelector("#aiFeatureNotice");
  els.undoAiSuggestionsButton = document.querySelector("#undoAiSuggestionsButton");
  els.refreshBulkCatalogsButton = document.querySelector("#refreshBulkCatalogsButton");
  els.applyCommonMetadataButton = document.querySelector("#applyCommonMetadataButton");
  els.bulkCommonControls = document.querySelector("#bulkCommonControls");
  els.bulkCommonDocumentType = document.querySelector("#bulkCommonDocumentType");
  els.bulkCommonVersion = document.querySelector("#bulkCommonVersion");
  els.bulkCommonEffectiveDate = document.querySelector("#bulkCommonEffectiveDate");
  els.bulkCommonReviewDate = document.querySelector("#bulkCommonReviewDate");
  els.bulkCommonObservations = document.querySelector("#bulkCommonObservations");
  els.documentTypeFilter = document.querySelector("#documentTypeFilter");
  els.exportMasterListButton = document.querySelector("#exportMasterListButton");
  els.operationAnnouncements = document.querySelector("#operationAnnouncements");
  els.documentProcessSelect = document.querySelector("#documentProcessSelect");
  els.documentSubprocessSelect = document.querySelector("#documentSubprocessSelect");
  els.filtersForm = document.querySelector("#filtersForm");
  els.clearFiltersButton = document.querySelector("#clearFiltersButton");
  els.viewAllDocumentsButton = document.querySelector("#viewAllDocumentsButton");
  els.filterSubprocessSelect = document.querySelector("#filterSubprocessSelect");
  els.documentsTableBody = document.querySelector("#documentsTableBody");
  els.userForm = document.querySelector("#userForm");
  els.usersTableBody = document.querySelector("#usersTableBody");
  els.actionModalOverlay = document.querySelector("#actionModalOverlay");
  els.actionModalTitle = document.querySelector("#actionModalTitle");
  els.actionModalBody = document.querySelector("#actionModalBody");
  els.closeActionModalButton = document.querySelector("#closeActionModalButton");
  els.cancelActionModalButton = document.querySelector("#cancelActionModalButton");
  els.confirmActionModalButton = document.querySelector("#confirmActionModalButton");
}

function initializeSessionLifecycle() {
  const lifecycleApi = window.SIGDOCS_SESSION_LIFECYCLE;
  if (!lifecycleApi) throw new Error("No fue posible inicializar la sesion");

  state.sessionLifecycle = lifecycleApi.createSessionLifecycle({
    reset: resetSessionDataAndDom,
    showLoading: showSessionLoadingView,
    showAccess: showAccessView,
    showApplication: showApplicationView,
    scheduleAccess: (callback) => window.requestAnimationFrame(callback),
  });
}

function initializeDocumentUploadQueue() {
  const bulkUploadApi = window.SIGDOCS_BULK_UPLOAD;
  if (!bulkUploadApi) throw new Error("No fue posible inicializar la carga documental");
  state.documentUploadQueue = bulkUploadApi.createBulkUploadQueue({
    validateFile: getDocumentFileValidationError,
    onChange: renderBulkUploadQueue,
    maxFiles: MAX_DOCUMENT_BATCH_FILES,
  });
  renderBulkUploadQueue([], state.documentUploadQueue.getSummary(), false);
}

function initializeMasterListExporter() {
  const exportApi = window.SIGDOCS_MASTER_LIST_EXPORT;
  if (!exportApi) throw new Error("No fue posible inicializar la exportacion Excel");

  state.masterListExporter = exportApi.createMasterListExporter({
    request: async (sessionContext) => {
      const response = await requestSessionApi("/documentos/listado-maestro.xlsx", {
        sessionContext,
      });
      if (!response.ok) throw await parseError(response);
      return response;
    },
    assertCurrent: (sessionContext) => {
      state.sessionLifecycle.assertCurrent(sessionContext);
    },
    isSessionTransitionError,
    resolveFilename: (response) =>
      getDownloadFileName(response.headers.get("Content-Disposition")),
    saveBlob: saveBlobDownload,
    setBusy: (isBusy, label) => {
      setButtonBusy(els.exportMasterListButton, isBusy, label);
    },
    notify: (message, tone) => {
      showToast(message, tone);
      announceOperation(message);
    },
  });
}

function initializeDocumentTypeControls() {
  els.bulkCommonDocumentType.innerHTML = renderDocumentTypeOptions("", "Seleccionar");
  els.documentTypeFilter.innerHTML = renderDocumentTypeOptions("", "Todos los tipos");
}

function beginSessionTransition() {
  const sessionContext = state.sessionLifecycle.begin();
  state.activeSession = sessionContext;
  return sessionContext;
}

function clearLegacyStoredContext() {
  localStorage.removeItem("sigdocs_usuario");
  localStorage.removeItem("sigdocs_laboratorio");
  localStorage.removeItem("sigdocs_branding");
  sessionStorage.removeItem("sigdocs_usuario");
  sessionStorage.removeItem("sigdocs_laboratorio");
  sessionStorage.removeItem("sigdocs_branding");
}

function clearStoredToken() {
  authClient.clear();
  state.token = null;
}

function resetSessionDataAndDom() {
  clearRuntimeLogoSource();
  releaseBrandingPreviewObjectUrl();
  clearLegacyStoredContext();
  state.activeSession = null;
  state.usuario = null;
  state.laboratorio = null;
  state.subprocesos = [];
  state.documentos = [];
  state.documentSummary = { total: 0, vigentes: 0, obsoletos: 0 };
  state.documentSummaryLoading = false;
  state.documentSummaryGeneration += 1;
  state.usuarios = [];
  state.currentSection = "dashboardSection";
  state.selectedDocumentId = null;
  state.documentUploadInProgress = false;
  state.aiClassificationController?.abort();
  state.aiClassificationController = null;
  state.documentUploadQueue?.clear();
  state.masterListExporter?.reset();
  state.documentDownloadsInProgress.clear();
  state.brandingSaveInProgress = false;
  state.dataLoadGeneration += 1;
  state.documentsQueryActive = false;
  state.documentQueryString = "";
  state.pendingModalAction = null;

  els.labName.textContent = "";
  els.userName.textContent = "";
  els.userRole.textContent = "";
  els.mobileLabName.textContent = "";
  els.mobileUserName.textContent = "";
  els.mobileUserRole.textContent = "";
  ["#totalDocs", "#activeDocs", "#obsoleteDocs"].forEach(
    (selector) => {
      const counter = document.querySelector(selector);
      if (counter) counter.textContent = "0";
    },
  );
  els.processMap.replaceChildren();
  els.subprocessTableBody.replaceChildren();
  els.documentsTableBody.replaceChildren();
  els.usersTableBody.replaceChildren();
  els.documentSubprocessSelect.replaceChildren();
  els.filterSubprocessSelect.replaceChildren();
  els.subprocessForm.reset();
  els.documentForm.reset();
  els.filtersForm.reset();
  els.userForm.reset();
  els.brandEditorForm.reset();
  els.brandEditorOverlay.classList.add("hidden");
  els.brandEditorOverlay.setAttribute("aria-hidden", "true");
  els.actionModalOverlay.classList.add("hidden");
  document.body.classList.remove("modal-open");
  setOperationStatus(els.documentUploadStatus, "");
  setOperationStatus(els.brandSaveStatus, "");
  els.toast.textContent = "";
  els.toast.classList.add("hidden");
  els.loginError.textContent = "";
  window.clearTimeout(showToast.timeoutId);
  setMobileMenu(false);
  applyBranding(DEFAULT_BRANDING);
}

function showSessionLoadingView() {
  els.loginView.classList.add("hidden");
  els.appView.classList.add("hidden");
  els.sessionLoadingView.classList.remove("hidden");
}

function showAccessView() {
  state.activeSession = null;
  els.appView.classList.add("hidden");
  els.sessionLoadingView.classList.add("hidden");
  els.loginView.classList.remove("hidden");
  setAuthView("login");
  applyBranding(DEFAULT_BRANDING);
}

function showApplicationView() {
  els.loginView.classList.add("hidden");
  els.sessionLoadingView.classList.add("hidden");
  els.appView.classList.remove("hidden");
  els.labName.textContent = state.laboratorio?.nombre || "Laboratorio";
  els.userName.textContent = state.usuario?.nombre || "Usuario";
  els.userRole.textContent = state.usuario?.rol || "rol";
  updateMobileSessionSummary();
  applyBranding(getBrandingConfig());
  applyRoleVisibility();
}

function applyRuntimeEnvironment() {
  const isStaging = RUNTIME_ENVIRONMENT === "staging";
  document.querySelectorAll("[data-staging-indicator]").forEach((indicator) => {
    indicator.classList.toggle("hidden", !isStaging);
  });

  els.aiSuggestButton.textContent = AI_CLASSIFICATION_UI_ENABLED
    ? "Sugerir con IA"
    : "Clasificación con IA — Próximamente";
  els.aiSuggestButton.disabled = !AI_CLASSIFICATION_UI_ENABLED;
  els.aiSuggestButton.setAttribute(
    "aria-disabled",
    String(!AI_CLASSIFICATION_UI_ENABLED),
  );
  els.aiFeatureNotice.textContent = AI_CLASSIFICATION_UI_ENABLED
    ? "La sugerencia con IA utiliza los nombres de los archivos y los catalogos de clasificacion. El contenido de los documentos no se envia."
    : "Función opcional disponible en una futura versión.";
}

function bindEvents() {
  els.loginForm.addEventListener("submit", handleLogin);
  els.registerForm.addEventListener("submit", handleRegister);
  els.verificationForm.addEventListener("submit", handleRegistrationVerification);
  els.completionForm.addEventListener("submit", handleRegistrationCompletion);
  els.pendingVerificationForm.addEventListener("submit", handlePendingVerification);
  els.forgotPasswordForm.addEventListener("submit", handleForgotPassword);
  els.resetPasswordForm.addEventListener("submit", handlePasswordReset);
  els.resendCodeButton.addEventListener("click", handleRegistrationResend);
  els.logoutButton.addEventListener("click", logout);
  els.refreshAllButton.addEventListener("click", () => loadInitialData());
  els.subprocessForm.addEventListener("submit", handleSubprocessCreate);
  els.documentForm.addEventListener("submit", handleDocumentCreate);
  els.documentForm.addEventListener(
    "invalid",
    () => {
      if (!state.documentUploadInProgress) {
        setOperationStatus(
          els.documentUploadStatus,
          "Revisa los campos obligatorios antes de continuar.",
          "error",
        );
      }
    },
    true,
  );
  els.documentFileInput.addEventListener("change", handleDocumentFilesSelected);
  ["dragenter", "dragover"].forEach((eventName) => {
    els.documentDropZone.addEventListener(eventName, handleDocumentDragOver);
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.documentDropZone.addEventListener(eventName, handleDocumentDragEnd);
  });
  els.documentDropZone.addEventListener("drop", handleDocumentDrop);
  els.bulkUploadList.addEventListener("input", handleBulkMetadataInput);
  els.bulkUploadList.addEventListener("change", handleBulkMetadataInput);
  els.retryFailedUploadsButton.addEventListener("click", handleRetryFailedUploads);
  els.stopBulkUploadButton.addEventListener("click", stopDocumentBatch);
  els.clearCompletedUploadsButton.addEventListener("click", clearCompletedDocumentUploads);
  if (AI_CLASSIFICATION_UI_ENABLED) {
    els.aiSuggestButton.addEventListener("click", handleAiClassification);
  }
  els.undoAiSuggestionsButton.addEventListener("click", undoAiClassifications);
  els.refreshBulkCatalogsButton.addEventListener("click", refreshBulkCatalogs);
  els.applyCommonMetadataButton.addEventListener("click", applyCommonMetadataToBatch);
  els.documentProcessSelect.addEventListener("change", renderDocumentSubprocessOptions);
  els.filtersForm.addEventListener("submit", handleDocumentFilters);
  els.clearFiltersButton.addEventListener("click", clearFilters);
  els.viewAllDocumentsButton.addEventListener("click", viewAllDocuments);
  els.exportMasterListButton.addEventListener("click", handleMasterListExport);
  els.userForm.addEventListener("submit", handleUserCreate);
  els.openBrandEditorButton.addEventListener("click", openBrandEditor);
  els.closeBrandEditorButton.addEventListener("click", closeBrandEditor);
  els.resetBrandingButton.addEventListener("click", removeBrandingLogo);
  els.brandEditorForm.addEventListener("submit", handleBrandingSave);
  els.brandLogoFileInput.addEventListener("change", handleBrandLogoSelection);
  els.brandEditorOverlay.addEventListener("click", (event) => {
    if (event.target === els.brandEditorOverlay) closeBrandEditor();
  });
  els.closeActionModalButton.addEventListener("click", closeActionModal);
  els.cancelActionModalButton.addEventListener("click", closeActionModal);
  els.confirmActionModalButton.addEventListener("click", confirmActionModal);
  els.actionModalOverlay.addEventListener("click", (event) => {
    if (event.target === els.actionModalOverlay) closeActionModal();
  });
  els.mobileMenuButton.addEventListener("click", () => setMobileMenu(true));
  els.mobileMenuCloseButton.addEventListener("click", () => setMobileMenu(false));
  els.mobileMenuBackdrop.addEventListener("click", () => setMobileMenu(false));
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) setMobileMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setMobileMenu(false);
  });

  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => showSection(button.dataset.section));
  });

  document.querySelectorAll("[data-auth-view]").forEach((button) => {
    button.addEventListener("click", () => setAuthView(button.dataset.authView));
  });
  document.querySelectorAll("[data-public-auth-view]").forEach((button) => {
    button.addEventListener("click", () => setAuthView(button.dataset.publicAuthView));
  });

  document.body.addEventListener("click", handleDelegatedClick);
}

async function handleLogin(event) {
  event.preventDefault();
  els.loginError.textContent = "";
  els.loginMessage.textContent = "";
  const formData = new FormData(els.loginForm);
  clearStoredToken();
  const sessionContext = beginSessionTransition();

  try {
    const response = await apiFetch(authClient.loginPath, {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
      skipAuth: true,
      sessionContext,
    });

    setSession(response, sessionContext);
    els.loginForm.reset();
    resetPasswordVisibility(els.loginForm);
    await loadInitialData({ sessionContext, initial: true });
    if (state.sessionLifecycle.isCurrent(sessionContext)) {
      showToast("Sesion iniciada");
    }
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    clearStoredToken();
    state.sessionLifecycle.fail(sessionContext);
    els.loginError.textContent = error.message;
  }
}

async function handleRegister(event) {
  event.preventDefault();
  els.registerMessage.textContent = "";
  const formData = new FormData(els.registerForm);
  const submitButton = els.registerForm.querySelector("button[type='submit']");
  const email = String(formData.get("email") || "").trim().toLowerCase();
  setButtonBusy(submitButton, true, "Enviando codigo...");
  try {
    const response = await publicApiFetch("/auth/registration/start", {
      method: "POST",
      body: JSON.stringify({
        nombre: String(formData.get("nombre") || "").trim(),
        email,
        turnstile_token: getTurnstileToken("registration"),
      }),
    });
    state.publicAccountFlow.email = email;
    els.verificationMessage.textContent = response.message;
    resetTurnstile("registration");
    setAuthView("verify");
    startResendCountdown(response.resend_available_in_seconds);
  } catch (error) {
    els.registerMessage.textContent = error.message;
    resetTurnstile("registration");
  } finally {
    setButtonBusy(submitButton, false);
  }
}

function initializePublicAccountFlow() {
  const url = new URL(window.location.href);
  const fragmentParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const resetToken = String(
    fragmentParams.get("reset_token") || url.searchParams.get("reset_token") || "",
  ).trim();
  if (resetToken) {
    state.publicAccountFlow.resetToken = resetToken;
    url.searchParams.delete("reset_token");
    fragmentParams.delete("reset_token");
    url.hash = fragmentParams.toString() ? `#${fragmentParams.toString()}` : "";
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }
  return {
    hasResetToken: Boolean(resetToken),
    configPromise: loadPublicAuthConfig(),
  };
}

async function loadPublicAuthConfig() {
  try {
    const config = await publicApiFetch("/auth/public-config");
    state.publicAuthConfig = {
      public_registration_enabled: config.public_registration_enabled === true,
      password_reset_enabled: config.password_reset_enabled === true,
      turnstile_enabled: config.turnstile_enabled === true,
      turnstile_site_key: config.turnstile_site_key || null,
    };
  } catch (_) {
    state.publicAuthConfig = {
      public_registration_enabled: false,
      password_reset_enabled: false,
      turnstile_enabled: false,
      turnstile_site_key: null,
    };
  }

  els.createAccountTab.classList.toggle(
    "hidden",
    !state.publicAuthConfig.public_registration_enabled,
  );
  els.createAccountTab.parentElement.classList.toggle(
    "single-option",
    !state.publicAuthConfig.public_registration_enabled,
  );
  els.pendingVerificationLink.classList.toggle(
    "hidden",
    !state.publicAuthConfig.public_registration_enabled,
  );
  els.forgotPasswordLink.classList.toggle(
    "hidden",
    !state.publicAuthConfig.password_reset_enabled,
  );
}

function hasPendingPasswordReset() {
  const startupApi = window.SIGDOCS_PUBLIC_ACCOUNT_STARTUP;
  return startupApi.hasPendingPasswordReset({
    resetToken: state.publicAccountFlow.resetToken,
    passwordResetEnabled: state.publicAuthConfig.password_reset_enabled,
  });
}

function getTurnstileToken(context) {
  if (!state.publicAuthConfig.turnstile_enabled) return null;
  return state.publicAccountFlow.turnstileTokens.get(context) || null;
}

function ensureTurnstileScript() {
  if (!state.publicAuthConfig.turnstile_enabled) return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (state.publicAccountFlow.turnstileScriptPromise) {
    return state.publicAccountFlow.turnstileScriptPromise;
  }
  state.publicAccountFlow.turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("No fue posible cargar la validacion anti-bot.")), { once: true });
    document.head.append(script);
  });
  return state.publicAccountFlow.turnstileScriptPromise;
}

async function renderTurnstile(context) {
  if (!state.publicAuthConfig.turnstile_enabled) return;
  const container = document.querySelector(`[data-turnstile-context="${context}"]`);
  if (!container || state.publicAccountFlow.turnstileWidgets.has(context)) return;
  container.classList.remove("hidden");
  try {
    await ensureTurnstileScript();
    const widgetId = window.turnstile.render(container, {
      sitekey: state.publicAuthConfig.turnstile_site_key,
      callback: (token) => state.publicAccountFlow.turnstileTokens.set(context, token),
      "expired-callback": () => state.publicAccountFlow.turnstileTokens.delete(context),
      "error-callback": () => state.publicAccountFlow.turnstileTokens.delete(context),
    });
    state.publicAccountFlow.turnstileWidgets.set(context, widgetId);
  } catch (error) {
    const statusElement = container.parentElement?.querySelector("[role='status']");
    if (statusElement) statusElement.textContent = error.message;
  }
}

function resetTurnstile(context) {
  state.publicAccountFlow.turnstileTokens.delete(context);
  const widgetId = state.publicAccountFlow.turnstileWidgets.get(context);
  if (widgetId !== undefined && window.turnstile) window.turnstile.reset(widgetId);
}

function startResendCountdown(seconds) {
  stopResendCountdown();
  let remaining = Math.max(0, Number(seconds) || 0);
  if (!remaining) return;
  const render = () => {
    els.resendCodeButton.disabled = remaining > 0;
    els.resendCountdown.textContent = remaining > 0
      ? `Puedes solicitar otro codigo en ${remaining} segundos.`
      : "";
    if (remaining <= 0) stopResendCountdown();
    remaining -= 1;
  };
  render();
  state.publicAccountFlow.resendTimer = window.setInterval(render, 1000);
}

function stopResendCountdown() {
  if (state.publicAccountFlow.resendTimer) {
    window.clearInterval(state.publicAccountFlow.resendTimer);
    state.publicAccountFlow.resendTimer = null;
  }
  if (els.resendCodeButton) {
    els.resendCodeButton.disabled = false;
    els.resendCodeButton.textContent = "Reenviar codigo";
  }
  if (els.resendCountdown) els.resendCountdown.textContent = "";
}

async function handleRegistrationVerification(event) {
  event.preventDefault();
  const submitButton = els.verificationForm.querySelector("button[type='submit']");
  els.verificationMessage.textContent = "";
  setButtonBusy(submitButton, true, "Verificando...");
  try {
    const response = await publicApiFetch("/auth/registration/verify", {
      method: "POST",
      body: JSON.stringify({
        email: state.publicAccountFlow.email,
        code: String(new FormData(els.verificationForm).get("code") || "").trim(),
      }),
    });
    state.publicAccountFlow.completionToken = response.completion_token;
    els.verificationForm.reset();
    stopResendCountdown();
    setAuthView("complete");
  } catch (error) {
    els.verificationMessage.textContent = error.message;
  } finally {
    setButtonBusy(submitButton, false);
  }
}

async function handleRegistrationResend() {
  if (els.resendCodeButton.disabled || !state.publicAccountFlow.email) return;
  setButtonBusy(els.resendCodeButton, true, "Enviando...");
  els.verificationMessage.textContent = "";
  try {
    const response = await publicApiFetch("/auth/registration/resend", {
      method: "POST",
      body: JSON.stringify({
        email: state.publicAccountFlow.email,
        turnstile_token: getTurnstileToken("resend"),
      }),
    });
    els.verificationMessage.textContent = response.message;
    resetTurnstile("resend");
    startResendCountdown(response.resend_available_in_seconds);
  } catch (error) {
    els.verificationMessage.textContent = error.message;
    resetTurnstile("resend");
  } finally {
    if (!state.publicAccountFlow.resendTimer) {
      setButtonBusy(els.resendCodeButton, false);
    }
  }
}

async function handlePendingVerification(event) {
  event.preventDefault();
  const submitButton = els.pendingVerificationForm.querySelector("button[type='submit']");
  const email = String(new FormData(els.pendingVerificationForm).get("email") || "").trim().toLowerCase();
  els.pendingVerificationMessage.textContent = "";
  setButtonBusy(submitButton, true, "Solicitando...");
  try {
    const response = await publicApiFetch("/auth/registration/resend", {
      method: "POST",
      body: JSON.stringify({
        email,
        turnstile_token: getTurnstileToken("pending"),
      }),
    });
    state.publicAccountFlow.email = email;
    els.verificationMessage.textContent = response.message;
    resetTurnstile("pending");
    setAuthView("verify");
    startResendCountdown(response.resend_available_in_seconds);
  } catch (error) {
    els.pendingVerificationMessage.textContent = error.message;
    resetTurnstile("pending");
  } finally {
    setButtonBusy(submitButton, false);
  }
}

async function handleRegistrationCompletion(event) {
  event.preventDefault();
  const formData = new FormData(els.completionForm);
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirm_password") || "");
  const passwordError = getPasswordValidationError(password);
  if (passwordError || password !== confirmPassword) {
    els.completionMessage.textContent = passwordError || "Las contrasenas no coinciden.";
    return;
  }
  const submitButton = els.completionForm.querySelector("button[type='submit']");
  setButtonBusy(submitButton, true, "Creando cuenta...");
  els.completionMessage.textContent = "";
  try {
    await publicApiFetch("/auth/registration/complete", {
      method: "POST",
      body: JSON.stringify({
        completion_token: state.publicAccountFlow.completionToken,
        password,
        confirm_password: confirmPassword,
        nombre_laboratorio: String(formData.get("nombre_laboratorio") || "").trim(),
        descripcion_corta: String(formData.get("descripcion_corta") || "").trim() || null,
      }),
    });
    state.publicAccountFlow.completionToken = null;
    state.publicAccountFlow.email = "";
    els.completionForm.reset();
    resetPasswordVisibility(els.completionForm);
    setAuthView("success");
  } catch (error) {
    els.completionMessage.textContent = error.message;
  } finally {
    setButtonBusy(submitButton, false);
  }
}

async function handleForgotPassword(event) {
  event.preventDefault();
  const submitButton = els.forgotPasswordForm.querySelector("button[type='submit']");
  const email = String(new FormData(els.forgotPasswordForm).get("email") || "").trim();
  setButtonBusy(submitButton, true, "Enviando...");
  els.forgotPasswordMessage.textContent = "";
  try {
    const response = await publicApiFetch("/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({
        email,
        turnstile_token: getTurnstileToken("forgot"),
      }),
    });
    els.forgotPasswordMessage.textContent = response.message;
    els.forgotPasswordForm.reset();
    resetTurnstile("forgot");
  } catch (error) {
    els.forgotPasswordMessage.textContent = error.message;
    resetTurnstile("forgot");
  } finally {
    setButtonBusy(submitButton, false);
  }
}

async function handlePasswordReset(event) {
  event.preventDefault();
  const formData = new FormData(els.resetPasswordForm);
  const password = String(formData.get("new_password") || "");
  const confirmation = String(formData.get("confirm_password") || "");
  const passwordError = getPasswordValidationError(password);
  if (passwordError || password !== confirmation) {
    els.resetPasswordMessage.textContent = passwordError || "Las contrasenas no coinciden.";
    return;
  }
  const submitButton = els.resetPasswordForm.querySelector("button[type='submit']");
  setButtonBusy(submitButton, true, "Actualizando...");
  els.resetPasswordMessage.textContent = "";
  try {
    const response = await publicApiFetch("/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({
        token: state.publicAccountFlow.resetToken,
        new_password: password,
        confirm_password: confirmation,
      }),
    });
    state.publicAccountFlow.resetToken = null;
    els.resetPasswordForm.reset();
    resetPasswordVisibility(els.resetPasswordForm);
    setAuthView("login");
    els.loginMessage.textContent = response.message;
  } catch (error) {
    els.resetPasswordMessage.textContent = error.message;
  } finally {
    setButtonBusy(submitButton, false);
  }
}

function setSession(response, sessionContext) {
  state.sessionLifecycle.assertCurrent(sessionContext);
  authClient.captureLogin(response);
  state.token = authClient.getBearerToken();
}

function logout() {
  const sessionContext = state.activeSession;
  const remoteLogout =
    authClient.isCookie && sessionContext && authClient.hasCsrf()
      ? requestSessionApi("/auth/session/logout", {
          method: "POST",
          sessionContext,
          detached: true,
          retryCsrf: false,
        }).catch(() => null)
      : Promise.resolve(null);
  clearStoredToken();
  state.activeSession = state.sessionLifecycle.logout();
  els.loginError.textContent = "";
  els.loginMessage.textContent = "";
  resetPasswordVisibility(els.loginForm);
  resetPasswordVisibility(els.completionForm);
  resetPasswordVisibility(els.resetPasswordForm);
  void remoteLogout;
}

function updateMobileSessionSummary() {
  els.mobileLabName.textContent = state.laboratorio?.nombre || "Laboratorio";
  els.mobileUserName.textContent = state.usuario?.nombre || "Usuario";
  els.mobileUserRole.textContent = state.usuario?.rol || "rol";
}

function setMobileMenu(isOpen) {
  if (!els.sidebar) return;
  const isMobile = window.innerWidth <= 900;
  const shouldOpen = Boolean(isOpen && isMobile);
  els.sidebar.classList.toggle("mobile-open", shouldOpen);
  els.mobileMenuBackdrop.classList.toggle("visible", shouldOpen);
  els.mobileMenuButton.setAttribute("aria-expanded", String(shouldOpen));
  els.sidebar.setAttribute("aria-hidden", String(isMobile && !shouldOpen));
  if (isMobile && !shouldOpen) {
    els.sidebar.setAttribute("inert", "");
  } else {
    els.sidebar.removeAttribute("inert");
  }
  document.body.classList.toggle("mobile-menu-open", shouldOpen);
}

function applyRoleVisibility() {
  const isAdmin = isAdminUser();
  document.querySelectorAll(".admin-only").forEach((element) => {
    element.classList.toggle("hidden", !isAdmin);
  });
}

async function loadInitialData({
  sessionContext = state.activeSession,
  initial = false,
} = {}) {
  if (!sessionContext || !authClient.canBootstrap()) return;
  const loadGeneration = ++state.dataLoadGeneration;

  try {
    const context = await apiFetch(authClient.contextPath, { sessionContext });
    authClient.confirmAuthentication();
    assertActiveLoad(sessionContext, loadGeneration);
    if (authClient.isCookie) {
      const csrf = await apiFetch("/auth/session/csrf", {
        sessionContext,
        retryCsrf: false,
      });
      authClient.captureCsrf(csrf);
      assertActiveLoad(sessionContext, loadGeneration);
    }
    const usuario = context.usuario;
    const laboratorio = context.laboratorio;
    const isAdmin = ["admin", "administrador"].includes(usuario?.rol);
    const [subprocesos, usuarios, documentSummary] = await Promise.all([
      apiFetch(isAdmin ? "/subprocesos?incluir_inactivos=true" : "/subprocesos", { sessionContext }),
      isAdmin
        ? apiFetch("/usuarios", { sessionContext })
        : Promise.resolve([]),
      apiFetch("/documentos/resumen", { sessionContext }),
    ]);
    assertActiveLoad(sessionContext, loadGeneration);
    state.usuario = usuario;
    state.laboratorio = laboratorio;
    state.subprocesos = subprocesos;
    state.documentos = [];
    state.documentSummary = documentSummary;
    state.documentSummaryLoading = false;
    state.documentsQueryActive = false;
    state.documentQueryString = "";
    state.usuarios = usuarios;
    await refreshLaboratoryLogo({ silent: true, sessionContext });
    assertActiveLoad(sessionContext, loadGeneration);
    renderAll();
    showSection("dashboardSection", { refreshDashboard: false });
    if (initial) state.sessionLifecycle.ready(sessionContext);
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    if (initial || error.status === 401) {
      clearStoredToken();
      state.sessionLifecycle.fail(sessionContext);
      els.loginError.textContent = error.message;
      return;
    }
    showToast(error.message, "error");
  }
}

function assertActiveLoad(sessionContext, loadGeneration) {
  state.sessionLifecycle.assertCurrent(sessionContext);
  if (loadGeneration !== state.dataLoadGeneration) {
    throw new window.SIGDOCS_SESSION_LIFECYCLE.SessionTransitionError();
  }
}

function isSessionTransitionError(error) {
  return Boolean(error?.silent || error?.name === "AbortError");
}

function renderAll() {
  applyRoleVisibility();
  renderDashboard();
  renderProcessMap();
  renderSubprocessTable();
  renderDocumentSubprocessOptions();
  renderFilterSubprocessOptions();
  renderDocumentsTable();
  renderUsersTable();
}

function renderDashboard() {
  const counters = {
    totalDocs: state.documentSummary.total,
    activeDocs: state.documentSummary.vigentes,
    obsoleteDocs: state.documentSummary.obsoletos,
  };
  Object.entries(counters).forEach(([id, value]) => {
    const counter = document.querySelector(`#${id}`);
    if (!counter) return;
    counter.textContent = state.documentSummaryLoading ? "…" : String(value || 0);
    counter.closest(".metric-card")?.setAttribute(
      "aria-busy",
      String(state.documentSummaryLoading),
    );
  });
}

function renderProcessMap() {
  els.processMap.innerHTML = PROCESS_TYPES.map((tipo) => {
    const meta = PROCESS_META[tipo];
    const items = state.subprocesos.filter(
      (item) => item.tipo_proceso === tipo && item.estado === "activo",
    );
    const list = items.length
      ? items
          .map(
            (item) => `
              <li>
                <button class="subprocess-chip" type="button" data-action="filter-by-subprocess" data-id="${item.id}">
                  ${escapeHtml(item.nombre_subproceso)}
                </button>
              </li>
            `,
          )
          .join("")
      : "<li class=\"empty-state\">Sin subprocesos</li>";

    return `
      <article class="process-column" data-process="${escapeHtml(tipo)}">
        <div class="process-heading">
          <span>${meta.shortName}</span>
          <h4>${meta.title}</h4>
          <p>${meta.description}</p>
        </div>
        <ul class="subprocess-list">${list}</ul>
      </article>
    `;
  }).join("");
}

function renderSubprocessTable() {
  if (!state.subprocesos.length) {
    els.subprocessTableBody.innerHTML = emptyRow(4, "No hay subprocesos registrados");
    return;
  }

  els.subprocessTableBody.innerHTML = state.subprocesos
    .map((item) => {
      const actions =
        isAdminUser()
          ? `
            <td class="admin-only" data-label="Acciones">
              <div class="row-actions">
                <button class="mini-button" type="button" data-action="edit-subprocess" data-id="${item.id}">Editar</button>
                ${item.estado === "activo"
                  ? `<button class="mini-button" type="button" data-action="delete-subprocess" data-id="${item.id}">Inactivar</button>`
                  : `<button class="mini-button" type="button" data-action="reactivate-subprocess" data-id="${item.id}">Reactivar</button>`}
              </div>
            </td>
          `
          : "";
      return `
        <tr>
          <td data-label="Proceso">${escapeHtml(item.tipo_proceso)}</td>
          <td data-label="Subproceso">${escapeHtml(item.nombre_subproceso)}</td>
          <td data-label="Estado">${escapeHtml(item.estado)}</td>
          ${actions}
        </tr>
      `;
    })
    .join("");
}

function renderDocumentSubprocessOptions() {
  const selectedProcess = els.documentProcessSelect.value;
  if (!selectedProcess) {
    els.documentSubprocessSelect.innerHTML = "<option value=\"\">Selecciona un proceso</option>";
    return;
  }
  const options = state.subprocesos
    .filter((item) => item.tipo_proceso === selectedProcess && item.estado === "activo")
    .map((item) => `<option value="${item.id}">${escapeHtml(item.nombre_subproceso)}</option>`)
    .join("");
  els.documentSubprocessSelect.innerHTML = options
    ? `<option value="">Seleccionar</option>${options}`
    : "<option value=\"\">No hay subprocesos</option>";
}

function renderFilterSubprocessOptions() {
  const currentValue = els.filterSubprocessSelect.value;
  els.filterSubprocessSelect.innerHTML = `
    <option value="">Todos los subprocesos</option>
    ${state.subprocesos
      .map(
        (item) =>
          `<option value="${item.id}">${escapeHtml(item.tipo_proceso)} - ${escapeHtml(item.nombre_subproceso)}</option>`,
      )
      .join("")}
  `;
  els.filterSubprocessSelect.value = currentValue;
}

function renderDocumentsTable() {
  if (
    state.selectedDocumentId &&
    !state.documentos.some((documento) => documento.id === state.selectedDocumentId)
  ) {
    closeDocumentDetail();
  }

  if (!state.documentos.length) {
    const message = state.documentsQueryActive
      ? "No se encontraron documentos con los criterios aplicados."
      : "Selecciona los criterios de consulta para visualizar documentos.";
    els.documentsTableBody.innerHTML = emptyRow(10, message);
    return;
  }

  els.documentsTableBody.innerHTML = state.documentos
    .map((documento) => {
      const expanded = state.selectedDocumentId === documento.id;
      return `
        <tr class="document-row${expanded ? " expanded" : ""}">
          <td data-label="Codigo">${escapeHtml(documento.codigo)}</td>
          <td data-label="Documento">${escapeHtml(documento.nombre)}</td>
          <td data-label="Tipo documental">${escapeHtml(getDocumentTypeLabel(documento.tipo_documental))}</td>
          <td data-label="Proceso">${escapeHtml(documento.tipo_proceso)}</td>
          <td data-label="Subproceso">${escapeHtml(documento.subproceso_nombre || "-")}</td>
          <td data-label="Version">${escapeHtml(documento.version)}</td>
          <td data-label="Vigencia">${formatDate(documento.fecha_vigencia)}</td>
          <td data-label="Revisión">${formatDate(documento.fecha_revision)}</td>
          <td data-label="Estado">${statusBadge(documento.estado)}</td>
          <td data-label="Acciones">
            <div class="row-actions">
              <button class="mini-button" type="button" data-action="view-document" data-id="${documento.id}" aria-expanded="${expanded}">${expanded ? "Ocultar" : "Ver"}</button>
              <button class="mini-button" type="button" data-action="download-document" data-id="${documento.id}">Descargar</button>
              ${isAdminUser() ? `<button class="mini-button" type="button" data-action="edit-document" data-id="${documento.id}">Editar documento</button>` : ""}
              ${isAdminUser() ? `<button class="mini-button" type="button" data-action="new-document-version" data-id="${documento.id}">Nueva versión</button>` : ""}
              ${isAdminUser() ? `<button class="mini-button danger" type="button" data-action="delete-document" data-id="${documento.id}">Eliminar</button>` : ""}
            </div>
          </td>
        </tr>
        ${expanded ? renderDocumentDetailRow(documento) : ""}
      `;
    })
    .join("");
}

function renderDocumentDetailRow(documento) {
  return `
    <tr class="document-detail-row">
      <td colspan="10">
        <section class="detail-panel" aria-label="Detalle de ${escapeHtml(documento.nombre)}">
          <div class="detail-heading">
            <div>
              <p class="eyebrow">Detalle</p>
              <h3>${escapeHtml(documento.nombre)}</h3>
            </div>
            <div class="row-actions">
              <button class="btn secondary" type="button" data-action="download-document" data-id="${documento.id}">Descargar</button>
              <button class="btn ghost" type="button" data-action="close-document-detail">Cerrar detalle</button>
            </div>
          </div>
          <div class="detail-grid">
            <div><span>Código</span>${escapeHtml(documento.codigo)}</div>
            <div><span>Versión</span>${escapeHtml(documento.version)}</div>
            <div><span>Tipo documental</span>${escapeHtml(getDocumentTypeLabel(documento.tipo_documental))}</div>
            <div><span>Proceso</span>${escapeHtml(documento.tipo_proceso)}</div>
            <div><span>Subproceso</span>${escapeHtml(documento.subproceso_nombre || "-")}</div>
            <div><span>Vigencia</span>${formatDate(documento.fecha_vigencia)}</div>
            <div><span>Revisión</span>${formatDate(documento.fecha_revision)}</div>
            <div><span>Estado</span>${statusBadge(documento.estado)}</div>
            <div><span>Fecha de carga</span>${formatDateTime(documento.fecha_carga)}</div>
            <div><span>Cargado por</span>${escapeHtml(documento.creado_por_nombre || "-")}</div>
            <div class="span-two"><span>Observaciones</span>${escapeHtml(documento.observaciones || "-")}</div>
          </div>
        </section>
      </td>
    </tr>
  `;
}

function hasActiveDocumentFilters() {
  return Array.from(new FormData(els.filtersForm).values()).some(
    (value) => String(value || "").trim() !== "",
  );
}

function renderUsersTable() {
  if (!isAdminUser()) return;
  if (!state.usuarios.length) {
    els.usersTableBody.innerHTML = emptyRow(5, "No hay usuarios registrados");
    return;
  }

  els.usersTableBody.innerHTML = state.usuarios
    .map(
      (usuario) => `
        <tr>
          <td data-label="Nombre">${escapeHtml(usuario.nombre)}</td>
          <td data-label="Email">${escapeHtml(usuario.email)}</td>
          <td data-label="Rol">${escapeHtml(usuario.rol)}</td>
          <td data-label="Estado">${escapeHtml(usuario.estado)}</td>
          <td data-label="Acciones">
            <div class="row-actions">
              <button class="mini-button" type="button" data-action="edit-user" data-id="${usuario.id}">Editar</button>
              ${usuario.id === state.usuario?.id ? "" : usuario.estado === "activo"
                ? `<button class="mini-button danger" type="button" data-action="deactivate-user" data-id="${usuario.id}">Desactivar</button>`
                : `<button class="mini-button" type="button" data-action="reactivate-user" data-id="${usuario.id}">Reactivar</button>`}
            </div>
          </td>
        </tr>
      `,
    )
    .join("");
}

async function handleSubprocessCreate(event) {
  event.preventDefault();
  const sessionContext = state.activeSession;
  const formData = new FormData(els.subprocessForm);

  try {
    await apiFetch("/subprocesos", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries())),
      sessionContext,
    });
    els.subprocessForm.reset();
    await refreshSubprocesses(sessionContext);
    renderAll();
    showToast("Subproceso creado");
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    if (error.code === "subproceso_inactivo" && error.entityId) {
      openSubprocessReactivationModal(error.entityId);
      return;
    }
    showToast(error.message);
  }
}

async function handleDocumentCreate(event) {
  event.preventDefault();
  if (state.documentUploadInProgress || state.documentUploadQueue.isRunning()) return;
  if (!isAdminUser()) {
    setDocumentUploadStage("Solo un administrador puede cargar documentos.", "error");
    return;
  }
  if (!validateDocumentForm()) return;

  const sessionContext = state.activeSession;
  state.documentUploadInProgress = true;
  setDocumentUploadBusy(true, "Preparando lote...");

  try {
    const result = await state.documentUploadQueue.run(
      (item, updateStage, uploadSignal) => uploadQueuedDocument(
        item,
        sessionContext,
        updateStage,
        uploadSignal,
      ),
      { concurrency: DOCUMENT_UPLOAD_CONCURRENCY },
    );
    if (!result.started) return;
    state.sessionLifecycle.assertCurrent(sessionContext);
    await finalizeDocumentBatch(sessionContext);
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    const message = getDocumentOperationError(error, "upload");
    setDocumentUploadStage(message, "error");
    showToast(message, "error", 6500);
  } finally {
    if (state.sessionLifecycle.isCurrent(sessionContext)) {
      state.documentUploadInProgress = false;
      setDocumentUploadBusy(false);
      state.documentUploadQueue.notify();
    }
  }
}

async function handleRetryFailedUploads() {
  await retryDocumentUploads();
}

async function retryDocumentUploads(itemId = null) {
  if (state.documentUploadInProgress || state.documentUploadQueue.isRunning()) return;
  if (!isAdminUser()) return;
  if (!validateFailedDocumentMetadata(itemId)) return;
  const sessionContext = state.activeSession;
  state.documentUploadInProgress = true;
  setDocumentUploadBusy(true, "Reintentando archivos fallidos...");
  try {
    const uploadFile = (item, updateStage, uploadSignal) => uploadQueuedDocument(
      item,
      sessionContext,
      updateStage,
      uploadSignal,
    );
    const result = itemId
      ? await state.documentUploadQueue.retryItem(
          itemId,
          uploadFile,
          { concurrency: 1 },
        )
      : await state.documentUploadQueue.retryFailed(
          uploadFile,
          { concurrency: DOCUMENT_UPLOAD_CONCURRENCY },
        );
    if (!result.started) return;
    state.sessionLifecycle.assertCurrent(sessionContext);
    await finalizeDocumentBatch(sessionContext);
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    const message = getDocumentOperationError(error, "upload");
    setDocumentUploadStage(message, "error");
    showToast(message, "error", 6500);
  } finally {
    if (state.sessionLifecycle.isCurrent(sessionContext)) {
      state.documentUploadInProgress = false;
      setDocumentUploadBusy(false);
      state.documentUploadQueue.notify();
    }
  }
}

function validateFailedDocumentMetadata(itemId = null) {
  const failedItems = state.documentUploadQueue
    .getItems()
    .filter(
      (item) =>
        item.status === "error" &&
        (!itemId || item.id === itemId),
    );
  const invalidItem = failedItems.find((item) => (
    !hasCompleteDocumentMetadata(item)
    || window.SIGDOCS_BULK_UPLOAD.validateDocumentMetadata(
      item,
      state.subprocesos,
      Object.keys(DOCUMENT_TYPE_OPTIONS),
    )
  ));
  if (!failedItems.length || invalidItem) {
    setDocumentUploadStage(
      "Completa y revisa todos los metadatos del archivo antes de reintentar.",
      "error",
    );
    return false;
  }
  return true;
}

async function handleDocumentFilters(event) {
  event.preventDefault();
  const sessionContext = state.activeSession;
  const params = new URLSearchParams();
  const formData = new FormData(els.filtersForm);
  for (const [key, value] of formData.entries()) {
    if (value) params.set(key, value);
  }
  if (!params.toString()) {
    state.documentos = [];
    state.documentsQueryActive = false;
    state.documentQueryString = "";
    renderDocumentsTable();
    showToast("Selecciona al menos un criterio o usa Ver todos los documentos.", "warning");
    return;
  }
  await runDocumentQuery(params, sessionContext);
}

function clearFilters() {
  els.filtersForm.reset();
  state.documentos = [];
  state.documentsQueryActive = false;
  state.documentQueryString = "";
  closeDocumentDetail();
  renderDocumentsTable();
}

async function viewAllDocuments() {
  els.filtersForm.reset();
  await runDocumentQuery(new URLSearchParams(), state.activeSession, { viewAll: true });
}

async function runDocumentQuery(params, sessionContext, { viewAll = false } = {}) {
  const queryString = params.toString();
  try {
    state.documentos = await apiFetch(
      queryString ? `/documentos?${queryString}` : "/documentos",
      { sessionContext },
    );
    state.documentsQueryActive = Boolean(viewAll || queryString);
    state.documentQueryString = queryString;
    renderDocumentsTable();
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    showToast(error.message, "error");
  }
}

async function handleUserCreate(event) {
  event.preventDefault();
  const sessionContext = state.activeSession;
  const formData = new FormData(els.userForm);
  const payload = Object.fromEntries(formData.entries());
  const passwordError = getPasswordValidationError(String(payload.password || ""));

  if (passwordError) {
    showToast(passwordError);
    return;
  }

  try {
    await apiFetch("/usuarios", {
      method: "POST",
      body: JSON.stringify(payload),
      sessionContext,
    });
    els.userForm.reset();
    resetPasswordVisibility(els.userForm);
    state.usuarios = await apiFetch("/usuarios", { sessionContext });
    renderUsersTable();
    showToast("Usuario creado");
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    showToast(error.message);
  }
}

async function handleDelegatedClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();

  const { action, id } = button.dataset;
  if (action === "edit-subprocess") {
    await editSubprocess(Number(id));
  }
  if (action === "delete-subprocess") {
    await inactivateSubprocess(Number(id));
  }
  if (action === "reactivate-subprocess") {
    openSubprocessReactivationModal(Number(id));
  }
  if (action === "view-document") {
    showDocumentDetail(Number(id));
  }
  if (action === "close-document-detail") {
    closeDocumentDetail();
  }
  if (action === "download-document") {
    await downloadDocument(Number(id), button);
  }
  if (action === "edit-document") {
    openDocumentEditModal(Number(id));
  }
  if (action === "new-document-version") {
    openNewDocumentVersionModal(Number(id));
  }
  if (action === "delete-document") {
    await openDocumentDeleteModal(Number(id));
  }
  if (action === "edit-user") {
    openUserEditModal(Number(id));
  }
  if (action === "deactivate-user") {
    openUserStatusModal(Number(id), false);
  }
  if (action === "reactivate-user") {
    openUserStatusModal(Number(id), true);
  }
  if (action === "filter-by-subprocess") {
    await filterBySubprocess(Number(id));
  }
  if (action === "review-subprocess-documents") {
    closeActionModal();
    await filterBySubprocess(Number(id));
  }
  if (action === "remove-bulk-file") {
    state.documentUploadQueue.remove(id);
    syncBulkDocumentMetadata();
    if (!state.documentUploadQueue.getItems().length) {
      els.documentFileInput.value = "";
    }
  }
  if (action === "retry-bulk-file") {
    await retryDocumentUploads(id);
  }
  if (action === "cancel-bulk-file") {
    state.documentUploadQueue.cancel(id);
  }
}

async function editSubprocess(id) {
  const sessionContext = state.activeSession;
  const subproceso = state.subprocesos.find((item) => item.id === id);
  if (!subproceso) return;
  openActionModal({
    title: "Editar subproceso",
    confirmLabel: "Guardar cambios",
    danger: false,
    body: `
      <dl class="impact-summary compact">
        <div><dt>Proceso</dt><dd>${escapeHtml(subproceso.tipo_proceso)}</dd></div>
      </dl>
      <label class="action-field">Nombre
        <input id="editSubprocessName" type="text" maxlength="120" value="${escapeHtml(subproceso.nombre_subproceso)}" autocomplete="off" required />
      </label>
    `,
    onConfirm: async () => {
      const nombre = els.actionModalBody.querySelector("#editSubprocessName").value.trim();
      if (!nombre) throw new Error("El nombre del subproceso es obligatorio.");
      await apiFetch(`/subprocesos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ nombre_subproceso: nombre }),
        sessionContext,
      });
      await refreshSubprocesses(sessionContext);
      showToast("Subproceso actualizado", "success");
    },
  });
}

async function inactivateSubprocess(id) {
  const sessionContext = state.activeSession;
  try {
    const impact = await apiFetch(`/subprocesos/${id}/impacto`, { sessionContext });
    const destinations = state.subprocesos.filter(
      (item) => item.id !== id && item.estado === "activo",
    );
    const documentRows = impact.documentos.map((documento) => `
      <label class="action-document-option">
        <input type="checkbox" name="impactDocument" value="${documento.id}" />
        <span><strong>${escapeHtml(documento.codigo)} | V${escapeHtml(documento.version)}</strong>${escapeHtml(documento.nombre)}</span>
      </label>
    `).join("");
    const summary = `
      <dl class="impact-summary">
        <div><dt>Nombre</dt><dd>${escapeHtml(impact.subproceso.nombre_subproceso)}</dd></div>
        <div><dt>Proceso</dt><dd>${escapeHtml(impact.subproceso.tipo_proceso)}</dd></div>
        <div><dt>Estado</dt><dd>${escapeHtml(impact.subproceso.estado)}</dd></div>
        <div><dt>Documentos asociados</dt><dd>${impact.documentos_total}</dd></div>
      </dl>
    `;
    const body = impact.documentos_total === 0
      ? `${summary}<p>Este subproceso no tiene documentos asociados.</p>`
      : `
        ${summary}
        <div class="action-inline-heading">
          <p>¿Qué deseas hacer con los ${impact.documentos_total} documentos?</p>
          <button class="btn ghost" type="button" data-action="review-subprocess-documents" data-id="${id}">Revisar documentos</button>
        </div>
        <div class="subprocess-action-options" role="radiogroup" aria-label="Acción sobre documentos">
          <label class="subprocess-action-card selected">
            <input type="radio" name="subprocessAction" value="mantener_historico" checked />
            <span><strong>Mantener como históricos</strong><small>Permanecerán asociados al subproceso inactivo.</small></span>
          </label>
          <label class="subprocess-action-card">
            <input type="radio" name="subprocessAction" value="reasignar" />
            <span><strong>Reasignar los ${impact.documentos_total} documentos</strong><small>Se moverán juntos a otro subproceso activo.</small></span>
          </label>
          <div id="subprocessReassignControls" class="subprocess-conditional hidden">
            <label class="action-field">Subproceso destino
              <select id="subprocessDestination" autocomplete="off">
                <option value="">Selecciona un subproceso activo</option>
                ${destinations.map((item) => `<option value="${item.id}">${escapeHtml(item.tipo_proceso)} — ${escapeHtml(item.nombre_subproceso)}</option>`).join("")}
              </select>
            </label>
          </div>
          <label class="subprocess-action-card">
            <input type="radio" name="subprocessAction" value="eliminar_seleccionados" />
            <span><strong>Retirar documentos seleccionados</strong><small>El registro y el archivo se conservarán para trazabilidad.</small></span>
          </label>
          <div id="subprocessRemovalControls" class="subprocess-conditional hidden">
            <div class="selection-actions">
              <button class="mini-button" type="button" data-modal-selection="all">Seleccionar todos</button>
              <button class="mini-button" type="button" data-modal-selection="none">Quitar selección</button>
            </div>
            <div class="action-document-list">${documentRows}</div>
            <p class="form-hint">Si retiras la versión Vigente, el lifecycle seleccionará la versión numéricamente mayor que permanezca activa.</p>
          </div>
        </div>
      `;
    openActionModal({
      title: "Inactivar subproceso",
      confirmLabel: "Inactivar subproceso",
      body,
      onOpen: () => initializeSubprocessInactivationControls(),
      onConfirm: async () => {
        const accion = els.actionModalBody.querySelector("[name='subprocessAction']:checked")?.value || "mantener_historico";
        const documentoIds = Array.from(
          els.actionModalBody.querySelectorAll("[name='impactDocument']:checked"),
        ).map((input) => Number(input.value));
        await apiFetch(`/subprocesos/${id}`, {
          method: "DELETE",
          body: JSON.stringify({
            accion,
            destino_subproceso_id: Number(els.actionModalBody.querySelector("#subprocessDestination")?.value) || null,
            documento_ids: documentoIds,
          }),
          sessionContext,
        });
        await refreshSubprocesses(sessionContext);
        await refreshActiveDocumentQuery(sessionContext);
        await refreshDocumentSummary(sessionContext, { silent: true });
        showToast("Subproceso inactivado", "success");
      },
    });
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    showToast(error.message, "error");
  }
}

function initializeSubprocessInactivationControls() {
  const radios = els.actionModalBody.querySelectorAll("[name='subprocessAction']");
  if (!radios.length) return;
  const sync = () => {
    const selected = els.actionModalBody.querySelector("[name='subprocessAction']:checked")?.value;
    els.actionModalBody.querySelector("#subprocessReassignControls")?.classList.toggle("hidden", selected !== "reasignar");
    els.actionModalBody.querySelector("#subprocessRemovalControls")?.classList.toggle("hidden", selected !== "eliminar_seleccionados");
    els.actionModalBody.querySelectorAll(".subprocess-action-card").forEach((card) => {
      card.classList.toggle("selected", card.querySelector("input")?.checked);
    });
  };
  radios.forEach((radio) => radio.addEventListener("change", sync));
  els.actionModalBody.querySelectorAll("[data-modal-selection]").forEach((button) => {
    button.addEventListener("click", () => {
      const checked = button.dataset.modalSelection === "all";
      els.actionModalBody.querySelectorAll("[name='impactDocument']").forEach((input) => {
        input.checked = checked;
      });
    });
  });
  sync();
}

function openSubprocessReactivationModal(id) {
  const subproceso = state.subprocesos.find((item) => item.id === id);
  if (!subproceso) return;
  openActionModal({
    title: "Reactivar subproceso",
    confirmLabel: "Reactivar",
    danger: false,
    body: `<p>Este subproceso ya existe, pero está inactivo.</p><p><strong>${escapeHtml(subproceso.nombre_subproceso)}</strong> conservará el mismo ID y todo su historial documental.</p>`,
    onConfirm: async () => {
      await apiFetch(`/subprocesos/${id}/reactivar`, {
        method: "POST",
        sessionContext: state.activeSession,
      });
      await refreshSubprocesses(state.activeSession);
      showToast("Subproceso reactivado", "success");
    },
  });
}

function openDocumentEditModal(id) {
  const documento = state.documentos.find((item) => item.id === id);
  if (!documento) return;
  openActionModal({
    title: "Editar documento",
    confirmLabel: "Guardar cambios",
    danger: false,
    body: `
      <div class="action-form-grid">
        <label class="action-field">Código
          <input id="editDocumentCode" type="text" maxlength="80" value="${escapeHtml(documento.codigo)}" autocomplete="off" required />
        </label>
        <label class="action-field">Versión
          <input id="editDocumentVersion" type="text" maxlength="40" value="${escapeHtml(documento.version)}" autocomplete="off" required />
        </label>
        <label class="action-field span-two">Nombre
          <input id="editDocumentName" type="text" maxlength="220" value="${escapeHtml(documento.nombre)}" autocomplete="off" required />
        </label>
        <label class="action-field">Tipo documental
          <select id="editDocumentType" autocomplete="off" required>${renderDocumentTypeOptions(documento.tipo_documental, "Seleccionar")}</select>
        </label>
        <label class="action-field">Proceso
          <select id="editDocumentProcess" autocomplete="off" required>
            ${PROCESS_TYPES.map((tipo) => `<option value="${tipo}" ${tipo === documento.tipo_proceso ? "selected" : ""}>${tipo}</option>`).join("")}
          </select>
        </label>
        <label class="action-field span-two">Subproceso
          <select id="editDocumentSubprocess" autocomplete="off" required></select>
        </label>
        <label class="action-field">Fecha de vigencia
          <input id="editDocumentEffectiveDate" type="date" value="${escapeHtml(documento.fecha_vigencia)}" autocomplete="off" required />
        </label>
        <label class="action-field">Fecha de revisión
          <input id="editDocumentReviewDate" type="date" value="${escapeHtml(documento.fecha_revision || "")}" autocomplete="off" />
        </label>
        <label class="action-field span-two">Observaciones
          <textarea id="editDocumentObservations" rows="3" maxlength="1000">${escapeHtml(documento.observaciones || "")}</textarea>
        </label>
      </div>
      <p class="form-hint">El archivo físico no se reemplaza desde esta acción.</p>
    `,
    onOpen: () => {
      const process = els.actionModalBody.querySelector("#editDocumentProcess");
      const subprocess = els.actionModalBody.querySelector("#editDocumentSubprocess");
      const sync = (selectedId = null) => {
        subprocess.innerHTML = renderActiveSubprocessOptions(process.value, selectedId);
      };
      process.addEventListener("change", () => sync());
      sync(documento.subproceso_id);
    },
    onConfirm: async () => {
      const value = (selector) => els.actionModalBody.querySelector(selector)?.value;
      const fechaVigencia = value("#editDocumentEffectiveDate");
      const fechaRevision = value("#editDocumentReviewDate") || null;
      if (fechaRevision && fechaRevision < fechaVigencia) {
        throw new Error("La fecha de revisión no puede ser anterior a la fecha de vigencia.");
      }
      await apiFetch(`/documentos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          codigo: value("#editDocumentCode").trim(),
          nombre: value("#editDocumentName").trim(),
          tipo_documental: value("#editDocumentType"),
          tipo_proceso: value("#editDocumentProcess"),
          subproceso_id: Number(value("#editDocumentSubprocess")),
          version: value("#editDocumentVersion").trim(),
          fecha_vigencia: fechaVigencia,
          fecha_revision: fechaRevision,
          observaciones: value("#editDocumentObservations").trim() || null,
        }),
        sessionContext: state.activeSession,
      });
      await refreshActiveDocumentQuery(state.activeSession);
      await refreshDocumentSummary(state.activeSession, { silent: true });
      showToast("Documento actualizado", "success");
    },
  });
}

function openNewDocumentVersionModal(id) {
  const documento = state.documentos.find((item) => item.id === id);
  if (!documento) return;
  if (!documento.tipo_documental) {
    showToast(
      "Completa el tipo documental antes de crear una nueva versión.",
      "warning",
    );
    return;
  }
  const subproceso = state.subprocesos.find((item) => item.id === documento.subproceso_id);
  if (!subproceso || subproceso.estado !== "activo") {
    showToast(
      "Reasigna el documento a un subproceso activo antes de crear una nueva versión.",
      "warning",
    );
    return;
  }
  openActionModal({
    title: "Nueva versión",
    confirmLabel: "Cargar nueva versión",
    danger: false,
    body: `
      <dl class="impact-summary">
        <div><dt>Código</dt><dd>${escapeHtml(documento.codigo)}</dd></div>
        <div><dt>Documento</dt><dd>${escapeHtml(documento.nombre)}</dd></div>
        <div><dt>Proceso</dt><dd>${escapeHtml(documento.tipo_proceso)}</dd></div>
        <div><dt>Subproceso</dt><dd>${escapeHtml(documento.subproceso_nombre || "-")}</dd></div>
      </dl>
      <div class="action-form-grid">
        <label class="action-field">Nueva versión
          <input id="newVersionNumber" type="text" maxlength="40" placeholder="Ej. 4 o 4.1" autocomplete="off" required />
        </label>
        <label class="action-field">Fecha de vigencia
          <input id="newVersionEffectiveDate" type="date" autocomplete="off" required />
        </label>
        <label class="action-field">Fecha de revisión
          <input id="newVersionReviewDate" type="date" autocomplete="off" />
        </label>
        <label class="action-field">Nuevo archivo
          <input id="newVersionFile" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.png,.jpg,.jpeg" autocomplete="off" required />
        </label>
        <label class="action-field span-two">Observaciones
          <textarea id="newVersionObservations" rows="3" maxlength="1000">${escapeHtml(documento.observaciones || "")}</textarea>
        </label>
      </div>
      <p class="form-hint">El código se conserva para mantener la misma familia documental.</p>
    `,
    onConfirm: async () => {
      const value = (selector) => els.actionModalBody.querySelector(selector)?.value;
      const file = els.actionModalBody.querySelector("#newVersionFile")?.files?.[0];
      if (!file) throw new Error("Selecciona el archivo de la nueva versión.");
      const fileError = getDocumentFileValidationError(file);
      if (fileError) throw new Error(fileError);
      const version = value("#newVersionNumber").trim();
      const fechaVigencia = value("#newVersionEffectiveDate");
      const fechaRevision = value("#newVersionReviewDate") || "";
      if (!version || !fechaVigencia) throw new Error("Versión y fecha de vigencia son obligatorias.");
      if (fechaRevision && fechaRevision < fechaVigencia) {
        throw new Error("La fecha de revisión no puede ser anterior a la fecha de vigencia.");
      }
      const payload = new FormData();
      payload.append("codigo", documento.codigo);
      payload.append("nombre", documento.nombre);
      payload.append("tipo_documental", documento.tipo_documental);
      payload.append("tipo_proceso", documento.tipo_proceso);
      payload.append("subproceso_id", String(documento.subproceso_id));
      payload.append("version", version);
      payload.append("fecha_vigencia", fechaVigencia);
      if (fechaRevision) payload.append("fecha_revision", fechaRevision);
      const observations = value("#newVersionObservations").trim();
      if (observations) payload.append("observaciones", observations);
      payload.append("archivo", file, file.name);
      await apiFetch("/documentos", {
        method: "POST",
        body: payload,
        sessionContext: state.activeSession,
      });
      await refreshActiveDocumentQuery(state.activeSession);
      await refreshDocumentSummary(state.activeSession, { silent: true });
      showToast("Nueva versión cargada", "success");
    },
  });
}

function renderActiveSubprocessOptions(processType, selectedId = null) {
  const options = state.subprocesos
    .filter((item) => item.estado === "activo" && item.tipo_proceso === processType)
    .map((item) => `<option value="${item.id}" ${Number(selectedId) === item.id ? "selected" : ""}>${escapeHtml(item.nombre_subproceso)}</option>`)
    .join("");
  return `<option value="">Seleccionar</option>${options}`;
}

async function openDocumentDeleteModal(id) {
  const documento = state.documentos.find((item) => item.id === id);
  if (!documento) return;
  try {
    const impact = await apiFetch(`/documentos/${id}/eliminacion-impacto`, {
      sessionContext: state.activeSession,
    });
    const previousOption = impact.es_vigente && impact.versiones_anteriores
      ? `<label><input id="reactivatePreviousVersion" type="checkbox" /> Reactivar explícitamente la versión ${escapeHtml(impact.version_anterior_sugerida || "anterior")} como Vigente</label>`
      : "";
    openActionModal({
      title: "Eliminar documento",
      confirmLabel: "Retirar documento",
      body: `
        <dl class="impact-summary">
          <div><dt>Código</dt><dd>${escapeHtml(documento.codigo)}</dd></div>
          <div><dt>Nombre</dt><dd>${escapeHtml(documento.nombre)}</dd></div>
          <div><dt>Versión</dt><dd>${escapeHtml(documento.version)}</dd></div>
          <div><dt>Estado</dt><dd>${escapeHtml(STATUS_LABELS[documento.estado] || documento.estado)}</dd></div>
        </dl>
        <p>La eliminación retira el documento de las consultas operativas, pero conserva el registro, la auditoría y su archivo para trazabilidad histórica.</p>
        ${impact.es_vigente && !impact.versiones_anteriores ? "<p>Esta familia quedará sin una versión Vigente.</p>" : previousOption}
        <label class="action-field">Motivo opcional
          <textarea id="documentDeletionReason" rows="2" maxlength="500"></textarea>
        </label>
      `,
      onConfirm: async () => {
        await apiFetch(`/documentos/${id}`, {
          method: "DELETE",
          body: JSON.stringify({
            reactivar_version_anterior: Boolean(
              els.actionModalBody.querySelector("#reactivatePreviousVersion")?.checked,
            ),
            motivo: els.actionModalBody.querySelector("#documentDeletionReason")?.value.trim() || null,
          }),
          sessionContext: state.activeSession,
        });
        closeDocumentDetail();
        await refreshActiveDocumentQuery(state.activeSession);
        await refreshDocumentSummary(state.activeSession, { silent: true });
        showToast("Documento retirado de las consultas operativas", "success");
      },
    });
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    showToast(error.message, "error");
  }
}

function openUserEditModal(id) {
  const usuario = state.usuarios.find((item) => item.id === id);
  if (!usuario) return;
  const editingSelf = usuario.id === state.usuario?.id;
  openActionModal({
    title: "Editar usuario",
    confirmLabel: "Guardar cambios",
    danger: false,
    body: `
      <label class="action-field">Nombre
        <input id="editUserName" type="text" maxlength="120" value="${escapeHtml(usuario.nombre)}" autocomplete="name" />
      </label>
      <label class="action-field">Email
        <input id="editUserEmail" type="email" value="${escapeHtml(usuario.email)}" autocomplete="email" />
      </label>
      <label class="action-field">Rol
        <select id="editUserRole" ${editingSelf ? "disabled" : ""}>
          <option value="consulta" ${usuario.rol === "consulta" ? "selected" : ""}>Consulta</option>
          <option value="admin" ${["admin", "administrador"].includes(usuario.rol) ? "selected" : ""}>Administrador</option>
        </select>
      </label>
    `,
    onConfirm: async () => {
      const payload = {
        nombre: els.actionModalBody.querySelector("#editUserName").value.trim(),
        email: els.actionModalBody.querySelector("#editUserEmail").value.trim(),
      };
      if (!editingSelf) payload.rol = els.actionModalBody.querySelector("#editUserRole").value;
      await apiFetch(`/usuarios/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
        sessionContext: state.activeSession,
      });
      await refreshUsers(state.activeSession);
      showToast("Usuario actualizado", "success");
    },
  });
}

function openUserStatusModal(id, reactivate) {
  const usuario = state.usuarios.find((item) => item.id === id);
  if (!usuario) return;
  openActionModal({
    title: reactivate ? "Reactivar usuario" : "Desactivar usuario",
    confirmLabel: reactivate ? "Reactivar" : "Desactivar",
    danger: !reactivate,
    body: `<p><strong>${escapeHtml(usuario.nombre)}</strong> (${escapeHtml(usuario.email)})</p><p>${reactivate
      ? "El usuario recuperará acceso con el mismo ID e historial."
      : "El usuario perderá acceso y sus sesiones activas serán revocadas. Su historial documental se conservará."}</p>`,
    onConfirm: async () => {
      if (reactivate) {
        await apiFetch(`/usuarios/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ estado: "activo" }),
          sessionContext: state.activeSession,
        });
      } else {
        await apiFetch(`/usuarios/${id}`, {
          method: "DELETE",
          sessionContext: state.activeSession,
        });
      }
      await refreshUsers(state.activeSession);
      showToast(reactivate ? "Usuario reactivado" : "Usuario desactivado", "success");
    },
  });
}

function openActionModal({ title, body, confirmLabel, onConfirm, onOpen = null, danger = true }) {
  state.pendingModalAction = onConfirm;
  els.actionModalTitle.textContent = title;
  els.actionModalBody.innerHTML = body;
  els.confirmActionModalButton.textContent = confirmLabel;
  els.confirmActionModalButton.classList.toggle("danger", danger);
  els.confirmActionModalButton.classList.toggle("primary", !danger);
  els.actionModalOverlay.classList.remove("hidden");
  document.body.classList.add("modal-open");
  if (onOpen) onOpen();
}

function closeActionModal() {
  state.pendingModalAction = null;
  els.actionModalOverlay.classList.add("hidden");
  els.actionModalBody.replaceChildren();
  document.body.classList.remove("modal-open");
  setButtonBusy(els.confirmActionModalButton, false);
}

async function confirmActionModal() {
  if (!state.pendingModalAction) return;
  const action = state.pendingModalAction;
  setButtonBusy(els.confirmActionModalButton, true, "Procesando...");
  try {
    await action();
    closeActionModal();
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    showToast(error.message, "error", 6500);
    setButtonBusy(els.confirmActionModalButton, false);
  }
}

async function refreshSubprocesses(sessionContext) {
  state.subprocesos = await apiFetch("/subprocesos?incluir_inactivos=true", { sessionContext });
  renderProcessMap();
  renderSubprocessTable();
  renderDocumentSubprocessOptions();
  renderFilterSubprocessOptions();
}

async function refreshUsers(sessionContext) {
  state.usuarios = await apiFetch("/usuarios", { sessionContext });
  renderUsersTable();
}

async function refreshActiveDocumentQuery(sessionContext) {
  if (!state.documentsQueryActive) return;
  const params = new URLSearchParams(state.documentQueryString);
  await runDocumentQuery(params, sessionContext, {
    viewAll: !state.documentQueryString,
  });
}

async function refreshDocumentSummary(sessionContext, { silent = false } = {}) {
  if (!sessionContext || !state.sessionLifecycle.isCurrent(sessionContext)) return;
  const generation = ++state.documentSummaryGeneration;
  state.documentSummaryLoading = true;
  renderDashboard();
  try {
    const summary = await apiFetch("/documentos/resumen", { sessionContext });
    state.sessionLifecycle.assertCurrent(sessionContext);
    if (generation !== state.documentSummaryGeneration) return;
    state.documentSummary = summary;
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    if (!silent) showToast("No fue posible actualizar los indicadores.", "error");
  } finally {
    if (
      state.sessionLifecycle.isCurrent(sessionContext) &&
      generation === state.documentSummaryGeneration
    ) {
      state.documentSummaryLoading = false;
      renderDashboard();
    }
  }
}

function showDocumentDetail(id) {
  if (state.selectedDocumentId === id) {
    closeDocumentDetail();
    return;
  }
  if (!state.documentos.some((item) => item.id === id)) return;
  state.selectedDocumentId = id;
  renderDocumentsTable();
}

function closeDocumentDetail() {
  state.selectedDocumentId = null;
  renderDocumentsTable();
}

async function downloadDocument(id, button) {
  if (state.documentDownloadsInProgress.has(id)) return;

  const sessionContext = state.activeSession;
  state.documentDownloadsInProgress.add(id);
  setButtonBusy(button, true, "Preparando...");
  announceOperation("Preparando descarga del documento.");

  try {
    const response = await requestSessionApi(`/documentos/${id}/descargar`, {
      sessionContext,
    });
    if (!response.ok) {
      const error = await parseError(response);
      throw error;
    }

    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const download = await response.json();
      state.sessionLifecycle.assertCurrent(sessionContext);
      const signedDownloadUrl = getSafeUrl(download.download_url, ["https:"]);
      if (!signedDownloadUrl) {
        throw new Error("No fue posible preparar la descarga");
      }
      const link = document.createElement("a");
      link.href = signedDownloadUrl;
      link.download = download.filename || `documento_${id}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast("Descarga preparada correctamente.", "success");
      announceOperation("Descarga preparada correctamente.");
      return;
    }

    const blob = await response.blob();
    state.sessionLifecycle.assertCurrent(sessionContext);
    const fileName = getDownloadFileName(response.headers.get("Content-Disposition")) || `documento_${id}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Descarga iniciada correctamente.", "success");
    announceOperation("Descarga iniciada correctamente.");
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    const message = getDocumentOperationError(error, "download");
    showToast(message, "error", 6500);
    announceOperation(message);
  } finally {
    state.documentDownloadsInProgress.delete(id);
    setButtonBusy(button, false);
  }
}

async function filterBySubprocess(id) {
  const sessionContext = state.activeSession;
  showSection("documentsSection");
  els.filtersForm.reset();
  els.filterSubprocessSelect.value = String(id);
  const params = new URLSearchParams({ subproceso_id: String(id) });
  await runDocumentQuery(params, sessionContext);
}

function showSection(sectionId, { refreshDashboard = true } = {}) {
  setMobileMenu(false);
  if (sectionId !== "documentsSection") {
    closeDocumentDetail();
  }
  state.currentSection = sectionId;
  document.querySelectorAll(".content-section").forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.section === sectionId);
  });
  if (sectionId === "dashboardSection" && refreshDashboard) {
    void refreshDocumentSummary(state.activeSession);
  }
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function setAuthView(view) {
  const startupApi = window.SIGDOCS_PUBLIC_ACCOUNT_STARTUP;
  const prioritizedView = startupApi.resolveAccessView(view, {
    resetToken: state.publicAccountFlow.resetToken,
    passwordResetEnabled: state.publicAuthConfig.password_reset_enabled,
  });
  const allowedView = (
    prioritizedView === "register" && !state.publicAuthConfig.public_registration_enabled
  ) || (
    ["verify", "complete", "success", "pending"].includes(prioritizedView)
    && !state.publicAuthConfig.public_registration_enabled
  ) || (
    ["forgot", "reset"].includes(prioritizedView)
    && !state.publicAuthConfig.password_reset_enabled
  )
    ? "login"
    : prioritizedView;
  const views = {
    login: els.loginForm,
    register: els.registerForm,
    verify: els.verificationForm,
    complete: els.completionForm,
    success: els.registrationSuccess,
    pending: els.pendingVerificationForm,
    forgot: els.forgotPasswordForm,
    reset: els.resetPasswordForm,
  };
  const copy = {
    login: ["Iniciar sesion", "Ingresa a tu espacio documental"],
    register: ["Crear cuenta", "Crea una cuenta para un nuevo laboratorio"],
    verify: ["Verificar cuenta", "Ingresa el codigo de 6 digitos enviado a tu correo"],
    complete: ["Bienvenido a SIGDocs Lab", "Configuremos tu laboratorio"],
    success: ["Cuenta creada", "Tu espacio documental esta listo"],
    pending: ["Verificar cuenta", "Solicita un nuevo codigo de verificacion"],
    forgot: ["Recuperar contrasena", "Recibe un enlace seguro en tu correo"],
    reset: ["Nueva contrasena", "Define una nueva clave para tu cuenta"],
  };
  Object.entries(views).forEach(([name, element]) => {
    element.classList.toggle("hidden", name !== allowedView);
    if (name !== allowedView && element.tagName === "FORM") {
      resetPasswordVisibility(element);
    }
  });
  const [title, subtitle] = copy[allowedView] || copy.login;
  els.authTitle.textContent = title;
  els.authSubtitle.textContent = subtitle;
  document.querySelectorAll("[data-auth-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authView === allowedView);
  });
  const turnstileContext = {
    register: "registration",
    verify: "resend",
    pending: "pending",
    forgot: "forgot",
  }[allowedView];
  if (turnstileContext) void renderTurnstile(turnstileContext);
}

function getBrandingConfig() {
  const laboratorio = state.laboratorio || {};
  const labName = laboratorio.nombre_comercial || laboratorio.nombre;
  const name = labName || DEFAULT_BRANDING.name;
  const managedLogoProvider = ["local", "supabase"].includes(
    String(laboratorio.logo_storage_provider || "").toLowerCase(),
  );
  const hasProtectedLogo = managedLogoProvider || Boolean(laboratorio.logo_path);
  const externalLogoSource = laboratorio.logo_url || "";
  const logoSource =
    state.runtimeLogoSource ||
    (hasProtectedLogo ? "" : externalLogoSource);

  return {
    logoText:
      laboratorio.iniciales ||
      getInitials(name),
    logoUrl: isPersistableLogoSource(logoSource) ? logoSource : DEFAULT_BRANDING.logoUrl,
    name,
    subtitle:
      laboratorio.descripcion_corta ||
      DEFAULT_BRANDING.subtitle,
  };
}

function applyBranding(branding) {
  els.sidebarBrandName.textContent = branding.name;
  els.sidebarBrandSubtitle.textContent = branding.subtitle;
  updateLogoSlot(els.sidebarLogoText, els.sidebarLogoImage, branding);
  updateLogoSlot(els.loginLogoText, els.loginLogoImage, branding);
}

function updateLogoSlot(textElement, imageElement, branding) {
  if (!textElement || !imageElement) return;
  const hasLogo = Boolean(branding.logoUrl);
  imageElement.parentElement?.classList.toggle("has-image", hasLogo);
  textElement.textContent = branding.logoText || DEFAULT_BRANDING.logoText;
  textElement.classList.toggle("hidden", hasLogo);
  imageElement.classList.toggle("hidden", !hasLogo);
  imageElement.src = hasLogo ? resolveLogoSource(branding.logoUrl) : "";
  imageElement.alt = hasLogo ? `Logo ${branding.name}` : "";
}

function openBrandEditor() {
  if (!isAdminUser()) {
    showToast("Solo el administrador puede editar la marca");
    return;
  }

  setMobileMenu(false);
  const branding = getBrandingConfig();
  els.brandNameInput.value = branding.name;
  els.brandSubtitleInput.value = branding.subtitle;
  els.brandLogoTextInput.value = branding.logoText;
  els.brandLogoUrlInput.value = state.laboratorio?.logo_url || "";
  els.brandLogoFileInput.value = "";
  setOperationStatus(els.brandSaveStatus, "");
  renderBrandLogoPreview(branding.logoUrl, branding.logoText);
  els.brandEditorOverlay.classList.remove("hidden");
  els.brandEditorOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  els.brandNameInput.focus();
}

function closeBrandEditor() {
  if (state.brandingSaveInProgress) return;
  releaseBrandingPreviewObjectUrl();
  els.brandEditorOverlay.classList.add("hidden");
  els.brandEditorOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function handleBrandingSave(event) {
  event.preventDefault();
  if (state.brandingSaveInProgress) return;
  if (!isAdminUser()) {
    showToast("Solo el administrador puede editar la marca");
    return;
  }

  const sessionContext = state.activeSession;
  const formData = new FormData(els.brandEditorForm);
  const name = String(formData.get("name") || "").trim();
  const subtitle = String(formData.get("subtitle") || "").trim();
  const logoText = String(formData.get("logoText") || "").trim().toUpperCase();
  const logoUrl = String(formData.get("logoUrl") || "").trim();
  const logoFile = formData.get("logoFile");

  if (!name) {
    showToast("El nombre mostrado es obligatorio");
    return;
  }

  const hasLogoFile = logoFile instanceof File && logoFile.size > 0;
  if (hasLogoFile && !isValidLogoFile(logoFile)) return;

  const branding = {
    name,
    subtitle: subtitle || DEFAULT_BRANDING.subtitle,
    logoText: logoText || getInitials(name),
    logoUrl: hasLogoFile ? "" : logoUrl,
  };

  let textBrandingSaved = false;
  let logoUploadSaved = false;
  state.brandingSaveInProgress = true;
  els.brandEditorForm.setAttribute("aria-busy", "true");
  setButtonBusy(
    els.brandSaveButton,
    true,
    hasLogoFile ? "Actualizando logotipo..." : "Guardando marca...",
  );
  setOperationStatus(
    els.brandSaveStatus,
    hasLogoFile ? "Validando y guardando el nuevo logotipo..." : "Guardando los cambios...",
  );

  try {
    let laboratorio = await apiFetch("/laboratorios/me", {
      method: "PATCH",
      body: JSON.stringify({
        nombre: name,
        descripcion_corta: branding.subtitle,
        iniciales: branding.logoText,
        ...(hasLogoFile ? {} : { logo_url: logoUrl }),
      }),
      sessionContext,
    });
    textBrandingSaved = true;
    updateLaboratoryState(laboratorio);

    if (hasLogoFile) {
      const logoFormData = new FormData();
      logoFormData.append("archivo", logoFile);
      laboratorio = await apiFetch("/laboratorios/me/logo", {
        method: "POST",
        body: logoFormData,
        sessionContext,
      });
      logoUploadSaved = true;
      updateLaboratoryState(laboratorio);
      await refreshLaboratoryLogo({ silent: false, sessionContext });
      showToast("Logo actualizado correctamente.", "success");
    } else {
      if (!laboratorio.logo_storage_provider) clearRuntimeLogoSource();
      showToast("Marca actualizada", "success");
    }
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    const message = getBrandingOperationError(error);
    const finalMessage = logoUploadSaved
      ? "El logo se guardo, pero no pudo actualizarse su vista previa. Recarga los datos."
      : textBrandingSaved && hasLogoFile
      ? `Los datos de marca se guardaron, pero el logo no pudo actualizarse. ${message}`
      : message;
    setOperationStatus(els.brandSaveStatus, finalMessage, "error");
    showToast(finalMessage, "error");
    return;
  } finally {
    if (state.sessionLifecycle.isCurrent(sessionContext)) {
      state.brandingSaveInProgress = false;
      els.brandEditorForm.setAttribute("aria-busy", "false");
      setButtonBusy(els.brandSaveButton, false);
    }
  }

  applyBranding(getBrandingConfig());
  closeBrandEditor();
}

function handleBrandLogoSelection() {
  releaseBrandingPreviewObjectUrl();
  setOperationStatus(els.brandSaveStatus, "");
  const [logoFile] = els.brandLogoFileInput.files || [];
  if (!logoFile) {
    const branding = getBrandingConfig();
    renderBrandLogoPreview(branding.logoUrl, branding.logoText);
    return;
  }
  if (!isValidLogoFile(logoFile)) {
    els.brandLogoFileInput.value = "";
    const branding = getBrandingConfig();
    renderBrandLogoPreview(branding.logoUrl, branding.logoText);
    return;
  }
  state.brandingPreviewObjectUrl = URL.createObjectURL(logoFile);
  renderBrandLogoPreview(
    state.brandingPreviewObjectUrl,
    els.brandLogoTextInput.value || DEFAULT_BRANDING.logoText,
  );
}

function renderBrandLogoPreview(source, logoText) {
  if (!els.brandLogoPreviewImage || !els.brandLogoPreviewText) return;
  const resolvedSource = source ? resolveLogoSource(source) : "";
  els.brandLogoPreviewImage.src = resolvedSource;
  els.brandLogoPreviewImage.classList.toggle("hidden", !resolvedSource);
  els.brandLogoPreviewText.textContent = logoText || DEFAULT_BRANDING.logoText;
  els.brandLogoPreviewText.classList.toggle("hidden", Boolean(resolvedSource));
}

function releaseBrandingPreviewObjectUrl() {
  if (state.brandingPreviewObjectUrl) {
    URL.revokeObjectURL(state.brandingPreviewObjectUrl);
    state.brandingPreviewObjectUrl = null;
  }
}

async function removeBrandingLogo() {
  if (state.brandingSaveInProgress) return;
  if (!isAdminUser()) {
    showToast("Solo el administrador puede quitar el logo", "error");
    return;
  }

  const sessionContext = state.activeSession;
  let logoRemoved = false;
  state.brandingSaveInProgress = true;
  els.brandEditorForm.setAttribute("aria-busy", "true");
  els.brandSaveButton.disabled = true;
  setButtonBusy(els.resetBrandingButton, true, "Quitando logo...");
  setOperationStatus(els.brandSaveStatus, "Quitando el logo almacenado...");

  try {
    const laboratorio = await apiFetch("/laboratorios/me/logo", {
      method: "DELETE",
      sessionContext,
    });
    clearRuntimeLogoSource();
    updateLaboratoryState(laboratorio);
    releaseBrandingPreviewObjectUrl();
    renderBrandLogoPreview("", laboratorio.iniciales || getInitials(laboratorio.nombre));
    applyBranding(getBrandingConfig());
    logoRemoved = true;
    showToast("Logo eliminado correctamente.", "success");
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    const message = getBrandingOperationError(error);
    setOperationStatus(els.brandSaveStatus, message, "error");
    showToast(message, "error");
  } finally {
    if (state.sessionLifecycle.isCurrent(sessionContext)) {
      state.brandingSaveInProgress = false;
      els.brandEditorForm.setAttribute("aria-busy", "false");
      els.brandSaveButton.disabled = false;
      setButtonBusy(els.resetBrandingButton, false);
    }
  }

  if (logoRemoved) closeBrandEditor();
}

async function refreshLaboratoryLogo({
  silent = true,
  sessionContext = state.activeSession,
} = {}) {
  state.sessionLifecycle.assertCurrent(sessionContext);
  const provider = String(state.laboratorio?.logo_storage_provider || "").toLowerCase();
  const hasProtectedLogo =
    ["local", "supabase"].includes(provider) || Boolean(state.laboratorio?.logo_path);
  if (!authClient.canBootstrap() || !hasProtectedLogo) {
    clearRuntimeLogoSource();
    applyBranding(getBrandingConfig());
    return;
  }

  try {
    const response = await requestSessionApi("/laboratorios/me/logo", {
      sessionContext,
    });
    if (!response.ok) throw await parseError(response);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      state.sessionLifecycle.assertCurrent(sessionContext);
      const signedUrl = getSafeUrl(payload.download_url, ["https:"]);
      if (!signedUrl) {
        throw new Error("El servidor no devolvio una direccion de logo valida.");
      }
      setRuntimeLogoSource(signedUrl);
    } else {
      const logoBlob = await response.blob();
      state.sessionLifecycle.assertCurrent(sessionContext);
      if (!logoBlob.size) throw new Error("El logo almacenado esta vacio.");
      const objectUrl = URL.createObjectURL(logoBlob);
      setRuntimeLogoSource(objectUrl, { objectUrl: true });
    }
    applyBranding(getBrandingConfig());
  } catch (error) {
    if (isSessionTransitionError(error)) throw error;
    if (error.status === 404) {
      clearRuntimeLogoSource();
      applyBranding(getBrandingConfig());
      return;
    }
    if (!silent) throw error;
  }
}

function setRuntimeLogoSource(source, { objectUrl = false } = {}) {
  if (state.runtimeLogoObjectUrl && state.runtimeLogoObjectUrl !== source) {
    URL.revokeObjectURL(state.runtimeLogoObjectUrl);
  }
  state.runtimeLogoSource = source;
  state.runtimeLogoObjectUrl = objectUrl ? source : null;
}

function clearRuntimeLogoSource() {
  if (state.runtimeLogoObjectUrl) URL.revokeObjectURL(state.runtimeLogoObjectUrl);
  state.runtimeLogoSource = "";
  state.runtimeLogoObjectUrl = null;
}

function updateLaboratoryState(laboratorio) {
  state.laboratorio = laboratorio;
  applyBranding(getBrandingConfig());
  updateMobileSessionSummary();
}

function isAdminUser() {
  return state.usuario?.rol === "admin" || state.usuario?.rol === "administrador";
}

function initializePasswordToggles() {
  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    setPasswordVisibility(button, false);
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      setPasswordVisibility(button, input.type === "password");
    });
  });
}

function setPasswordVisibility(button, isVisible) {
  const input = document.getElementById(button.dataset.passwordToggle);
  if (!input) return;

  input.type = isVisible ? "text" : "password";
  const fieldDescription = input.name === "confirm_password"
    ? "contrasena de confirmacion"
    : input.id === "newUserPassword"
      ? "contrasena inicial"
      : "contrasena";
  const actionLabel = `${isVisible ? "Ocultar" : "Mostrar"} ${fieldDescription}`;
  button.setAttribute("aria-label", actionLabel);
  button.setAttribute("aria-pressed", String(isVisible));
  button.title = actionLabel;
  button.querySelector("use")?.setAttribute("href", isVisible ? "#icon-eye-off" : "#icon-eye");
}

function resetPasswordVisibility(form) {
  if (!form) return;
  form.querySelectorAll("[data-password-toggle]").forEach((button) => {
    setPasswordVisibility(button, false);
  });
}

function handleDocumentFilesSelected() {
  els.documentFileInput.setCustomValidity("");
  if (state.documentUploadInProgress) return;
  const selection = state.documentUploadQueue.addFiles(
    els.documentFileInput.files || [],
  );
  els.documentFileInput.value = "";
  syncBulkDocumentMetadata();
  if (selection.rejectedCapacity > 0) {
    setDocumentUploadStage(
      `Se alcanzo el limite de ${MAX_DOCUMENT_BATCH_FILES}. ${selection.rejectedCapacity} archivo(s) no se agregaron.`,
      "warning",
    );
  } else if (selection.invalid > 0) {
    setDocumentUploadStage(
      `${selection.invalid} archivo(s) requieren revision antes de cargar.`,
      "warning",
    );
  } else {
    setDocumentUploadStage("");
  }
}

async function handleMasterListExport() {
  await state.masterListExporter.exportMasterList({
    sessionContext: state.activeSession,
    canExport: Boolean(state.usuario && state.activeSession),
  });
}

function saveBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function handleDocumentDragOver(event) {
  event.preventDefault();
  if (!state.documentUploadInProgress) els.documentDropZone.classList.add("is-dragging");
}

function handleDocumentDragEnd(event) {
  event.preventDefault();
  els.documentDropZone.classList.remove("is-dragging");
}

function handleDocumentDrop(event) {
  event.preventDefault();
  if (state.documentUploadInProgress) return;
  els.documentDropZone.classList.remove("is-dragging");
  const selection = state.documentUploadQueue.addFiles(event.dataTransfer?.files || []);
  syncBulkDocumentMetadata();
  const message = selection.rejectedCapacity
    ? `Limite alcanzado: ${selection.rejectedCapacity} archivo(s) no se agregaron.`
    : `${selection.added} archivo(s) agregados para revision.`;
  setDocumentUploadStage(message, selection.rejectedCapacity ? "warning" : "info");
}

function handleBulkMetadataInput(event) {
  const input = event.target.closest("[data-bulk-field]");
  if (!input) return;
  state.documentUploadQueue.updateMetadata(
    input.dataset.bulkId,
    input.dataset.bulkField,
    input.value,
  );
  if (event.type === "input" && input.matches('input[type="text"], textarea')) return;
  if (input.dataset.bulkField === "processType") {
    state.documentUploadQueue.updateMetadata(
      input.dataset.bulkId,
      "subprocessId",
      "",
      { edited: false },
    );
  }
  reconcileBulkDocumentMetadata();
  state.documentUploadQueue.notify();
}

function syncBulkDocumentMetadata() {
  if (!state.documentUploadQueue || state.documentUploadQueue.isRunning()) return;
  const allItems = state.documentUploadQueue.getItems();
  const items = allItems
    .filter((item) => !["invalid", "success", "uploading"].includes(item.status));
  items.forEach((item) => {
    const localSuggestion = window.SIGDOCS_BULK_UPLOAD.suggestMetadataFromFilename(
      item.name,
      state.subprocesos,
      Object.keys(DOCUMENT_TYPE_OPTIONS),
    );
    if (!item.editedFields.documentCode) {
      state.documentUploadQueue.updateMetadata(
        item.id,
        "documentCode",
        localSuggestion.documentCode,
        { edited: false },
      );
    }
    if (!item.editedFields.documentName) {
      state.documentUploadQueue.updateMetadata(
        item.id,
        "documentName",
        localSuggestion.documentName,
        { edited: false },
      );
    }
    const defaults = {
      documentType: localSuggestion.documentType,
      processType: localSuggestion.processType,
      subprocessId: localSuggestion.subprocessId,
    };
    Object.entries(defaults).forEach(([field, value]) => {
      if (!item.editedFields[field] && value) {
        state.documentUploadQueue.updateMetadata(item.id, field, value, { edited: false });
      }
    });
  });
  reconcileBulkDocumentMetadata();
  state.documentUploadQueue.notify();
}

function reconcileBulkDocumentMetadata() {
  state.documentUploadQueue.getItems().forEach((item) => {
    if (["invalid", "success", "uploading", "cancelled", "error"].includes(item.status)) return;
    const message = window.SIGDOCS_BULK_UPLOAD.validateDocumentMetadata(
      item,
      state.subprocesos,
      Object.keys(DOCUMENT_TYPE_OPTIONS),
    );
    state.documentUploadQueue.setReady(item.id, !message, message);
  });
}

function hasCompleteDocumentMetadata(item) {
  return Boolean(
    item.documentCode.trim() && item.documentName.trim() && item.documentType
    && item.processType && item.subprocessId && item.version.trim() && item.effectiveDate,
  );
}

function renderBulkUploadQueue(
  items = state.documentUploadQueue?.getItems() || [],
  summary = state.documentUploadQueue?.getSummary() || {
    total: 0,
    review: 0,
    pending: 0,
    uploading: 0,
    success: 0,
    error: 0,
    cancelled: 0,
    invalid: 0,
    failed: 0,
    completed: 0,
  },
  running = state.documentUploadQueue?.isRunning() || false,
) {
  if (!els.bulkUploadPanel) return;
  els.bulkUploadPanel.classList.toggle("hidden", summary.total === 0);
  els.bulkCommonControls.classList.toggle("hidden", summary.total < 2);
  els.bulkUploadList.dataset.count = String(summary.total);
  els.bulkSelectionCounter.textContent = `${summary.total} de ${MAX_DOCUMENT_BATCH_FILES} archivos seleccionados`;
  els.bulkUploadProgress.max = Math.max(1, summary.total);
  els.bulkUploadProgress.value = summary.completed;
  els.bulkUploadProgress.textContent = `${summary.completed} de ${summary.total}`;
  els.bulkUploadProgressLabel.textContent = `${summary.completed} de ${summary.total}`;
  els.bulkUploadSummary.textContent = summary.total
    ? `${summary.total} archivo(s): ${summary.pending} listos, ${summary.review} por revisar, ${summary.success} correctos, ${summary.error} fallidos y ${summary.cancelled} cancelados.`
    : "Sin archivos seleccionados.";

  els.retryFailedUploadsButton.classList.toggle("hidden", summary.error === 0);
  els.stopBulkUploadButton.classList.toggle("hidden", !running);
  els.clearCompletedUploadsButton.classList.toggle(
    "hidden", summary.success + summary.cancelled === 0,
  );
  els.undoAiSuggestionsButton.classList.toggle(
    "hidden", !items.some((item) => item.aiBackup),
  );
  els.retryFailedUploadsButton.disabled = running || state.documentUploadInProgress;
  els.aiSuggestButton.disabled = !AI_CLASSIFICATION_UI_ENABLED
    || running
    || state.documentUploadInProgress
    || !summary.total
    || state.aiClassificationController !== null;
  els.refreshBulkCatalogsButton.disabled = running || state.documentUploadInProgress;
  els.applyCommonMetadataButton.disabled = running || state.documentUploadInProgress;
  els.documentFileInput.disabled = running || state.documentUploadInProgress || summary.total >= MAX_DOCUMENT_BATCH_FILES;
  els.documentSubmitButton.disabled =
    running || state.documentUploadInProgress || summary.pending === 0;

  els.bulkUploadList.innerHTML = items
    .map((item) => {
      const statusLabel = {
        review: "Revisar",
        pending: "Listo",
        uploading: "Cargando",
        success: "Correcto",
        error: "Fallido",
        cancelled: "Cancelado",
        invalid: "Invalido",
      }[item.status] || "Revisar";
      const fieldsDisabled = running
        || ["uploading", "success", "invalid"].includes(item.status);
      const canRemove = !running && item.status !== "success";
      const subprocessOptions = state.subprocesos
        .filter((subprocess) => subprocess.tipo_proceso === item.processType && subprocess.estado === "activo")
        .map((subprocess) => `<option value="${subprocess.id}" ${String(subprocess.id) === String(item.subprocessId) ? "selected" : ""}>${escapeHtml(subprocess.nombre_subproceso)}</option>`)
        .join("");
      return `
        <article class="bulk-upload-item" data-status="${escapeHtml(item.status)}">
          <div class="bulk-upload-file">
            <p title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
            <span>${formatFileSize(item.size)}</span>
            ${item.confidence ? `<span class="bulk-confidence" data-confidence="${escapeHtml(item.confidence)}">Confianza ${escapeHtml(item.confidence)}</span>` : ""}
          </div>
          <div class="bulk-upload-metadata-grid">
          <label class="bulk-upload-metadata">
            Codigo
            <input
              type="text"
              value="${escapeHtml(item.documentCode)}"
              data-bulk-id="${escapeHtml(item.id)}"
              data-bulk-field="documentCode"
              autocomplete="off"
              ${fieldsDisabled ? "disabled" : ""}
              required
            />
          </label>
          <label class="bulk-upload-metadata">
            Nombre
            <input
              type="text"
              value="${escapeHtml(item.documentName)}"
              data-bulk-id="${escapeHtml(item.id)}"
              data-bulk-field="documentName"
              autocomplete="off"
              ${fieldsDisabled ? "disabled" : ""}
              required
            />
          </label>
          <label class="bulk-upload-metadata">
            Tipo documental
            <select data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="documentType" autocomplete="off" ${fieldsDisabled ? "disabled" : ""}>
              ${renderDocumentTypeOptions(item.documentType, "Seleccionar")}
            </select>
          </label>
          <label class="bulk-upload-metadata">
            Proceso
            <select data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="processType" autocomplete="off" ${fieldsDisabled ? "disabled" : ""}>
              <option value="">Seleccionar</option>
              ${PROCESS_TYPES.map((process) => `<option value="${process}" ${item.processType === process ? "selected" : ""}>${process}</option>`).join("")}
            </select>
          </label>
          <label class="bulk-upload-metadata">
            Subproceso
            <select data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="subprocessId" autocomplete="off" ${fieldsDisabled ? "disabled" : ""}>
              <option value="">${subprocessOptions ? "Seleccionar" : "No hay subprocesos"}</option>
              ${subprocessOptions}
            </select>
          </label>
          <label class="bulk-upload-metadata">
            Version
            <input type="text" value="${escapeHtml(item.version)}" data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="version" autocomplete="off" ${fieldsDisabled ? "disabled" : ""} />
          </label>
          <label class="bulk-upload-metadata">
            Fecha de vigencia
            <input type="date" value="${escapeHtml(item.effectiveDate)}" data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="effectiveDate" autocomplete="off" ${fieldsDisabled ? "disabled" : ""} />
          </label>
          <label class="bulk-upload-metadata">
            Fecha de revisión
            <input type="date" value="${escapeHtml(item.reviewDate)}" data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="reviewDate" autocomplete="off" ${fieldsDisabled ? "disabled" : ""} />
          </label>
          <label class="bulk-upload-metadata bulk-upload-observations">
            Observaciones
            <textarea rows="2" maxlength="1000" data-bulk-id="${escapeHtml(item.id)}" data-bulk-field="observations" autocomplete="off" placeholder="Opcional" ${fieldsDisabled ? "disabled" : ""}>${escapeHtml(item.observations)}</textarea>
          </label>
          </div>
          <div class="bulk-upload-state">
            <div class="bulk-upload-status-row">
              <span class="bulk-upload-status">${statusLabel}</span>
              <span>${escapeHtml(item.stage)}</span>
            </div>
          </div>
          <div class="bulk-upload-actions">
            ${item.status === "error" ? `
              <button
                class="mini-button"
                type="button"
                data-action="retry-bulk-file"
                data-id="${escapeHtml(item.id)}"
              >Reintentar</button>
            ` : ""}
            ${["pending", "uploading"].includes(item.status) ? `
              <button class="mini-button" type="button" data-action="cancel-bulk-file" data-id="${escapeHtml(item.id)}">Cancelar</button>
            ` : ""}
            <button
              class="mini-button bulk-remove-button"
              type="button"
              data-action="remove-bulk-file"
              data-id="${escapeHtml(item.id)}"
              ${canRemove ? "" : "disabled"}
            >Retirar</button>
          </div>
          ${item.error ? `<p class="bulk-upload-error">${escapeHtml(item.error)}</p>` : ""}
        </article>
      `;
    })
    .join("");
}

function validateDocumentForm() {
  setOperationStatus(els.documentUploadStatus, "Validando informacion...");
  els.documentFileInput.setCustomValidity("");

  const items = state.documentUploadQueue.getItems();
  if (!items.length) {
    els.documentFileInput.setCustomValidity("Selecciona uno o varios archivos.");
    els.documentForm.reportValidity();
    els.documentFileInput.focus();
    return false;
  }

  const pendingItems = items.filter((item) => item.status === "pending");
  if (!pendingItems.length) {
    setDocumentUploadStage(
      "No hay archivos listos. Completa la revision o reintenta los fallidos.",
      "warning",
    );
    return false;
  }
  if (pendingItems.some((item) => !hasCompleteDocumentMetadata(item))) {
    setDocumentUploadStage(
      "Cada archivo debe tener todos sus metadatos revisados.",
      "error",
    );
    return false;
  }

  return true;
}

function getDocumentFileValidationError(file) {
  if (!ALLOWED_DOCUMENT_EXTENSIONS.includes(getFileExtension(file?.name))) {
    return "El formato no esta permitido. Usa PDF, Word, Excel, PowerPoint, CSV, TXT, PNG o JPG.";
  }
  if (!Number(file?.size)) return "El archivo seleccionado esta vacio.";
  if (Number(file?.size) > MAX_DOCUMENT_UPLOAD_MB * 1024 * 1024) {
    return `El archivo supera el maximo de ${MAX_DOCUMENT_UPLOAD_MB} MB.`;
  }
  return "";
}

async function uploadQueuedDocument(item, sessionContext, updateStage, uploadSignal) {
  const formData = new FormData();
  formData.append("codigo", item.documentCode.trim());
  formData.append("nombre", item.documentName.trim());
  formData.append("version", item.version.trim());
  formData.append("fecha_vigencia", item.effectiveDate);
  if (item.reviewDate) formData.append("fecha_revision", item.reviewDate);
  formData.append("tipo_documental", item.documentType);
  formData.append("tipo_proceso", item.processType);
  formData.append("subproceso_id", item.subprocessId);
  if (item.observations.trim()) formData.append("observaciones", item.observations.trim());
  formData.append("archivo", item.file, item.name);
  updateStage("Enviando al almacenamiento privado");
  try {
    await apiFetch("/documentos", {
      method: "POST",
      body: formData,
      sessionContext,
      signal: uploadSignal,
    });
    updateStage("Confirmando metadatos");
  } catch (error) {
    if (isSessionTransitionError(error)) throw error;
    throw new Error(getDocumentOperationError(error, "upload"));
  }
}

async function finalizeDocumentBatch(sessionContext) {
  const summary = state.documentUploadQueue.getSummary();
  let refreshFailed = false;
  if (summary.success > 0) {
    try {
      await Promise.all([
        refreshActiveDocumentQuery(sessionContext),
        refreshDocumentSummary(sessionContext, { silent: true }),
      ]);
    } catch (error) {
      if (isSessionTransitionError(error)) throw error;
      refreshFailed = true;
    }
  }

  const message = `${summary.success} correctos, ${summary.error} fallidos y ${summary.cancelled} cancelados de ${summary.total} archivos.`;
  const tone = summary.error === 0 ? "success" : summary.success > 0 ? "warning" : "error";
  const finalMessage = refreshFailed
    ? `${message} El listado no pudo actualizarse; usa Actualizar datos.`
    : message;
  setDocumentUploadStage(finalMessage, refreshFailed ? "warning" : tone);
  showToast(finalMessage, refreshFailed ? "warning" : tone, 6500);
  announceOperation(finalMessage);
}

function applyCommonMetadataToBatch() {
  if (state.documentUploadQueue.isRunning()
    || state.documentUploadQueue.getSummary().total < 2) return;
  const values = {
    documentType: els.bulkCommonDocumentType.value,
    processType: els.documentProcessSelect.value,
    subprocessId: els.documentSubprocessSelect.value,
    version: els.bulkCommonVersion.value.trim(),
    effectiveDate: els.bulkCommonEffectiveDate.value,
    reviewDate: els.bulkCommonReviewDate.value,
    observations: els.bulkCommonObservations.value.trim(),
  };
  state.documentUploadQueue.getItems().forEach((item) => {
    if (["success", "uploading", "invalid"].includes(item.status)) return;
    Object.entries(values).forEach(([field, value]) => {
      if (value) state.documentUploadQueue.updateMetadata(item.id, field, value);
    });
    if (values.processType) {
      state.documentUploadQueue.updateMetadata(
        item.id,
        "subprocessId",
        values.subprocessId || "",
      );
    }
  });
  reconcileBulkDocumentMetadata();
  state.documentUploadQueue.notify();
  setDocumentUploadStage("Datos comunes aplicados. Revisa cada documento antes de cargar.");
}

async function handleAiClassification() {
  if (!AI_CLASSIFICATION_UI_ENABLED
    || !isAdminUser()
    || state.aiClassificationController
    || state.documentUploadQueue.isRunning()) return;
  const candidates = state.documentUploadQueue.getItems().filter(
    (item) => !["invalid", "success", "uploading"].includes(item.status),
  );
  if (!candidates.length) return;
  const sessionContext = state.activeSession;
  state.aiClassificationController = new AbortController();
  state.documentUploadQueue.notify();
  setDocumentUploadStage("Solicitando sugerencias. Los archivos no se enviaran a la IA...");
  try {
    const response = await apiFetch("/documentos/clasificacion/sugerir", {
      method: "POST",
      body: JSON.stringify({
        documentos: candidates.map((item) => ({
          referencia: item.id,
          nombre_archivo: item.name,
        })),
      }),
      sessionContext,
      signal: state.aiClassificationController.signal,
    });
    state.documentUploadQueue.applyAiSuggestions(response.sugerencias || []);
    reconcileBulkDocumentMetadata();
    state.documentUploadQueue.notify();
    setDocumentUploadStage(
      "Sugerencias aplicadas. Confirma cada dato antes de iniciar la carga.",
      "success",
    );
  } catch (error) {
    if (isSessionTransitionError(error)) return;
    setDocumentUploadStage(
      getAiClassificationError(error),
      "warning",
    );
  } finally {
    if (state.sessionLifecycle.isCurrent(sessionContext)) {
      state.aiClassificationController = null;
      state.documentUploadQueue.notify();
    }
  }
}

function getAiClassificationError(error) {
  if (Number(error?.status || 0) === 429) {
    return "La clasificacion esta temporalmente limitada. Intenta mas tarde o continua manualmente.";
  }
  return "No fue posible generar sugerencias con IA. Puedes continuar manualmente.";
}

function undoAiClassifications() {
  const restored = state.documentUploadQueue.undoAiSuggestions();
  reconcileBulkDocumentMetadata();
  state.documentUploadQueue.notify();
  setDocumentUploadStage(`${restored} sugerencia(s) de IA deshechas.`);
}

async function refreshBulkCatalogs() {
  const sessionContext = state.activeSession;
  try {
    await refreshSubprocesses(sessionContext);
    reconcileBulkDocumentMetadata();
    state.documentUploadQueue.notify();
    setDocumentUploadStage("Catalogos actualizados sin borrar la cola.", "success");
  } catch (error) {
    if (!isSessionTransitionError(error)) setDocumentUploadStage(error.message, "error");
  }
}

function stopDocumentBatch() {
  state.documentUploadQueue.stop();
  setDocumentUploadStage("Carga detenida. Los archivos ya confirmados se conservan.", "warning");
}

function clearCompletedDocumentUploads() {
  if (state.documentUploadQueue.clearCompleted()) {
    syncBulkDocumentMetadata();
    setDocumentUploadStage("Archivos completados y cancelados retirados de la cola.");
  }
}

function getFilenameStem(filename) {
  const text = String(filename || "Documento");
  const extension = getFileExtension(text);
  return (extension ? text.slice(0, -extension.length) : text).trim() || "Documento";
}

function getDocumentTypeLabel(value) {
  return DOCUMENT_TYPE_OPTIONS[value] || "Sin clasificar";
}

function renderDocumentTypeOptions(selectedValue = "", placeholder = "Seleccionar") {
  return [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...Object.entries(DOCUMENT_TYPE_OPTIONS).map(
      ([value, label]) => `<option value="${value}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(label)}</option>`,
    ),
  ].join("");
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function setDocumentUploadBusy(isBusy, initialStatus = "") {
  els.documentForm.setAttribute("aria-busy", String(isBusy));
  els.documentForm.querySelectorAll("input, select, textarea").forEach((field) => {
    field.disabled = isBusy;
  });
  setButtonBusy(els.documentSubmitButton, isBusy, "Cargando documentos...");
  if (initialStatus) setDocumentUploadStage(initialStatus);
}

function setDocumentUploadStage(message, tone = "info") {
  setOperationStatus(els.documentUploadStatus, message, tone);
}

function setOperationStatus(element, message, tone = "info") {
  if (!element) return;
  element.textContent = message;
  if (message) {
    element.dataset.tone = tone;
  } else {
    delete element.dataset.tone;
  }
}

function setButtonBusy(button, isBusy, loadingLabel = "Procesando...") {
  if (!button) return;

  if (isBusy) {
    if (!button.dataset.idleLabel) {
      button.dataset.idleLabel = button.textContent.trim();
    }
    const spinner = document.createElement("span");
    spinner.className = "button-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = loadingLabel;
    button.replaceChildren(spinner, label);
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    return;
  }

  const idleLabel = button.dataset.idleLabel;
  if (idleLabel) button.textContent = idleLabel;
  delete button.dataset.idleLabel;
  button.disabled = false;
  button.classList.remove("is-loading");
  button.setAttribute("aria-busy", "false");
}

function announceOperation(message) {
  if (!els.operationAnnouncements) return;
  els.operationAnnouncements.textContent = "";
  window.requestAnimationFrame(() => {
    els.operationAnnouncements.textContent = message;
  });
}

function getDocumentOperationError(error, operation) {
  const status = Number(error?.status || 0);
  const isUpload = operation === "upload";

  if (error?.kind === "network") {
    return "No hay conexion con el backend. Revisa tu red e intenta nuevamente.";
  }
  if (error?.kind === "backend-unavailable" || status === 503 || status === 504) {
    return PUBLIC_BACKEND_UNAVAILABLE_MESSAGE;
  }
  if (status === 401) {
    return "Tu sesion vencio. Inicia sesion nuevamente para continuar.";
  }
  if (status === 403) {
    return isUpload
      ? "No tienes permiso para cargar documentos."
      : "No tienes permiso para descargar este documento.";
  }
  if (status === 404 && !isUpload) {
    return "El documento no existe o ya no esta disponible.";
  }
  if (status === 409 && isUpload) {
    return "Ya existe un documento con ese codigo y version.";
  }
  if (status === 413 && isUpload) {
    return "El archivo supera el tamano maximo permitido.";
  }
  if (status === 502) {
    return isUpload
      ? "El almacenamiento no esta disponible temporalmente. Conservamos el formulario para que puedas reintentar."
      : "No fue posible generar la descarga temporal. Intenta nuevamente en unos minutos.";
  }
  if (status === 400 && isUpload) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("tipo de archivo") || message.includes("contenido del archivo")) {
      return "El formato o contenido del archivo no esta permitido.";
    }
    if (message.includes("vacio")) return "El archivo seleccionado esta vacio.";
    return error.message || "Revisa la informacion del documento e intenta nuevamente.";
  }
  if (status >= 500) {
    return isUpload
      ? "El servidor no pudo completar la carga. El formulario se conservo para un reintento manual."
      : "El servidor no pudo preparar la descarga. Intenta nuevamente.";
  }

  return isUpload
    ? "No fue posible cargar el documento. Revisa los datos e intenta nuevamente."
    : "No fue posible descargar el documento. Intenta nuevamente.";
}

function isValidLogoFile(file) {
  const extension = getFileExtension(file.name);
  if (
    !ALLOWED_LOGO_EXTENSIONS.includes(extension) ||
    (file.type && !ALLOWED_LOGO_MIME_TYPES.includes(file.type.toLowerCase()))
  ) {
    showToast("El archivo debe ser una imagen PNG, JPG o JPEG.", "error");
    return false;
  }
  if (file.size > MAX_LOGO_MB * 1024 * 1024) {
    showToast("El logo supera el tamano maximo permitido de 2 MB.", "error");
    return false;
  }
  if (file.size === 0) {
    showToast("El archivo de logo esta vacio.", "error");
    return false;
  }
  return true;
}

function getBrandingOperationError(error) {
  const status = Number(error?.status || 0);
  if (error?.kind === "network") {
    return "No hay conexion con el backend. Revisa tu red e intenta nuevamente.";
  }
  if (error?.kind === "backend-unavailable" || status === 503 || status === 504) {
    return PUBLIC_BACKEND_UNAVAILABLE_MESSAGE;
  }
  if (status === 400) {
    return error.message || "El archivo debe ser una imagen PNG, JPG o JPEG valida.";
  }
  if (status === 413) return "El logo supera el tamano maximo permitido de 2 MB.";
  if (status === 502) {
    return "El almacenamiento no esta disponible temporalmente. Intenta nuevamente.";
  }
  if (status >= 500) {
    return "El servidor no pudo completar la actualizacion del logo.";
  }
  return error.message || "No fue posible actualizar la marca.";
}

function getPasswordValidationError(password) {
  const text = String(password || "");
  if (text.length < 8) return PASSWORD_REQUIREMENTS_MESSAGE;
  if (!/[A-Z]/.test(text)) return PASSWORD_REQUIREMENTS_MESSAGE;
  if (!/[a-z]/.test(text)) return PASSWORD_REQUIREMENTS_MESSAGE;
  if (!/[0-9]/.test(text)) return PASSWORD_REQUIREMENTS_MESSAGE;
  if (!/[^A-Za-z0-9]/.test(text)) return PASSWORD_REQUIREMENTS_MESSAGE;
  return "";
}

function getFileExtension(filename) {
  const dotIndex = String(filename || "").lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function isPersistableLogoSource(value) {
  const source = String(value || "").trim();
  if (!source || source.length > 500) return false;
  return Boolean(
    getSafeUrl(source, ["http:", "https:"]) ||
      source.startsWith("/uploads/") ||
      source.startsWith("uploads/"),
  );
}

function resolveLogoSource(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (source.startsWith("blob:") && source === state.runtimeLogoSource) return source;
  const remoteUrl = getSafeUrl(source, ["http:", "https:"]);
  if (remoteUrl) return remoteUrl;
  if (source.startsWith("/uploads/")) return `${API_BASE_URL}${source}`;
  if (source.startsWith("uploads/")) return `${API_BASE_URL}/${source}`;
  return "";
}

function getSafeUrl(value, allowedProtocols) {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u001F\u007F]/.test(source)) return "";

  try {
    const parsed = new URL(source);
    if (
      !allowedProtocols.includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }
    return parsed.href;
  } catch (_) {
    return "";
  }
}

async function apiFetch(path, options = {}) {
  const sessionContext = options.sessionContext || state.activeSession;
  const response = await requestSessionApi(path, {
    ...options,
    sessionContext,
  });

  if (!response.ok) {
    const error = await parseError(response);
    state.sessionLifecycle.assertCurrent(sessionContext);
    throw error;
  }

  if (response.status === 204) return null;
  const payload = await response.json();
  state.sessionLifecycle.assertCurrent(sessionContext);
  return payload;
}

async function publicApiFetch(path, options = {}) {
  const response = await requestSessionApi(path, {
    ...options,
    skipAuth: true,
    detached: true,
  });
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return null;
  return response.json();
}

async function requestSessionApi(path, options = {}) {
  const {
    skipAuth = false,
    sessionContext = state.activeSession,
    detached = false,
    retryCsrf = true,
    signal: requestSignal = null,
    headers: configuredHeaders,
    ...requestOptions
  } = options;
  if (!detached) state.sessionLifecycle.assertCurrent(sessionContext);

  const executeRequest = async () => {
    let authentication;
    try {
      authentication = authClient.prepareRequest({
        method: requestOptions.method,
        skipAuth,
      });
    } catch (error) {
      if (error?.silent) {
        throw new window.SIGDOCS_SESSION_LIFECYCLE.SessionTransitionError();
      }
      throw error;
    }

    const headers = new Headers(configuredHeaders || {});
    Object.entries(authentication.headers).forEach(([name, value]) => {
      headers.set(name, value);
    });
    if (!(requestOptions.body instanceof FormData) && requestOptions.body) {
      headers.set("Content-Type", "application/json");
    }

    return requestApi(buildApiUrl(path), {
      ...requestOptions,
      headers,
      ...(authentication.credentials
        ? { credentials: authentication.credentials }
        : {}),
      ...(requestSignal || !detached
        ? { signal: combineAbortSignals(requestSignal, detached ? null : sessionContext.signal) }
        : {}),
    });
  };

  let response = await executeRequest();
  if (
    authClient.isCookie &&
    !skipAuth &&
    retryCsrf &&
    (await responseIsCsrfRejection(response))
  ) {
    const csrf = await apiFetch("/auth/session/csrf", {
      sessionContext,
      retryCsrf: false,
    });
    authClient.captureCsrf(csrf);
    response = await executeRequest();
  }

  if (response.status === 401 && !skipAuth && !detached) {
    const error = await parseError(response);
    state.sessionLifecycle.assertCurrent(sessionContext);
    const hadAuthenticatedSession = authClient.hasConfirmedAuthentication();
    clearStoredToken();
    if (state.sessionLifecycle.fail(sessionContext)) {
      els.loginError.textContent = hadAuthenticatedSession ? error.message : "";
    }
    throw new window.SIGDOCS_SESSION_LIFECYCLE.SessionTransitionError();
  }

  if (!detached) state.sessionLifecycle.assertCurrent(sessionContext);
  return response;
}

function combineAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length <= 1) return activeSignals[0] || null;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  activeSignals.forEach((signal) => {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return controller.signal;
}

async function responseIsCsrfRejection(response) {
  if (response.status !== 403) return false;
  try {
    const payload = await response.clone().json();
    const detail = Array.isArray(payload.detail)
      ? payload.detail.map((item) => item.msg).join(", ")
      : payload.detail;
    return window.SIGDOCS_AUTH.isCsrfRejection(response.status, detail);
  } catch (_) {
    return false;
  }
}

async function parseError(response) {
  let message = "Ocurrio un error";
  try {
    const data = await response.json();
    if (Array.isArray(data.detail)) {
      message = data.detail.map((item) => item.msg).join(", ");
    } else if (data.detail && typeof data.detail === "object") {
      message = data.detail.message || message;
    } else if (data.detail) {
      message = data.detail;
    }
    const parsedCode = data.detail && typeof data.detail === "object"
      ? data.detail.code
      : null;
    const parsedEntityId = data.detail && typeof data.detail === "object"
      ? data.detail.subproceso_id
      : null;
    const parsedError = new Error(friendlyErrorMessage(message, response.status));
    parsedError.status = response.status;
    parsedError.code = parsedCode;
    parsedError.entityId = parsedEntityId;
    return parsedError;
  } catch (_) {
    message = response.statusText || message;
  }
  const error = new Error(friendlyErrorMessage(message, response.status));
  error.status = response.status;
  return error;
}

function friendlyErrorMessage(message, status = 0) {
  const text = String(message || "");
  const normalized = text.toLowerCase();

  if (status === 401) {
    return normalized.includes("credenciales")
      ? "Email o contrasena incorrectos."
      : "Tu sesion vencio. Inicia sesion nuevamente.";
  }
  if (status === 403 && normalized.includes("csrf")) {
    return "No fue posible validar la proteccion de tu sesion. Intenta nuevamente.";
  }
  if (status === 403) return "No tienes permiso para realizar esta accion.";
  if (status === 413) return "El archivo supera el tamano maximo permitido.";
  if (status === 502) return "Un servicio de archivos no esta disponible temporalmente.";
  if (status === 503 || status === 504) {
    return isRemoteBackend()
      ? PUBLIC_BACKEND_UNAVAILABLE_MESSAGE
      : "El backend no esta disponible temporalmente. Intenta nuevamente.";
  }
  if (status >= 500) {
    return "El servidor no pudo completar la solicitud. Intenta nuevamente.";
  }
  if (status === 422) return "Revisa los datos enviados e intenta nuevamente.";
  if (text.includes("String should have at most")) {
    return "El dato enviado es demasiado largo. Si es un logo local, subelo como archivo.";
  }
  if (normalized.includes("request entity too large")) {
    return "El archivo supera el tamano maximo permitido.";
  }
  if (/traceback|database_url|secret_key|sqlalchemy|psycopg|\/app\/|\\app\\/i.test(text)) {
    return "No fue posible completar la solicitud. Intenta nuevamente.";
  }
  return text;
}

function statusBadge(status) {
  const safeStatus = Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)
    ? status
    : "desconocido";
  const label = STATUS_LABELS[safeStatus] || "Sin estado";
  return `<span class="status-badge status-${safeStatus}">${escapeHtml(label)}</span>`;
}

function emptyRow(colspan, message) {
  return `<tr class="table-empty-row"><td colspan="${colspan}">${escapeHtml(message)}</td></tr>`;
}

function showToast(message, tone = "info", duration = tone === "error" ? 6000 : 3600) {
  if (!message) return;
  els.toast.textContent = message;
  els.toast.classList.remove("toast-success", "toast-error", "toast-warning", "toast-info");
  els.toast.classList.add(`toast-${tone}`);
  els.toast.setAttribute("role", tone === "error" ? "alert" : "status");
  els.toast.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    els.toast.classList.add("hidden");
  }, duration);
}

function getInitials(value) {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return DEFAULT_BRANDING.logoText;
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(`${value}T00:00:00`).toLocaleDateString("es-CO", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-CO", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDownloadFileName(disposition) {
  if (!disposition) return null;
  const match = disposition.match(/filename="?([^"]+)"?/i);
  return match ? match[1] : null;
}
