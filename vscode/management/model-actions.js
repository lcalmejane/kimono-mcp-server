// Shared model-management boundary. Keep product copies identical.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KimonoModels = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MODELS = ["code", "multilingual-fast", "e5", "jina-code", "bge-m3", "nomic-v1.5", "mxbai-large", "e5-large", "minilm"];
  const POLICIES = ["auto-speed", "auto-balanced", "code", "multilingual-fast", "e5", "custom"];
  function parse(input, confirmed = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid model action.");
    const operation = input.operation;
    const key = operation === "install" ? "model" : operation === "configure" ? "policy" : undefined;
    const allowed = operation === "install" ? MODELS.filter(id => id !== "e5") : POLICIES;
    // custom = { code, documents }: one catalogue model per content type, only with policy "custom".
    const custom = input.custom;
    const validCustom = custom === undefined || operation === "configure" && input.policy === "custom"
      && custom && typeof custom === "object" && !Array.isArray(custom) && Object.keys(custom).every(name => ["code", "documents"].includes(name))
      && MODELS.includes(custom.code) && MODELS.includes(custom.documents);
    if (!["status", "install", "configure"].includes(operation)
      || Object.keys(input).some(name => !["operation", ...(key ? [key, "confirmed"] : []), ...(operation === "configure" ? ["custom"] : [])].includes(name))
      || key && !allowed.includes(input[key]) || !validCustom
      || key && confirmed && input.confirmed !== true) throw new Error("Invalid or unconfirmed model action.");
    return { operation, ...(key ? { [key]: input[key], ...(custom ? { custom: { code: custom.code, documents: custom.documents } } : {}),
      ...(confirmed ? { confirmed: true } : {}) } : {}) };
  }
  function confirmation(input, status, language = "en") {
    const action = parse(input);
    const fr = String(language).startsWith("fr");
    if (action.operation === "install") {
      const model = status?.models?.find(item => item.id === action.model);
      if (!model || !Number.isFinite(model.downloadBytes) || !model.revision || !model.license || !model.repository) {
        throw new Error(fr ? "Métadonnées du modèle indisponibles. Actualisez l'état." : "Model metadata unavailable. Refresh status.");
      }
      return `${fr ? "Télécharger uniquement sur le serveur connecté" : "Download only on the connected server"}: ${model.id}\n`
        + `${model.downloadBytes} bytes (${Math.round(model.downloadBytes / 1048576)} MiB)\n`
        + `Source: ${model.repository}\nRevision: ${model.revision}\nLicense: ${model.license}\n`
        + (fr ? "Aucune activation, aucun envoi du corpus. Continuer ?" : "No activation, no corpus upload. Continue?");
    }
    const chosen = action.custom ? ` (code: ${action.custom.code}, documents: ${action.custom.documents})` : "";
    if (action.operation === "configure") return (fr
      ? `Enregistrer la politique ${action.policy}${chosen} sur le serveur connecté et programmer une reconstruction ? L'ancienne génération reste active jusqu'à réussite. Ceci affecte tous les utilisateurs du serveur partagé. Aucun téléchargement automatique.`
      : `Save policy ${action.policy}${chosen} on the connected server and schedule a rebuild? The previous generation remains active until success. This affects all users of a shared server. No automatic download.`);
    throw new Error("Status needs no confirmation.");
  }
  return { parse, confirmation, MODELS, POLICIES };
}));
