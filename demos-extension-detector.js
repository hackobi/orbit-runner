// Demos Extension Detection - Production Version with Fallbacks
console.log('=== Demos Extension Detector ===');

// Manual detection function with multiple fallback methods
window.detectDemosExtension = async function() {
  console.log('🔍 Starting Demos extension detection...');
  
  const providers = [];
  
  // Method 1: Check direct demos object (most common)
  if (window.demos) {
    console.log('✅ Found window.demos:', window.demos);
    providers.push({
      info: { name: 'Demos Extension', url: 'https://chromewebstore.google.com/detail/demos-wallet/nefongcpmdahjaijjkihgieiamoahcoo?pli=1' },
      provider: window.demos
    });
  }
  
  // Method 2: Check for Demos in ethereum provider (injected provider pattern)
  if (window.ethereum) {
    console.log('✅ Found window.ethereum:', window.ethereum);
    
    // Check if it's Demos or has Demos properties
    if (window.ethereum.isDemos || window.ethereum.isDemosWallet || 
        window.ethereum.providers?.some(p => p.isDemos)) {
      providers.push({
        info: { name: 'Demos Extension (Ethereum)', url: 'https://chromewebstore.google.com/detail/demos-wallet/nefongcpmdahjaijjkihgieiamoahcoo?pli=1' },
        provider: window.ethereum
      });
    } else {
      console.log('⚠️ Found ethereum but not Demos-branded');
    }
  }
  
  // Method 3: Check all window objects for Demos-related properties
  for (const key in window) {
    if (key.toLowerCase().includes('demos') && typeof window[key] === 'object') {
      console.log(`✅ Found Demos-related object: window.${key}`, window[key]);
      providers.push({
        info: { name: `Demos Extension (${key})`, url: 'https://chromewebstore.google.com/detail/demos-wallet/nefongcpmdahjaijjkihgieiamoahcoo?pli=1' },
        provider: window[key]
      });
    }
  }
  
  // Method 4: Check for web3 providers
  if (window.web3 && window.web3.currentProvider) {
    console.log('✅ Found web3 provider:', window.web3.currentProvider);
    providers.push({
      info: { name: 'Demos Extension (Web3)', url: 'https://chromewebstore.google.com/detail/demos-wallet/nefongcpmdahjaijjkihgieiamoahcoo?pli=1' },
      provider: window.web3.currentProvider
    });
  }
  
  // Method 5: Event-based detection (for modern extensions)
  console.log('📤 Trying event-based detection...');
  try {
    const eventProviders = [];
    
    const handleProvider = (event) => {
      console.log('📡 Provider announcement received:', event);
      if (event.detail) {
        eventProviders.push(event.detail);
      }
    };
    
    window.addEventListener('demosAnnounceProvider', handleProvider);
    
    const requestEvent = new Event('demosRequestProvider');
    console.log('📤 Dispatching demosRequestProvider event...');
    window.dispatchEvent(requestEvent);
    
    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    window.removeEventListener('demosAnnounceProvider', handleProvider);
    
    if (eventProviders.length > 0) {
      console.log('✅ Found providers via events:', eventProviders);
      providers.push(...eventProviders);
    } else {
      console.log('⚠️ No providers responded to events');
    }
  } catch (error) {
    console.error('❌ Event-based detection failed:', error);
  }
  
  console.log(`🎯 Detection complete. Found ${providers.length} providers.`);
  if (providers.length > 0) {
    console.log('📋 Providers found:', providers);
  } else {
    console.log('❌ No providers found by any method');
    console.log('💡 Make sure the Demos extension is installed and enabled in your browser');
  }
  
  return providers;
};

// Auto-detect on page load with debug info
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Auto-detecting Demos extension on page load...');
  
  // Give extension time to inject
  setTimeout(async () => {
    console.log('🔍 Starting detection after delay...');
    const providers = await window.detectDemosExtension();
    window.demosProviders = providers;
    
    // Dispatch completion event
    window.dispatchEvent(new CustomEvent('demosDetectionComplete', {
      detail: { providers }
    }));
    
    console.log('🎯 Demos extension detection complete');
  }, 1000);
});

// Mock provider for testing (remove in production)
window.createMockDemosProvider = function() {
  console.log('🎭 Creating mock Demos provider for testing...');
  
  const mockProvider = {
    isDemos: true,
    isDemosWallet: true,
    request: async ({ method, params }) => {
      console.log('🎭 Mock provider request:', method, params);
      
      if (method === 'eth_requestAccounts') {
        return ['0x1234567890123456789012345678901234567890'];
      }
      if (method === 'eth_accounts') {
        return ['0x1234567890123456789012345678901234567890'];
      }
      if (method === 'eth_getBalance') {
        return '0x38D7EA4C68000'; // 0.001 ETH
      }
      if (method === 'personal_sign') {
        return '0xmocksignature';
      }
      return null;
    },
    on: (event, callback) => {
      console.log('🎭 Mock provider event listener added:', event);
    },
    removeListener: (event, callback) => {
      console.log('🎭 Mock provider event listener removed:', event);
    }
  };
  
  // Inject mock provider
  window.demos = mockProvider;
  window.ethereum = mockProvider;
  
  console.log('✅ Mock Demos provider created. Use window.demos or window.ethereum');
  return mockProvider;
};

console.log('✅ Demos Extension Detector loaded');
console.log('💡 Tip: Type debugWindowObjects() in console to see all wallet-related objects');
console.log('🎭 Testing: Type createMockDemosProvider() to create a mock wallet for testing');