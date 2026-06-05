// @kynesyslabs/demosdk 4.x ships ESM with extension-less relative imports
// (e.g. `from "./token"`), which bundlers tolerate but plain Node ESM
// resolution rejects (ERR_UNSUPPORTED_DIR_IMPORT / ERR_MODULE_NOT_FOUND).
// This resolve hook retries those specifiers with ".js" / "/index.js"
// appended — scoped strictly to imports originating inside the SDK.
// Must be required BEFORE the first require of @kynesyslabs/demosdk.
const Module = require("module");

if (typeof Module.registerHooks !== "function") {
  throw new Error(
    "module.registerHooks is unavailable (need Node >= 22.15). " +
      "@kynesyslabs/demosdk 4.x cannot be loaded without it."
  );
}

Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const fromSdk = String(context?.parentURL || "").includes(
        "/@kynesyslabs/demosdk/"
      );
      const fixable =
        err?.code === "ERR_UNSUPPORTED_DIR_IMPORT" ||
        err?.code === "ERR_MODULE_NOT_FOUND";
      // Covers both relative ("./token") and bare deep imports
      // ("cosmjs-types/cosmos/tx/v1beta1/tx") written without extensions.
      if (fromSdk && fixable && !specifier.endsWith(".js")) {
        for (const suffix of ["/index.js", ".js"]) {
          try {
            return nextResolve(specifier + suffix, context);
          } catch (_) {
            // fall through to next suffix / original error
          }
        }
      }
      throw err;
    }
  },
});
