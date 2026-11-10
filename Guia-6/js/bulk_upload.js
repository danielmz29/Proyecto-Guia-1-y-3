(function initializeBulkUpload(globalScope) {
  const UPLOAD_STATUS = Object.freeze({
    review: "review", pending: "pending", uploading: "uploading",
    success: "success", error: "error", cancelled: "cancelled", invalid: "invalid",
  });
  const EDITABLE_FIELDS = new Set([
    "documentCode", "documentName", "documentType", "processType",
    "subprocessId", "version", "effectiveDate", "reviewDate", "observations",
  ]);
  const PROCESS_TYPES = new Set(["Estrategico", "Misional", "Apoyo"]);

  function createBulkUploadQueue({
    validateFile = () => "", onChange = () => {}, idFactory = createIdFactory(),
    maxFiles = 50, AbortControllerClass = globalScope.AbortController,
  } = {}) {
    let items = [];
    let running = false;
    let generation = 0;
    const activeControllers = new Map();

    function addFiles(files) {
      if (running) return emptySelectionResult();
      const candidates = Array.from(files || []);
      const selected = candidates.slice(0, Math.max(0, maxFiles - items.length));
      const duplicateKeys = new Set(items.map(fileKey));
      const result = { added: 0, accepted: 0, duplicates: 0, invalid: 0,
        rejectedCapacity: candidates.length - selected.length };
      selected.forEach((file) => {
        const key = fileKey({ file, name: file?.name, size: file?.size });
        const duplicate = duplicateKeys.has(key);
        duplicateKeys.add(key);
        const validationError = duplicate
          ? "Este archivo ya esta en la cola."
          : String(validateFile(file) || "");
        result.added += 1;
        if (duplicate) result.duplicates += 1;
        if (validationError) result.invalid += 1;
        else result.accepted += 1;
        items.push(createItem(file, validationError));
      });
      notify();
      return result;
    }

    function replaceFiles(files) {
      if (running) return emptySelectionResult();
      clear();
      return addFiles(files);
    }

    function createItem(file, validationError) {
      return {
        id: idFactory(), file, name: String(file?.name || "Archivo sin nombre"),
        size: Number(file?.size || 0),
        status: validationError ? UPLOAD_STATUS.invalid : UPLOAD_STATUS.review,
        stage: validationError ? "Requiere correccion" : "Listo para revisar",
        error: validationError, documentCode: "", documentName: "",
        documentType: "", processType: "", subprocessId: "", version: "",
        effectiveDate: "", reviewDate: "", observations: "", confidence: "", suggestionSource: "local",
        requiresReview: true, editedFields: {}, aiBackup: null,
      };
    }

    function remove(itemId) {
      if (running) return false;
      const item = findItem(itemId);
      if (!item || item.status === UPLOAD_STATUS.success) return false;
      items = items.filter((candidate) => candidate.id !== itemId);
      notify();
      return true;
    }

    function updateMetadata(itemId, field, value, { edited = true } = {}) {
      if (!EDITABLE_FIELDS.has(field)) return false;
      const item = findItem(itemId);
      if (!item || [UPLOAD_STATUS.uploading, UPLOAD_STATUS.success].includes(item.status)) return false;
      item[field] = String(value ?? "");
      if (edited) item.editedFields[field] = true;
      item.requiresReview = true;
      if (![UPLOAD_STATUS.invalid, UPLOAD_STATUS.error].includes(item.status)) {
        item.status = UPLOAD_STATUS.review;
      }
      return true;
    }

    function setReady(itemId, ready, message = "") {
      const item = findItem(itemId);
      if (!item || [UPLOAD_STATUS.uploading, UPLOAD_STATUS.success].includes(item.status)) return false;
      if (item.status === UPLOAD_STATUS.invalid && item.error) return false;
      item.status = ready ? UPLOAD_STATUS.pending : UPLOAD_STATUS.review;
      item.requiresReview = !ready;
      item.error = message;
      item.stage = ready ? "Preparado para cargar" : "Requiere revision";
      return true;
    }

    function applyAiSuggestions(suggestions) {
      const byReference = new Map(Array.from(suggestions || []).map(
        (item) => [String(item.referencia), item],
      ));
      let applied = 0;
      items.forEach((item) => {
        const suggestion = byReference.get(item.id);
        if (!suggestion || [UPLOAD_STATUS.uploading, UPLOAD_STATUS.success].includes(item.status)) return;
        if (!item.aiBackup) item.aiBackup = snapshotMetadata(item);
        const values = {
          documentCode: suggestion.codigo_sugerido,
          documentName: suggestion.nombre_sugerido,
          documentType: suggestion.tipo_documental_id,
          processType: suggestion.tipo_proceso,
          subprocessId: suggestion.subproceso_id,
          version: suggestion.version_sugerida,
        };
        Object.entries(values).forEach(([field, value]) => {
          if (value !== null && value !== undefined && !item.editedFields[field]) item[field] = String(value);
        });
        item.confidence = String(suggestion.confianza || "baja");
        item.suggestionSource = "ai";
        item.requiresReview = true;
        if (![UPLOAD_STATUS.invalid, UPLOAD_STATUS.error].includes(item.status)) {
          item.status = UPLOAD_STATUS.review;
        }
        applied += 1;
      });
      notify();
      return applied;
    }

    function undoAiSuggestions() {
      let restored = 0;
      items.forEach((item) => {
        if (!item.aiBackup || [UPLOAD_STATUS.uploading, UPLOAD_STATUS.success].includes(item.status)) return;
        Object.assign(item, item.aiBackup, { aiBackup: null, requiresReview: true });
        if (![UPLOAD_STATUS.invalid, UPLOAD_STATUS.error].includes(item.status)) {
          item.status = UPLOAD_STATUS.review;
        }
        restored += 1;
      });
      notify();
      return restored;
    }

    async function run(uploadFile, { concurrency = 3, targetIds = null } = {}) {
      if (running) return { started: false, summary: getSummary() };
      if (typeof uploadFile !== "function") throw new TypeError("uploadFile es obligatorio");
      const targetSet = targetIds ? new Set(targetIds) : null;
      const targets = items.filter((item) => item.status === UPLOAD_STATUS.pending
        && (!targetSet || targetSet.has(item.id)));
      if (!targets.length) return { started: false, summary: getSummary() };
      running = true;
      const runGeneration = generation;
      let cursor = 0;
      notify();

      async function worker() {
        while (runGeneration === generation) {
          const item = targets[cursor++];
          if (!item) return;
          if (item.status !== UPLOAD_STATUS.pending) continue;
          const controller = AbortControllerClass ? new AbortControllerClass() : null;
          if (controller) activeControllers.set(item.id, controller);
          item.status = UPLOAD_STATUS.uploading;
          item.stage = "Subiendo archivo";
          item.error = "";
          notify();
          try {
            await uploadFile(item, updateStage(item, runGeneration), controller?.signal);
            if (runGeneration !== generation) return;
            if (item.status !== UPLOAD_STATUS.cancelled) {
              item.status = UPLOAD_STATUS.success;
              item.stage = "Carga completada";
            }
          } catch (error) {
            if (runGeneration !== generation) return;
            if (item.status === UPLOAD_STATUS.cancelled || controller?.signal.aborted) {
              item.status = UPLOAD_STATUS.cancelled;
              item.stage = "Carga cancelada";
              item.error = "";
            } else {
              item.status = UPLOAD_STATUS.error;
              item.stage = "Carga fallida";
              item.error = String(error?.message || "No fue posible cargar el archivo.");
            }
          } finally {
            activeControllers.delete(item.id);
          }
          notify();
        }
      }
      const workerCount = Math.max(1, Math.min(3, Number(concurrency) || 3));
      await Promise.all(Array.from({ length: Math.min(workerCount, targets.length) }, worker));
      if (runGeneration === generation) {
        running = false;
        notify();
      }
      return { started: true, summary: getSummary() };
    }

    function updateStage(item, runGeneration) {
      return (stage) => {
        if (runGeneration !== generation || item.status !== UPLOAD_STATUS.uploading) return;
        item.stage = String(stage || "Procesando");
        notify();
      };
    }

    function cancel(itemId) {
      const item = findItem(itemId);
      if (!item || [UPLOAD_STATUS.success, UPLOAD_STATUS.cancelled].includes(item.status)) return false;
      activeControllers.get(itemId)?.abort();
      item.status = UPLOAD_STATUS.cancelled;
      item.stage = "Carga cancelada";
      item.error = "";
      notify();
      return true;
    }

    function stop() {
      items.forEach((item) => {
        if ([UPLOAD_STATUS.pending, UPLOAD_STATUS.uploading].includes(item.status)) {
          activeControllers.get(item.id)?.abort();
          item.status = UPLOAD_STATUS.cancelled;
          item.stage = "Carga cancelada";
          item.error = "";
        }
      });
      notify();
    }

    async function retryFailed(uploadFile, options) {
      if (running) return { started: false, summary: getSummary() };
      const ids = items.filter((item) => item.status === UPLOAD_STATUS.error).map((item) => item.id);
      ids.forEach(resetForRetry);
      notify();
      return run(uploadFile, { ...options, targetIds: ids });
    }

    async function retryItem(itemId, uploadFile, options = {}) {
      if (running || !resetForRetry(itemId)) return { started: false, summary: getSummary() };
      notify();
      return run(uploadFile, { ...options, targetIds: [itemId] });
    }

    function resetForRetry(itemId) {
      const item = findItem(itemId);
      if (!item || item.status !== UPLOAD_STATUS.error) return false;
      item.status = UPLOAD_STATUS.pending;
      item.stage = "Preparado para reintentar";
      item.error = "";
      return true;
    }

    function clearCompleted() {
      if (running) return false;
      items = items.filter((item) => ![UPLOAD_STATUS.success, UPLOAD_STATUS.cancelled].includes(item.status));
      notify();
      return true;
    }

    function clear() {
      generation += 1;
      activeControllers.forEach((controller) => controller.abort());
      activeControllers.clear();
      running = false;
      items = [];
      notify();
    }

    function getSummary() {
      const summary = { total: 0, review: 0, pending: 0, uploading: 0,
        success: 0, error: 0, cancelled: 0, invalid: 0, failed: 0, completed: 0 };
      summary.total = items.length;
      items.forEach((item) => {
        if (Object.hasOwn(summary, item.status)) summary[item.status] += 1;
      });
      summary.failed = summary.error + summary.invalid;
      summary.completed = summary.success + summary.error + summary.cancelled + summary.invalid;
      return summary;
    }

    function notify() { onChange(getItems(), getSummary(), running); }
    function getItems() { return [...items]; }
    function findItem(itemId) { return items.find((candidate) => candidate.id === itemId); }

    return Object.freeze({
      addFiles, replaceFiles, remove, cancel, stop, updateMetadata, setReady,
      applyAiSuggestions, undoAiSuggestions, run, retryFailed, retryItem,
      clearCompleted, clear, notify, getItems, getSummary, isRunning: () => running,
    });
  }

  function snapshotMetadata(item) {
    const snapshot = {};
    EDITABLE_FIELDS.forEach((field) => { snapshot[field] = item[field]; });
    snapshot.confidence = item.confidence;
    snapshot.suggestionSource = item.suggestionSource;
    return snapshot;
  }

  function suggestMetadataFromFilename(
    filename,
    subprocesses = [],
    allowedDocumentTypes = [],
  ) {
    const stem = getFilenameStem(filename);
    const normalizedCode = stem.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    const codeMatch = normalizedCode.match(/^[A-Z]{1,8}(?:-[A-Z]{1,8})*-[0-9]{1,8}/);
    const code = (codeMatch?.[0] || normalizedCode || "DOC").slice(0, 72);
    const nameWithoutCode = codeMatch
      ? stem.replace(new RegExp(`^${escapeRegExp(codeMatch[0]).replace(/\\-/g, "[-_ ]")}[\\s_-]*`, "i"), "")
      : stem;
    const name = (nameWithoutCode || stem).replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase())
      || "Documento";
    const normalizedName = normalizeSuggestionText(stem);
    const words = normalizedName.split(" ").filter(Boolean);
    const documentType = Array.from(allowedDocumentTypes).find((value) => {
      const normalizedType = normalizeSuggestionText(value);
      const prefix = normalizedType.slice(0, Math.min(6, normalizedType.length));
      return prefix.length >= 4 && words.some((word) => word.startsWith(prefix));
    }) || "";
    const subprocess = Array.from(subprocesses).find((candidate) => {
      const normalizedSubprocess = normalizeSuggestionText(candidate.nombre_subproceso);
      return normalizedSubprocess.length >= 4 && normalizedName.includes(normalizedSubprocess);
    });
    return {
      documentCode: code,
      documentName: name,
      documentType,
      processType: subprocess?.tipo_proceso || "",
      subprocessId: subprocess?.id ? String(subprocess.id) : "",
    };
  }

  function validateDocumentMetadata(item, subprocesses = [], allowedDocumentTypes = []) {
    if (!item.processType || !PROCESS_TYPES.has(item.processType)) {
      return "Selecciona un proceso valido.";
    }
    const processSubprocesses = Array.from(subprocesses).filter(
      (candidate) => candidate.tipo_proceso === item.processType
        && candidate.estado !== "inactivo",
    );
    if (!processSubprocesses.length) {
      return "No hay subprocesos creados para este proceso.";
    }
    const subprocess = processSubprocesses.find(
      (candidate) => String(candidate.id) === String(item.subprocessId),
    );
    if (!subprocess) return "Selecciona un subproceso compatible con el proceso.";
    if (!String(item.documentCode || "").trim()
      || !String(item.documentName || "").trim()
      || !item.documentType
      || !String(item.version || "").trim()
      || !item.effectiveDate) {
      return "Completa codigo, nombre, tipo, proceso, subproceso, version y vigencia.";
    }
    if (!Array.from(allowedDocumentTypes).includes(item.documentType)) {
      return "Selecciona un tipo documental valido.";
    }
    if (item.reviewDate && item.reviewDate < item.effectiveDate) {
      return "La fecha de revision no puede ser anterior a la vigencia.";
    }
    return "";
  }

  function getFilenameStem(filename) {
    const value = String(filename || "Documento");
    const dotIndex = value.lastIndexOf(".");
    return (dotIndex > 0 ? value.slice(0, dotIndex) : value).trim() || "Documento";
  }

  function normalizeSuggestionText(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function fileKey(item) {
    const name = String(item.file?.name || item.name || "").trim().toLowerCase();
    const size = Number(item.file?.size ?? item.size ?? 0);
    return `${name}\u0000${size}`;
  }

  function emptySelectionResult() {
    return { added: 0, accepted: 0, duplicates: 0, invalid: 0, rejectedCapacity: 0 };
  }

  function createIdFactory() {
    let sequence = 0;
    return () => {
      sequence += 1;
      if (globalScope.crypto?.randomUUID) return globalScope.crypto.randomUUID();
      return `bulk-file-${sequence}`;
    };
  }

  const api = Object.freeze({
    UPLOAD_STATUS,
    createBulkUploadQueue,
    suggestMetadataFromFilename,
    validateDocumentMetadata,
  });
  globalScope.SIGDOCS_BULK_UPLOAD = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
