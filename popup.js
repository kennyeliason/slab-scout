// Slab Scout - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const clientIdInput = document.getElementById('clientId');
  const clientSecretInput = document.getElementById('clientSecret');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  // Load existing credentials
  const config = await chrome.storage.sync.get(['ebayClientId', 'ebayClientSecret']);
  if (config.ebayClientId) {
    clientIdInput.value = config.ebayClientId;
    clientSecretInput.value = '••••••••••••';
    statusEl.textContent = '✅ API configured and ready';
    statusEl.className = 'status success';
  }

  // Save credentials
  saveBtn.addEventListener('click', async () => {
    const clientId = clientIdInput.value.trim();
    const clientSecret = clientSecretInput.value.trim();

    if (!clientId || !clientSecret || clientSecret === '••••••••••••') {
      if (clientSecret === '••••••••••••' && clientId) {
        // Only updating client ID
        await chrome.storage.sync.set({ ebayClientId: clientId });
        statusEl.textContent = '✅ Client ID updated';
        statusEl.className = 'status success';
        return;
      }
      statusEl.textContent = '⚠️ Please enter both Client ID and Client Secret';
      statusEl.className = 'status error';
      return;
    }

    await chrome.storage.sync.set({
      ebayClientId: clientId,
      ebayClientSecret: clientSecret
    });

    // Clear any cached token so it re-authenticates
    await chrome.storage.local.remove(['ebayToken', 'ebayTokenExpiry']);

    statusEl.textContent = '✅ Credentials saved! Browse a raw card on eBay to try it out.';
    statusEl.className = 'status success';
    
    clientSecretInput.value = '••••••••••••';
  });
});
