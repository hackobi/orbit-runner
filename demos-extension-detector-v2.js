console.log("🚀 Demos Extension Detector V2 loaded");

window.demosProviders = [];
console.log("🔍 Extension detector initialized, demosProviders array created");

// Check for common extension injection patterns
setTimeout(() => {
  console.log("🔍 Checking for extension injection patterns...");
  const commonPatterns = [
    'demos',
    'ethereum', 
    'web3',
    'inject',
    'provider'
  ];
  
  const foundPatterns = {};
  commonPatterns.forEach(pattern => {
    const matches = Object.keys(window).filter(key => 
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
  if (!detail.provider) return false;
  if (!detail.info) return false;
  if (typeof detail.provider.request !== 'function') return false;
  return true;
}

function handleAnnounce(e) {
  console.log("🎯 handleAnnounce called with event:", e);
  try {
    const detail = e.detail;
    console.log("🎯 Event detail:", detail);
    
    // Enhanced null checks to prevent timing errors
    if (!detail || typeof detail !== 'object') {
      console.log('⚠️ Invalid announce event detail:', detail);
      return;
    }
    
    if (!detail.provider || typeof detail.provider !== 'object') {
      console.log('⚠️ Invalid provider in announce event:', detail.provider);
      return;
    }
    
    if (!detail.info || typeof detail.info !== 'object') {
      console.log('⚠️ Invalid info in announce event:', detail.info);
      return;
    }
    
    // Additional validation to prevent duplicate or malformed providers
    if (!validateProviderDetail(detail)) {
      console.log('⚠️ Provider detail validation failed:', detail);
      return;
    }

    const exists = window.demosProviders.find(
      (p) => p.info?.uuid === detail.info?.uuid
    );
    
    if (!exists) {
      console.log("✅ Demos provider announced:", detail.info?.name || 'Unknown Provider');
      window.demosProviders.push(detail);
    } else {
      console.log("ℹ️ Provider already exists:", detail.info?.name || 'Unknown Provider');
    }
  } catch (error) {
    console.error('❌ Error in handleAnnounce:', error);
  }
}

// Safe provider request wrapper with enhanced error handling
window.safeProviderRequest = async function(provider, method, params = []) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Invalid provider object');
  }
  
  if (typeof provider.request !== 'function') {
    throw new Error('Provider does not have a request method');
  }
  
  // Ensure method is a string
  if (typeof method !== 'string' || !method.trim()) {
    throw new Error('Invalid method name');
  }
  
  // Ensure params is an array
  if (!Array.isArray(params)) {
    params = [params];
  }
  
  try {
    // Try EIP-1193 standard format first (most compatible)
    return await provider.request({ 
      id: Date.now(), 
      jsonrpc: '2.0', 
      method, 
      params 
    });
  } catch (error1) {
    console.log('⚠️ EIP-1193 format failed:', error1.message);
    
    try {
      // Try standard format (without id/jsonrpc)
      return await provider.request({ method, params });
    } catch (error2) {
      console.log('⚠️ Standard format failed:', error2.message);
      
      try {
        // Fallback to injectProviderV3 format with proper id
        return await provider.request({ 
          id: Date.now(),
          type: method, 
          params,
          jsonrpc: '2.0'
        });
      } catch (error3) {
        console.log('⚠️ injectProviderV3 format failed:', error3.message);
        
        try {
          // Last resort - direct method call if available
          if (typeof provider[method] === 'function') {
            return await provider[method](...params);
          }
        } catch (error4) {
          console.log('❌ All request formats failed');
          throw error4 || error3;
        }
      }
    }
  }
};

// Enhanced detection with timing controls
window.requestDemosProviders = function () {
  console.log("📤 Requesting Demos providers...");
  
  // Clear existing providers to avoid stale entries
  window.demosProviders = [];
  
  // Multiple possible request event names
  const requestEventNames = [
    'demosRequestProvider',
    'ethereumRequestProvider', 
    'web3RequestProvider',
    'providerRequest',
    'connectRequest',
    'accountRequest',
    'requestAccounts',
    'eth_requestAccounts'
  ];
  
  // Dispatch multiple request events
  requestEventNames.forEach(eventName => {
    console.log("📤 Dispatching request event:", eventName);
    window.dispatchEvent(new Event(eventName));
  });
  
  // Return promise that resolves after timeout
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log("📤 Provider request completed, found", window.demosProviders.length, "providers");
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
  
  console.log(`📋 Detection complete. Found ${window.demosProviders.length} providers.`);
  
  // Filter and validate providers
  const validProviders = window.demosProviders.filter(p => {
    if (!p || !p.provider) {
      console.log('⚠️ Filtering out invalid provider entry:', p);
      return false;
    }
    
    if (typeof p.provider.request !== 'function') {
      console.log('⚠️ Filtering out provider without request method:', p.info?.name || 'Unknown');
      return false;
    }
    
    return true;
  });
  
  console.log(`✅ Valid providers: ${validProviders.length}/${window.demosProviders.length}`);
  
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
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.log(`❌ Demos extension not ready after ${maxAttempts} attempts`);
  return [];
};

// Initialize event listeners
function initializeExtensionDetector() {
  console.log("📝 Setting up Demos extension event listeners...");
  console.log("🔍 Current demosProviders length:", window.demosProviders?.length || 0);
  
  // Multiple possible event names that extensions might use
  const eventNames = [
    'demosAnnounceProvider',
    'ethereumAnnounceProvider',
    'web3AnnounceProvider',
    'providerAnnounced',
    'providerConnected',
    'accountsChanged',
    'connect'
  ];
  
  // Remove existing listeners to avoid duplicates
  eventNames.forEach(eventName => {
    window.removeEventListener(eventName, handleAnnounce);
  });
  
  // Add listeners for multiple possible events
  eventNames.forEach(eventName => {
    window.addEventListener(eventName, handleAnnounce);
    console.log("🎯 Event listener added for '" + eventName + "'");
  });
  
  console.log("✅ Demos extension detector initialized");
  
  // Test if window.demosRequestProvider exists
  if (typeof window.demosRequestProvider === 'function') {
    console.log("✅ demosRequestProvider function is available");
  } else {
    console.log("⚠️ demosRequestProvider function is not available");
  }
}

// Initialize immediately if DOM is already loaded, otherwise wait for DOMContentLoaded
console.log("🚀 Extension detector: DOM readyState =", document.readyState);
if (document.readyState === 'loading') {
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
  waitForExtension: () => window.waitForDemosExtension()
};