// Slab Scout - Content Script
// Runs on eBay listing pages, extracts card info, shows graded comps

(function() {
  'use strict';

  // Don't run if already injected
  if (document.getElementById('slab-scout-panel')) return;

  // Extract listing info
  function getListingInfo() {
    const title = document.querySelector('.x-item-title__mainTitle span, h1.x-item-title__mainTitle, #itemTitle')?.textContent?.trim();
    const priceEl = document.querySelector('.x-price-primary span, #prcIsum, .x-bin-price__content span');
    let price = 0;
    
    if (priceEl) {
      const priceText = priceEl.textContent.replace(/[^0-9.,]/g, '');
      price = parseFloat(priceText.replace(/,/g, ''));
    }

    // Check if listing mentions grading terms (skip already-graded cards)
    const isGraded = /\b(PSA|BGS|SGC|CGC)\s*\d/i.test(title);
    
    return { title, price, isGraded };
  }

  // Create the scout panel
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'slab-scout-panel';
    panel.innerHTML = `
      <div class="ss-header">
        <div class="ss-logo">🔍 Slab Scout</div>
        <div class="ss-controls">
          <button class="ss-btn ss-refresh" title="Refresh comps">↻</button>
          <button class="ss-btn ss-minimize" title="Minimize">−</button>
          <button class="ss-btn ss-close" title="Close">×</button>
        </div>
      </div>
      <div class="ss-body">
        <div class="ss-card-info">
          <div class="ss-parsed-title"></div>
          <div class="ss-raw-price"></div>
        </div>
        <div class="ss-loading" style="display:none;">
          <div class="ss-spinner"></div>
          <span>Scouting graded comps...</span>
        </div>
        <div class="ss-error" style="display:none;"></div>
        <div class="ss-results" style="display:none;">
          <div class="ss-summary"></div>
          <div class="ss-grade-table"></div>
          <div class="ss-fee-note"></div>
        </div>
        <div class="ss-not-raw" style="display:none;">
          <p>This card appears to already be graded. Slab Scout works best on raw card listings.</p>
        </div>
        <div class="ss-no-config" style="display:none;">
          <p>⚙️ eBay API not configured.</p>
          <p>Click the Slab Scout icon in your toolbar to enter your API credentials.</p>
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // Event listeners
    panel.querySelector('.ss-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    
    panel.querySelector('.ss-minimize').addEventListener('click', () => {
      const body = panel.querySelector('.ss-body');
      const btn = panel.querySelector('.ss-minimize');
      if (body.style.display === 'none') {
        body.style.display = 'block';
        btn.textContent = '−';
      } else {
        body.style.display = 'none';
        btn.textContent = '+';
      }
    });
    
    panel.querySelector('.ss-refresh').addEventListener('click', () => {
      init();
    });

    // Make draggable
    makeDraggable(panel);
    
    return panel;
  }

  function makeDraggable(el) {
    const header = el.querySelector('.ss-header');
    let isDragging = false, startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('ss-btn')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      header.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.right = 'auto';
      el.style.left = (startLeft + e.clientX - startX) + 'px';
      el.style.top = (startTop + e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      header.style.cursor = 'grab';
    });
  }

  // Show grade comparison table
  function renderResults(panel, cardInfo, rawPrice, comps, profit) {
    const resultsEl = panel.querySelector('.ss-results');
    const summaryEl = panel.querySelector('.ss-summary');
    const tableEl = panel.querySelector('.ss-grade-table');
    const feeEl = panel.querySelector('.ss-fee-note');

    // Find best grade opportunity
    let bestGrade = null;
    let bestProfit = -Infinity;
    for (const [grade, data] of Object.entries(profit)) {
      if (data.profit > bestProfit) {
        bestProfit = data.profit;
        bestGrade = grade;
      }
    }

    // Summary
    if (bestGrade && bestProfit > 0) {
      summaryEl.innerHTML = `
        <div class="ss-best">
          <div class="ss-best-label">Best opportunity</div>
          <div class="ss-best-grade">PSA ${bestGrade}</div>
          <div class="ss-best-profit">+$${bestProfit.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
          <div class="ss-best-roi">${profit[bestGrade].roi.toFixed(1)}% ROI</div>
        </div>
      `;
    } else if (Object.keys(comps).length > 0) {
      summaryEl.innerHTML = `
        <div class="ss-best ss-best-negative">
          <div class="ss-best-label">No profitable grade at this price</div>
          <div class="ss-best-profit">Consider negotiating lower</div>
        </div>
      `;
    } else {
      summaryEl.innerHTML = `
        <div class="ss-best ss-best-neutral">
          <div class="ss-best-label">No graded comps found</div>
          <div class="ss-best-profit">Try adjusting the card details</div>
        </div>
      `;
    }

    // Grade table
    const grades = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    let tableHTML = `
      <table class="ss-table">
        <thead>
          <tr>
            <th>Grade</th>
            <th>Avg Sold</th>
            <th>Range</th>
            <th>Profit</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const grade of grades) {
      if (comps[grade]) {
        const p = profit[grade];
        const profitClass = p.profit > 0 ? 'ss-profit-positive' : 'ss-profit-negative';
        const profitStr = p.profit > 0 
          ? `+$${p.profit.toLocaleString(undefined, {maximumFractionDigits: 0})}` 
          : `-$${Math.abs(p.profit).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
        
        tableHTML += `
          <tr class="${grade == bestGrade ? 'ss-best-row' : ''}">
            <td><span class="ss-grade-badge ss-grade-${grade >= 9 ? 'gem' : grade >= 7 ? 'high' : grade >= 5 ? 'mid' : 'low'}">PSA ${grade}</span></td>
            <td>$${p.gradedAvg.toLocaleString(undefined, {maximumFractionDigits: 0})}</td>
            <td class="ss-range">${p.gradedRange}</td>
            <td class="${profitClass}">${profitStr}</td>
            <td>${p.verdict}</td>
          </tr>
        `;
      }
    }

    tableHTML += '</tbody></table>';
    tableEl.innerHTML = tableHTML;
    
    feeEl.innerHTML = `
      <div class="ss-fee-info">
        💰 Profit calculated with $150 PSA regular grading fee
        <br>📊 Based on last ${Object.values(comps)[0]?.count || 5} sold comps per grade
      </div>
    `;

    resultsEl.style.display = 'block';
  }

  // Main init
  async function init() {
    const panel = document.getElementById('slab-scout-panel') || createPanel();
    panel.style.display = 'block';
    
    const listing = getListingInfo();
    
    if (!listing.title) {
      panel.querySelector('.ss-error').textContent = 'Could not read listing title.';
      panel.querySelector('.ss-error').style.display = 'block';
      return;
    }

    // Show parsed info
    panel.querySelector('.ss-parsed-title').textContent = listing.title;
    panel.querySelector('.ss-raw-price').textContent = listing.price > 0 
      ? `Raw Price: $${listing.price.toLocaleString()}` 
      : 'Price: Not detected';

    // Check if already graded
    if (listing.isGraded) {
      panel.querySelector('.ss-not-raw').style.display = 'block';
      panel.querySelector('.ss-loading').style.display = 'none';
      return;
    }

    // Check config
    const configCheck = await chrome.runtime.sendMessage({ type: 'CHECK_CONFIG' });
    if (!configCheck.configured) {
      panel.querySelector('.ss-no-config').style.display = 'block';
      panel.querySelector('.ss-loading').style.display = 'none';
      return;
    }

    // Parse title
    const parsed = await chrome.runtime.sendMessage({ type: 'PARSE_TITLE', title: listing.title });
    
    // Show loading
    panel.querySelector('.ss-loading').style.display = 'flex';
    panel.querySelector('.ss-results').style.display = 'none';
    panel.querySelector('.ss-error').style.display = 'none';

    // Fetch comps
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_COMPS',
      cardInfo: parsed.cardInfo,
      rawPrice: listing.price
    });

    panel.querySelector('.ss-loading').style.display = 'none';

    if (response.success) {
      renderResults(panel, parsed.cardInfo, listing.price, response.comps, response.profit);
    } else {
      panel.querySelector('.ss-error').textContent = response.error;
      panel.querySelector('.ss-error').style.display = 'block';
    }
  }

  // Run on page load
  init();
})();
