// Slab Scout - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const clientIdInput = document.getElementById('clientId');
  const clientSecretInput = document.getElementById('clientSecret');
  const openaiKeyInput = document.getElementById('openaiKey');
  const gradingFeeInput = document.getElementById('gradingFee');
  const salesTaxInput = document.getElementById('salesTaxRate');
  const ebayFeeInput = document.getElementById('ebayFeeRate');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  // Load existing config
  const config = await chrome.storage.sync.get(['ebayClientId', 'ebayClientSecret', 'openaiApiKey', 'gradingFee', 'salesTaxRate', 'ebayFeeRate']);
  if (config.ebayClientId) {
    clientIdInput.value = config.ebayClientId;
    clientSecretInput.value = '••••••••••••';
    statusEl.textContent = '✅ API configured and ready';
    statusEl.className = 'status success';
  }
  if (config.openaiApiKey) {
    openaiKeyInput.value = '••••••••••••';
  }
  gradingFeeInput.value = config.gradingFee || '150';
  salesTaxInput.value = config.salesTaxRate != null ? (config.salesTaxRate * 100) : '8';
  ebayFeeInput.value = config.ebayFeeRate != null ? (config.ebayFeeRate * 100) : '15';

  // Save credentials
  saveBtn.addEventListener('click', async () => {
    const clientId = clientIdInput.value.trim();
    const clientSecret = clientSecretInput.value.trim();
    const openaiKey = openaiKeyInput.value.trim();
    const gradingFee = parseInt(gradingFeeInput.value.trim()) || 150;
    const salesTaxRate = (parseFloat(salesTaxInput.value.trim()) || 8) / 100;
    const ebayFeeRate = (parseFloat(ebayFeeInput.value.trim()) || 15) / 100;

    if (!clientId || !clientSecret || clientSecret === '••••••••••••') {
      if (clientSecret === '••••••••••••' && clientId) {
        // Only updating client ID / fee / openai key
        const updates = { ebayClientId: clientId, gradingFee: gradingFee, salesTaxRate, ebayFeeRate };
        if (openaiKey && openaiKey !== '••••••••••••') updates.openaiApiKey = openaiKey;
        await chrome.storage.sync.set(updates);
        statusEl.textContent = '✅ Settings updated';
        statusEl.className = 'status success';
        return;
      }
      statusEl.textContent = '⚠️ Please enter both Client ID and Client Secret';
      statusEl.className = 'status error';
      return;
    }

    const settings = {
      ebayClientId: clientId,
      ebayClientSecret: clientSecret,
      gradingFee: gradingFee,
      salesTaxRate: salesTaxRate,
      ebayFeeRate: ebayFeeRate
    };
    if (openaiKey && openaiKey !== '••••••••••••') settings.openaiApiKey = openaiKey;

    await chrome.storage.sync.set(settings);

    // Clear any cached token so it re-authenticates
    await chrome.storage.local.remove(['ebayToken', 'ebayTokenExpiry']);

    statusEl.textContent = '✅ Credentials saved! Browse a raw card on eBay to try it out.';
    statusEl.className = 'status success';
    
    clientSecretInput.value = '••••••••••••';
    if (openaiKey && openaiKey !== '••••••••••••') openaiKeyInput.value = '••••••••••••';
  });

  // Auto-save grading fee on change
  gradingFeeInput.addEventListener('change', async () => {
    const fee = parseInt(gradingFeeInput.value.trim()) || 150;
    await chrome.storage.sync.set({ gradingFee: fee });
  });
});
