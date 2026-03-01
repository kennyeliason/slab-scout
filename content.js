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
    
    // Extract PSA grading fee from listing (eBay shows "Additional services available")
    let listingGradingFee = null;
    document.querySelectorAll('span, div, li').forEach(el => {
      const text = el.textContent;
      if (/PSA\s+Grading/i.test(text)) {
        const feeMatch = text.match(/\$\s*([\d,.]+)/);
        if (feeMatch) {
          listingGradingFee = parseFloat(feeMatch[1].replace(/,/g, ''));
        }
      }
    });
    
    // Detect auction vs fixed price
    const isAuction = !!(
      document.querySelector('#bidBtn, .x-bid-action, [data-testid="x-bid-action"]') ||
      document.querySelector('.x-bid-count, #vi-abf-cur-num') ||
      document.querySelector('.vi-VR-cvipCntr1 #prcIsum_bidPrice') ||
      document.querySelector('[data-testid="x-bin-price"]') === null && 
        document.querySelector('.x-price-primary')?.textContent?.toLowerCase()?.includes('bid')
    );
    
    const bidCount = document.querySelector('.x-bid-count span, #vi-abf-cur-num')?.textContent?.trim();
    
    return { title, price, isGraded, isAuction, bidCount, listingGradingFee };
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
          <div class="ss-ai-section" style="display:none;">
            <div class="ss-ai-result"></div>
          </div>
          <div class="ss-ai-btn-wrap" style="display:none;">
            <button class="ss-ai-grade-btn">🤖 AI Grade This Card</button>
          </div>
          <div class="ss-ai-loading" style="display:none;">
            <div class="ss-spinner"></div>
            <span>Analyzing card images...</span>
          </div>
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
  function renderResults(panel, cardInfo, rawPrice, comps, profit, gradingFee, isAuction, feeSource, salesTaxRate, ebayFeeRate) {
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

    // Calculate max bid thresholds accounting for all costs
    // Break-even: netRevenue = totalCost → sale*(1-ebayFee) = buy*(1+tax) + gradingFee
    // Solve for buy: buy = (sale*(1-ebayFee) - gradingFee) / (1+tax)
    const taxRate = salesTaxRate || 0.08;
    const ebayRate = ebayFeeRate || 0.15;
    const fee = gradingFee || 150;
    const maxBids = {};
    for (const [grade, data] of Object.entries(profit)) {
      const breakeven = ((comps[grade].avg * (1 - ebayRate)) - fee) / (1 + taxRate);
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

    const colCount = isAuction ? 6 : 5;
    
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
          <tr class="ss-grade-row ${grade == bestGrade ? 'ss-best-row' : ''}" data-grade="${grade}" style="cursor:pointer;">
            <td><span class="ss-grade-badge ss-grade-${grade >= 9 ? 'gem' : grade >= 7 ? 'high' : grade >= 5 ? 'mid' : 'low'}">PSA ${grade}</span></td>
            <td>$${p.gradedAvg.toLocaleString(undefined, {maximumFractionDigits: 0})}${lowConfidence ? ' ⚠️' : ''}</td>
            <td class="ss-range">${p.gradedRange} <span class="ss-comp-count">(${compCount})</span></td>
            ${isAuction ? `<td class="ss-max-bid-cell">${maxBidVal}</td>` : ''}
            <td class="${profitClass}">${profitStr}</td>
            <td class="ss-expand-icon">▸</td>
          </tr>
          <tr class="ss-comp-detail" data-grade-detail="${grade}" style="display:none;">
            <td colspan="${colCount}">
              <div class="ss-comp-list">
                ${comps[grade].items.map(item => {
                  const date = item.date ? new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                  const soldBadge = item.isSold ? '<span class="ss-sold-badge">SOLD</span>' : '<span class="ss-active-badge">ACTIVE</span>';
                  return `
                    <a href="${item.url}" target="_blank" class="ss-comp-item" title="${item.title}">
                      ${item.image ? `<img src="${item.image}" class="ss-comp-thumb" alt="">` : ''}
                      <div class="ss-comp-info">
                        <div class="ss-comp-price">$${item.price.toLocaleString(undefined, {maximumFractionDigits: 0})} ${soldBadge}</div>
                        <div class="ss-comp-date">${date}</div>
                      </div>
                      <div class="ss-comp-link">↗</div>
                    </a>
                  `;
                }).join('')}
              </div>
            </td>
          </tr>
        `;
      } else {
        tableHTML += `
          <tr class="ss-no-data-row">
            <td><span class="ss-grade-badge ss-grade-${grade >= 9 ? 'gem' : grade >= 7 ? 'high' : grade >= 5 ? 'mid' : 'low'}">PSA ${grade}</span></td>
            <td colspan="${colCount - 2}" class="ss-no-data">No recent sold comps</td>
            <td>—</td>
          </tr>
        `;
      }
    }

    tableHTML += '</tbody></table>';
    tableEl.innerHTML = tableHTML;
    
    // Add click handlers for expandable rows
    tableEl.querySelectorAll('.ss-grade-row').forEach(row => {
      row.addEventListener('click', () => {
        const grade = row.dataset.grade;
        const detail = tableEl.querySelector(`[data-grade-detail="${grade}"]`);
        const icon = row.querySelector('.ss-expand-icon');
        if (detail.style.display === 'none') {
          detail.style.display = 'table-row';
          icon.textContent = '▾';
          row.classList.add('ss-row-expanded');
        } else {
          detail.style.display = 'none';
          icon.textContent = '▸';
          row.classList.remove('ss-row-expanded');
        }
      });
    });
    
    const hasNoData = grades.some(g => !comps[g]);
    const hasLowConf = Object.values(comps).some(c => c.count <= 1);
    const feeLabel = feeSource === 'listing' 
      ? `$${gradingFee || 150} grading (from listing)` 
      : `$${gradingFee || 150} grading (from settings)`;
    const taxPct = Math.round((salesTaxRate || 0.08) * 100);
    const ebayPct = Math.round((ebayFeeRate || 0.15) * 100);
    feeEl.innerHTML = `
      <div class="ss-fee-info">
        💰 ${feeLabel} + ${taxPct}% sales tax on buy + ${ebayPct}% eBay fees on sell
        <br>📊 Comp count shown in parentheses per grade
        ${hasLowConf ? '<br>⚠️ Low comp count — data may not be reliable' : ''}
        ${hasNoData ? '<br>🔍 "No recent sold comps" = no eBay sales found (rare/high-end cards may sell at auction houses)' : ''}
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

    // Fetch comps (use listing's grading fee if available)
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_COMPS',
      cardInfo: parsed.cardInfo,
      rawPrice: listing.price,
      listingGradingFee: listing.listingGradingFee
    });

    panel.querySelector('.ss-loading').style.display = 'none';

    if (response.success) {
      renderResults(panel, parsed.cardInfo, listing.price, response.comps, response.profit, response.gradingFee, listing.isAuction, response.feeSource, response.salesTaxRate, response.ebayFeeRate);
      
      // Show AI Grade button if OpenAI is configured
      if (configCheck.hasOpenAI) {
        const aiBtnWrap = panel.querySelector('.ss-ai-btn-wrap');
        aiBtnWrap.style.display = 'block';
        
        const aiBtn = panel.querySelector('.ss-ai-grade-btn');
        aiBtn.onclick = async () => {
          // Extract listing images
          const imageUrls = getListingImages();
          if (imageUrls.length === 0) {
            panel.querySelector('.ss-ai-result').innerHTML = '<div class="ss-ai-error">No card images found on this listing.</div>';
            panel.querySelector('.ss-ai-section').style.display = 'block';
            return;
          }
          
          aiBtnWrap.style.display = 'none';
          panel.querySelector('.ss-ai-loading').style.display = 'flex';
          
          const aiResponse = await chrome.runtime.sendMessage({
            type: 'AI_GRADE',
            imageUrls,
            cardInfo: parsed.cardInfo
          });
          
          panel.querySelector('.ss-ai-loading').style.display = 'none';
          
          if (aiResponse.success) {
            renderAIGrade(panel, aiResponse.grading, response.comps, response.profit, listing.price, response.gradingFee, listing.isAuction);
          } else {
            panel.querySelector('.ss-ai-result').innerHTML = `<div class="ss-ai-error">AI grading failed: ${aiResponse.error}</div>`;
            panel.querySelector('.ss-ai-section').style.display = 'block';
            aiBtnWrap.style.display = 'block';
          }
        };
      }
    } else {
      panel.querySelector('.ss-error').textContent = response.error;
      panel.querySelector('.ss-error').style.display = 'block';
    }
  }

  // Extract listing images from eBay page
  function getListingImages() {
    const urls = new Set();
    
    // Main image
    const mainImg = document.querySelector('#icImg, .ux-image-carousel-item img, [data-testid="ux-image-carousel"] img');
    if (mainImg?.src) urls.add(mainImg.src.replace(/s-l\d+/, 's-l1600'));
    
    // Carousel thumbnails → get full-size versions
    document.querySelectorAll('.ux-image-carousel-item img, #vi_main_img_fs img, .tdThumb img, [data-testid="ux-image-carousel"] img').forEach(img => {
      let src = img.src || img.dataset?.src || '';
      if (src) urls.add(src.replace(/s-l\d+/, 's-l1600'));
    });
    
    // Image zoom URLs (higher quality)
    document.querySelectorAll('[data-zoom-src]').forEach(el => {
      urls.add(el.dataset.zoomSrc);
    });
    
    return [...urls].filter(u => u.startsWith('http')).slice(0, 4);
  }

  // Render AI grading results
  function renderAIGrade(panel, grading, comps, profit, rawPrice, gradingFee, isAuction) {
    const aiSection = panel.querySelector('.ss-ai-section');
    const aiResult = panel.querySelector('.ss-ai-result');
    
    const g = grading;
    const gradeRange = g.grade_low === g.grade_high 
      ? `PSA ${g.grade_likely}` 
      : `PSA ${g.grade_low}–${g.grade_high}`;
    
    const confidenceColors = { low: '#e94560', medium: '#f5a623', high: '#10b981' };
    const confColor = confidenceColors[g.confidence] || '#888';
    
    // Score badges
    function scoreBadge(score) {
      const colors = {
        'gem': '#10b981', 'gem mint': '#10b981', 'well-centered': '#10b981', 'sharp': '#10b981', 'clean': '#10b981',
        'slightly off': '#f5a623', 'light wear': '#f5a623', 'light issues': '#f5a623',
        'off-center': '#e94560', 'worn': '#e94560', 'rough': '#e94560', 'damaged': '#e94560'
      };
      const color = colors[score?.toLowerCase()] || '#888';
      return `<span style="color:${color};font-weight:600;">${score}</span>`;
    }
    
    // Build mini profit table for the AI grade range
    const likelyGrade = g.grade_likely;
    let profitTable = '<div class="ss-ai-profit-table"><table class="ss-ai-mini-table"><thead><tr><th>Grade</th><th>Avg Sold</th><th>Profit</th><th>ROI</th></tr></thead><tbody>';
    
    for (let gr = g.grade_high; gr >= g.grade_low; gr--) {
      if (!profit[gr]) {
        profitTable += `<tr class="ss-ai-mini-nodata ${gr === likelyGrade ? 'ss-ai-mini-likely' : ''}"><td>PSA ${gr}${gr === likelyGrade ? ' ★' : ''}</td><td colspan="3" style="color:#666;font-style:italic;">No comps</td></tr>`;
        continue;
      }
      const p = profit[gr];
      const profitClass = p.profit > 0 ? 'ss-profit-positive' : 'ss-profit-negative';
      const profitStr = p.profit > 0 
        ? `+$${p.profit.toLocaleString(undefined, {maximumFractionDigits: 0})}` 
        : `-$${Math.abs(p.profit).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
      const isLikely = gr === likelyGrade;
      
      profitTable += `
        <tr class="${isLikely ? 'ss-ai-mini-likely' : ''}">
          <td>PSA ${gr}${isLikely ? ' ★' : ''}</td>
          <td>$${p.gradedAvg.toLocaleString(undefined, {maximumFractionDigits: 0})}</td>
          <td class="${profitClass}">${profitStr}</td>
          <td class="${profitClass}">${p.roi.toFixed(0)}%</td>
        </tr>`;
    }
    profitTable += '</tbody></table></div>';

    aiResult.innerHTML = `
      <div class="ss-ai-header">
        <div class="ss-ai-grade-display">
          <div class="ss-ai-grade-range">${gradeRange}</div>
          <div class="ss-ai-likely">Most likely: <strong>PSA ${likelyGrade}</strong> ★</div>
          <div class="ss-ai-confidence" style="color:${confColor}">Confidence: ${g.confidence}</div>
        </div>
      </div>
      ${profitTable}
      <div class="ss-ai-breakdown">
        <div class="ss-ai-criteria">
          <div class="ss-ai-row">📐 Centering: ${scoreBadge(g.centering?.score)} <span class="ss-ai-detail">${g.centering?.detail || ''}</span></div>
          <div class="ss-ai-row">🔲 Corners: ${scoreBadge(g.corners?.score)} <span class="ss-ai-detail">${g.corners?.detail || ''}</span></div>
          <div class="ss-ai-row">📏 Edges: ${scoreBadge(g.edges?.score)} <span class="ss-ai-detail">${g.edges?.detail || ''}</span></div>
          <div class="ss-ai-row">✨ Surface: ${scoreBadge(g.surface?.score)} <span class="ss-ai-detail">${g.surface?.detail || ''}</span></div>
        </div>
        <div class="ss-ai-summary">${g.summary}</div>
      </div>
    `;
    
    aiSection.style.display = 'block';
    
    // Highlight the estimated grade rows in the table
    panel.querySelectorAll('.ss-table tbody tr').forEach(row => {
      const badge = row.querySelector('.ss-grade-badge');
      if (!badge) return;
      const gradeNum = parseInt(badge.textContent.replace('PSA ', ''));
      if (gradeNum >= g.grade_low && gradeNum <= g.grade_high) {
        row.classList.add('ss-ai-highlight');
        if (gradeNum === likelyGrade) row.classList.add('ss-ai-likely-row');
      }
    });
    
    // REWRITE the summary box to reflect AI grade estimate
    const summaryEl = panel.querySelector('.ss-summary');
    const fee = gradingFee || 150;
    const priceLabel = isAuction ? 'this bid' : 'this price';
    
    // Check profit at likely grade and worst case (grade_low)
    const likelyProfit = profit[likelyGrade];
    const worstProfit = profit[g.grade_low];
    
    if (likelyProfit && likelyProfit.profit > 0) {
      const roiStr = likelyProfit.roi.toFixed(0);
      const is2x = likelyProfit.roi >= 100;
      const worstNote = worstProfit && g.grade_low !== likelyGrade
        ? (worstProfit.profit > 0 
          ? `<div class="ss-best-sub">Even at PSA ${g.grade_low} (worst case): +$${worstProfit.profit.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>`
          : `<div class="ss-best-sub">⚠️ At PSA ${g.grade_low}: -$${Math.abs(worstProfit.profit).toLocaleString(undefined, {maximumFractionDigits: 0})} loss</div>`)
        : '';
      
      summaryEl.innerHTML = `
        <div class="ss-best ${is2x ? 'ss-best-fire' : ''}">
          <div class="ss-best-label">${is2x ? '🔥' : '✅'} AI estimates PSA ${likelyGrade} → at ${priceLabel}:</div>
          <div class="ss-best-profit">+$${likelyProfit.profit.toLocaleString(undefined, {maximumFractionDigits: 0})} <span class="ss-roi-badge">${roiStr}% ROI</span></div>
          ${worstNote}
        </div>
      `;
    } else if (likelyProfit) {
      // Likely grade is a loss
      const maxPayable = comps[likelyGrade] ? Math.floor(((comps[likelyGrade].avg * (1 - (ebayFeeRate || 0.15))) - (gradingFee || 150)) / (1 + (salesTaxRate || 0.08))) : 0;
      summaryEl.innerHTML = `
        <div class="ss-best ss-best-negative">
          <div class="ss-best-label">❌ AI estimates PSA ${likelyGrade} → not profitable at ${priceLabel}</div>
          <div class="ss-best-profit">-$${Math.abs(likelyProfit.profit).toLocaleString(undefined, {maximumFractionDigits: 0})} loss after grading</div>
          ${maxPayable > 0 ? `<div class="ss-best-sub">Would need to ${isAuction ? 'win at' : 'buy for'} ≤$${maxPayable.toLocaleString()} to break even</div>` : ''}
        </div>
      `;
    } else {
      // No comp data for likely grade
      summaryEl.innerHTML = `
        <div class="ss-best ss-best-neutral">
          <div class="ss-best-label">🤖 AI estimates ${gradeRange}</div>
          <div class="ss-best-profit">No sold comps at PSA ${likelyGrade} to calculate profit</div>
        </div>
      `;
    }
  }

  // Run on page load
  init();
})();
