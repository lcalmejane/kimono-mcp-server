// Shared model-management boundary. Keep product copies identical.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KimonoModels = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function parse(input, confirmed = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid model action.");
    const operation = input.operation;
    const key = operation === "install" ? "model" : operation === "configure" ? "policy" : undefined;
    const allowed = operation === "install" ? ["code", "multilingual-fast"]
      : ["auto-balanced", "auto-speed", "code", "multilingual-fast", "e5"];
    if (!["status", "install", "configure"].includes(operation)
      || Object.keys(input).some(name => !["operation", ...(key ? [key, "confirmed"] : [])].includes(name))
      || key && !allowed.includes(input[key])
      || key && confirmed && input.confirmed !== true) throw new Error("Invalid or unconfirmed model action.");
    return { operation, ...(key ? { [key]: input[key], ...(confirmed ? { confirmed: true } : {}) } : {}) };
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
    if (action.operation === "configure") return (fr
      ? `Enregistrer la politique ${action.policy} sur le serveur connecté et programmer une reconstruction ? L'ancienne génération reste active jusqu'à réussite. Ceci affecte tous les utilisateurs du serveur partagé. Aucun téléchargement automatique.`
      : `Save policy ${action.policy} on the connected server and schedule a rebuild? The previous generation remains active until success. This affects all users of a shared server. No automatic download.`);
    throw new Error("Status needs no confirmation.");
  }
  return { parse, confirmation };
}));
