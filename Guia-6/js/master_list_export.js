(function attachMasterListExport(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SIGDOCS_MASTER_LIST_EXPORT = api;
})(typeof window !== "undefined" ? window : globalThis, function createApi() {
  function createMasterListExporter({
    request,
    assertCurrent,
    isSessionTransitionError,
    resolveFilename,
    saveBlob,
    setBusy,
    notify,
  }) {
    let activeOperation = null;

    async function exportMasterList({ sessionContext, canExport }) {
      if (!canExport || activeOperation) return false;

      const operation = { sessionContext };
      activeOperation = operation;
      setBusy(true, "Generando Excel...");

      try {
        const response = await request(sessionContext);
        const blob = await response.blob();
        assertCurrent(sessionContext);
        const filename = resolveFilename(response) || "Listado_Maestro_SIGDocs.xlsx";
        saveBlob(blob, filename);
        notify("Listado maestro descargado correctamente.", "success");
        return true;
      } catch (error) {
        if (isSessionTransitionError(error)) return false;
        notify("No fue posible generar el listado maestro.", "error");
        return false;
      } finally {
        if (activeOperation === operation) {
          activeOperation = null;
          setBusy(false);
        }
      }
    }

    function reset() {
      if (!activeOperation) return;
      activeOperation = null;
      setBusy(false);
    }

    return {
      exportMasterList,
      isRunning: () => activeOperation !== null,
      reset,
    };
  }

  return { createMasterListExporter };
});
