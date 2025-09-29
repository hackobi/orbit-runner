console.log("🚀 Demos Extension Detector V2 loaded");

window.demosProviders = [];

function handleAnnounce(e) {
  const detail = e.detail;
  if (!detail || !detail.provider) return;

  const exists = window.demosProviders.find(
    (p) => p.info?.uuid === detail.info?.uuid
  );
  if (!exists) {
    console.log("✅ Demos provider announced:", detail);
    window.demosProviders.push(detail);
  }
}

window.requestDemosProviders = function () {
  console.log("📤 Requesting Demos providers...");
  window.demosProviders = [];
  window.dispatchEvent(new Event("demosRequestProvider"));
};

window.detectDemosExtension = async function () {
  window.demosProviders = [];
  window.dispatchEvent(new Event("demosRequestProvider"));

  await new Promise((r) => setTimeout(r, 500));
  return window.demosProviders;
};

document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("demosAnnounceProvider", handleAnnounce);
});