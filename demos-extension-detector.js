console.log("🚀 Demos Extension Detector V2 loaded");

window.demosProviders = [];
console.log("🔍 Extension detector initialized, demosProviders array created");

// Check for common extension injection patterns
setTimeout(() => {
  console.log("🔍 Checking for extension injection patterns...");
  const commonPatterns = ["demos", "ethereum", "web3", "inject", "provider"];

  const foundPatterns = {};
  commonPatterns.forEach((pattern) => {
    const matches = Object.keys(window).filter((key) =>
      key.toLowerCase().includes(pattern)
    );
    if (matches.length > 0) {
      foundPatterns[pattern] = matches;
    }
  });

  console.log("📊 Found extension patterns:", foundPatterns);

  // Check for specific Demos-related objects
  if (window.demos) {
    console.log("✅ Found window.demos:", window.demos);
  }
  if (window.demosProvider) {
    console.log("✅ Found window.demosProvider:", window.demosProvider);
  }
  if (window.injectedProvider) {
    console.log("✅ Found window.injectedProvider:", window.injectedProvider);
  }
}, 1000);

// Enhanced validation with null checks
function validateProviderDetail(detail) {
  if (!detail) return false;
  const provider = detail.provider || detail;
  // Accept providers that expose any known interaction surface
  const hasSurface =
    provider &&
    (typeof provider.request === "function" ||
      typeof provider.send === "function" ||
      typeof provider.sendAsync === "function" ||
      typeof provider.connect === "function" ||
      typeof provider.enable === "function" ||
      typeof provider.accounts === "function" ||
      typeof provider.personal_sign === "function");
  if (!hasSurface) return false;
  // info is optional; we'll synthesize one if missing
  return true;
}

function handleAnnounce(e) {
  console.log("🎯 handleAnnounce called with event:", e);
  try {
    let detail = e.detail;
    console.log("🎯 Event detail:", detail);

    // Normalize various announce shapes
    if (!detail) {
      console.log("⚠️ Invalid announce event detail:", detail);
      return;
    }
    if (typeof detail !== "object") {
      console.log("⚠️ Invalid announce event detail:", detail);
      return;
    }

    // If the event provided the provider directly, wrap it
    if (
      !detail.provider &&
      (detail.request || detail.send || detail.connect || detail.enable)
    ) {
      detail = { provider: detail, info: { name: "Demos Provider" } };
    }
    if (!detail.info) detail.info = { name: "Demos Provider" };

    // Additional validation to prevent duplicate or malformed providers
    if (!validateProviderDetail(detail)) {
      console.log("⚠️ Provider detail validation failed:", detail);
      return;
    }

    const exists = window.demosProviders.find(
      (p) =>
        (p.info?.uuid &&
          detail.info?.uuid &&
          p.info.uuid === detail.info.uuid) ||
        p.provider === detail.provider
    );

    if (!exists) {
      console.log(
        "✅ Demos provider announced:",
        detail.info?.name || "Unknown Provider"
      );
      window.demosProviders.push(detail);
    } else {
      console.log(
        "ℹ️ Provider already exists:",
        detail.info?.name || "Unknown Provider"
      );
    }
  } catch (error) {
    console.error("❌ Error in handleAnnounce:", error);
  }
}

// Safe provider request wrapper with enhanced error handling
window.safeProviderRequest = async function (provider, method, params = []) {
  if (!provider || typeof provider.request !== "function") {
    throw new Error("Invalid provider");
  }
  if (!Array.isArray(params)) params = [params];
  return provider.request({ method, params });
};

// Enhanced detection with timing controls
window.requestDemosProviders = function () {
  console.log("📤 Requesting Demos providers...");

  // Clear existing providers to avoid stale entries
  window.demosProviders = [];

  // Multiple possible request event names
  const requestEventNames = [
    "demosRequestProvider",
    "ethereumRequestProvider",
    "web3RequestProvider",
    "providerRequest",
    "connectRequest",
    "accountRequest",
    "requestAccounts",
    "eth_requestAccounts",
  ];

  // Dispatch multiple request events
  requestEventNames.forEach((eventName) => {
    console.log("📤 Dispatching request event:", eventName);
    window.dispatchEvent(new Event(eventName));
  });

  // Return promise that resolves after timeout
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(
        "📤 Provider request completed, found",
        window.demosProviders.length,
        "providers"
      );
      resolve(window.demosProviders);
    }, 2000); // Increased timeout for better reliability
  });
};

