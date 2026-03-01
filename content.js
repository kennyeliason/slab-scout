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
    
    // Detect auction vs fixed price
    const isAuction = !!(
      document.querySelector('#bidBtn, .x-bid-action, [data-testid="x-bid-action"]') ||
      document.querySelector('.x-bid-count, #vi-abf-cur-num') ||
      document.querySelector('.vi-VR-cvipCntr1 #prcIsum_bidPrice') ||
      document.querySelector('[data-testid="x-bin-price"]') === null && 
        document.querySelector('.x-price-primary')?.textContent?.toLowerCase()?.includes('bid')
    );
    
    const bidCount = document.querySelector('.x-bid-count span, #vi-abf-cur-num')?.textContent?.trim();
    
    return { title, price, isGraded, isAuction, bidCount };
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
  function renderResults(panel, cardInfo, rawPrice, comps, profit, gradingFee, isAuction) {
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

    // Find the LOWEST grade that's still profitable (worst-case-still-wins)
    // and find grades with 2x+ ROI (the real sweet spot)
    const profitableGrades = Object.entries(profit)
      .filter(([g, p]) => p.profit > 0)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0])); // sort by grade ascending
    
    const lowestProfitable = profitableGrades[0]; // lowest grade that still profits
    const doubleUpGrades = profitableGrades.filter(([g, p]) => p.roi >= 100); // 2x+
    const lowestDoubleUp = doubleUpGrades.sort((a, b) => parseInt(a[0]) - parseInt(b[0]))[0];

    // Calculate max bid thresholds (for each grade: avg sold - grading fee = break-even price)
    const maxBids = {};
    for (const [grade, data] of Object.entries(profit)) {
      const breakeven = comps[grade].avg - (gradingFee || 150);
      if (breakeven > 0) maxBids[grade] = breakeven;
    }

    // Summary — focus on "at this price, even at grade X you profit"
    if (lowestDoubleUp) {
      // Amazing deal — even at a low grade you 2x
      const [grade, data] = lowestDoubleUp;
      summaryEl.innerHTML = `
        <div class="ss-best ss-best-fire">
          <div class="ss-best-label">🔥 At ${isAuction ? 'this bid' : 'this price'}, even a PSA ${grade} doubles your money</div>
          <div class="ss-best-profit">+$${data.profit.toLocaleString(undefined, {maximumFractionDigits: 0})} <span class="ss-roi-badge">${data.roi.toFixed(0)}% ROI</span></div>
          ${profitableGrades.length > 1 ? `<div class="ss-best-sub">Profitable at ${profitableGrades.length} grade levels (PSA ${profitableGrades[0][0]}–${profitableGrades[profitableGrades.length-1][0]})</div>` : ''}
        </div>
      `;
    } else if (lowestProfitable) {
      const [grade, data] = lowestProfitable;
      const roiNote = data.roi >= 50 ? 'Solid margins' : 'Thin margins';
      summaryEl.innerHTML = `
        <div class="ss-best">
          <div class="ss-best-label">At ${isAuction ? 'this bid' : 'this price'}, a PSA ${grade}+ is profitable</div>
          <div class="ss-best-profit">+$${data.profit.toLocaleString(undefined, {maximumFractionDigits: 0})} at PSA ${grade} <span class="ss-roi-badge">${data.roi.toFixed(0)}% ROI</span></div>
          <div class="ss-best-sub">${roiNote} · ${profitableGrades.length} profitable grade${profitableGrades.length > 1 ? 's' : ''}</div>
        </div>
      `;
    } else if (Object.keys(comps).length > 0) {
      // Nothing profitable at current price — show what price WOULD work
      const bestMaxBid = Object.entries(maxBids).sort((a, b) => b[1] - a[1])[0];
      summaryEl.innerHTML = `
        <div class="ss-best ss-best-negative">
          <div class="ss-best-label">Not worth it at ${isAuction ? 'this bid' : 'this price'}</div>
          <div class="ss-best-profit">No grade is profitable after grading fees</div>
          ${bestMaxBid ? `<div class="ss-best-sub">Would need to ${isAuction ? 'win at' : 'buy for'} ≤$${Math.floor(bestMaxBid[1]).toLocaleString()} to profit (PSA ${bestMaxBid[0]})</div>` : ''}
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
            ${isAuction ? '<th>Max Bid</th>' : ''}
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
        const compCount = comps[grade].count;
        const lowConfidence = compCount <= 1;
        
        const maxBidVal = maxBids[grade] ? `$${Math.floor(maxBids[grade]).toLocaleString()}` : '—';
        tableHTML += `
          <tr class="${grade == bestGrade ? 'ss-best-row' : ''}">
            <td><span class="ss-grade-badge ss-grade-${grade >= 9 ? 'gem' : grade >= 7 ? 'high' : grade >= 5 ? 'mid' : 'low'}">PSA ${grade}</span></td>
            <td>$${p.gradedAvg.toLocaleString(undefined, {maximumFractionDigits: 0})}${lowConfidence ? ' ⚠️' : ''}</td>
            <td class="ss-range">${p.gradedRange} <span class="ss-comp-count">(${compCount})</span></td>
            ${isAuction ? `<td class="ss-max-bid-cell">${maxBidVal}</td>` : ''}
            <td class="${profitClass}">${profitStr}</td>
            <td>${p.verdict}</td>
          </tr>
        `;
      } else {
        tableHTML += `
          <tr class="ss-no-data-row">
            <td><span class="ss-grade-badge ss-grade-${grade >= 9 ? 'gem' : grade >= 7 ? 'high' : grade >= 5 ? 'mid' : 'low'}">PSA ${grade}</span></td>
            <td colspan="${isAuction ? 4 : 3}" class="ss-no-data">No recent sold comps</td>
            <td>—</td>
          </tr>
        `;
      }
    }

    tableHTML += '</tbody></table>';
    tableEl.innerHTML = tableHTML;
    
    const hasNoData = grades.some(g => !comps[g]);
    const hasLowConf = Object.values(comps).some(c => c.count <= 1);
    feeEl.innerHTML = `
      <div class="ss-fee-info">
        💰 Profit calculated with $${gradingFee || 150} grading fee
        <br>📊 Comp count shown in parentheses per grade
        ${hasLowConf ? '<br>⚠️ Low comp count — data may not be reliable' : ''}
        ${hasNoData ? '<br>🔍 "No recent sold comps" = no eBay sales found (rare/high-end cards may sell at auction houses)' : ''}
        <br>⚙️ Change fee in Slab Scout settings
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
    if (listing.isAuction && listing.price > 0) {
      panel.querySelector('.ss-raw-price').innerHTML = `Current Bid: $${listing.price.toLocaleString()} 🔨 <span style="color:#f5a623;font-size:11px;">(Auction${listing.bidCount ? ' · ' + listing.bidCount : ''})</span>`;
    } else if (listing.price > 0) {
      panel.querySelector('.ss-raw-price').textContent = `Raw Price: $${listing.price.toLocaleString()}`;
    } else {
      panel.querySelector('.ss-raw-price').textContent = 'Price: Not detected';
    }

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
      renderResults(panel, parsed.cardInfo, listing.price, response.comps, response.profit, response.gradingFee, listing.isAuction);
    } else {
      panel.querySelector('.ss-error').textContent = response.error;
      panel.querySelector('.ss-error').style.display = 'block';
    }
  }

  // Run on page load
  init();
})();
