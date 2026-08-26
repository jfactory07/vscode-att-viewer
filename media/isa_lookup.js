// Architecture-aware ISA lookup using indexes built from AMD machine-readable XML.
(function () {
  /** @param {string} mnem @param {{isaKey?:string,archName?:string,instructions?:Object}} index */
  function lookup(mnem, index) {
    if (!index || !index.instructions) return null;
    const raw = String(mnem || "").trim().toLowerCase();
    if (!raw) return null;
    const ins = index.instructions;
    if (ins[raw]) {
      return { key: raw, isaKey: index.isaKey, archName: index.archName, source: index.source, ...ins[raw] };
    }
    const parts = raw.split("_");
    for (let n = parts.length; n > 0; n--) {
      const key = parts.slice(0, n).join("_");
      if (ins[key]) {
        return {
          key,
          isaKey: index.isaKey,
          archName: index.archName,
          source: index.source,
          matched: "prefix",
          ...ins[key],
        };
      }
    }
    return null;
  }

  window.ATT_ISA = { lookup };
})();