window.detectDemosExtension = async function () {
  console.log("🔍 Starting Demos extension detection...");

  // Clear existing providers
  window.demosProviders = [];

  // Dispatch request event
  window.dispatchEvent(new Event("demosRequestProvider"));

  // Wait for providers to respond
  await new Promise((resolve) => setTimeout(resolve, 1500)); // Extended timeout

  console.log(
    `📋 Detection complete. Found ${window.demosProviders.length} providers.`
  );

  // Filter and validate providers (accept broader surfaces)
  const validProviders = window.demosProviders.filter((p) => {
    const prov = p && (p.provider || p);
    if (!prov) {
      console.log("⚠️ Filtering out invalid provider entry:", p);
      return false;
    }
    const ok =
      typeof prov.request === "function" ||
      typeof prov.send === "function" ||
      typeof prov.sendAsync === "function" ||
      typeof prov.connect === "function" ||
      typeof prov.enable === "function";
    if (!ok)
      console.log(
        "⚠️ Provider lacks known interface:",
        p.info?.name || "Unknown"
      );
    return ok;
  });

  console.log(
    `✅ Valid providers: ${validProviders.length}/${window.demosProviders.length}`
  );

  return validProviders;
};

// Wait for extension to be ready
window.waitForDemosExtension = async function (maxAttempts = 10, delay = 500) {
  console.log("⏳ Waiting for Demos extension to be ready...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const providers = await window.detectDemosExtension();

      if (providers.length > 0) {
        console.log(`✅ Demos extension ready after ${attempt} attempts`);
        return providers;
      }
    } catch (error) {
      console.log(`⚠️ Detection attempt ${attempt} failed:`, error.message);
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.log(`❌ Demos extension not ready after ${maxAttempts} attempts`);
  return [];
};

// Initialize event listeners
function initializeExtensionDetector() {
  console.log("📝 Setting up Demos extension event listeners...");
  console.log(
    "🔍 Current demosProviders length:",
    window.demosProviders?.length || 0
  );

  // Multiple possible event names that extensions might use
  const eventNames = [
    "demosAnnounceProvider",
    "ethereumAnnounceProvider",
    "web3AnnounceProvider",
    "providerAnnounced",
    "providerConnected",
    "accountsChanged",
    "connect",
  ];

  // Remove existing listeners to avoid duplicates
  eventNames.forEach((eventName) => {
    window.removeEventListener(eventName, handleAnnounce);
  });

  // Add listeners for multiple possible events
  eventNames.forEach((eventName) => {
    window.addEventListener(eventName, handleAnnounce);
    console.log("🎯 Event listener added for '" + eventName + "'");
  });

  console.log("✅ Demos extension detector initialized");

  // Test if window.demosRequestProvider exists
  if (typeof window.demosRequestProvider === "function") {
    console.log("✅ demosRequestProvider function is available");
  } else {
    console.log("⚠️ demosRequestProvider function is not available");
  }
}

// Initialize immediately if DOM is already loaded, otherwise wait for DOMContentLoaded
console.log("🚀 Extension detector: DOM readyState =", document.readyState);
if (document.readyState === "loading") {
  console.log("⏳ Extension detector: Waiting for DOMContentLoaded...");
  document.addEventListener("DOMContentLoaded", initializeExtensionDetector);
} else {
  console.log("✅ Extension detector: DOM already loaded, initializing now...");
  initializeExtensionDetector();
}

// Export for debugging
window.demosExtensionDebug = {
  providers: () => window.demosProviders,
  detect: () => window.detectDemosExtension(),
  request: () => window.requestDemosProviders(),
  waitForExtension: () => window.waitForDemosExtension(),
};
