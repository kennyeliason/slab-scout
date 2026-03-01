// Slab Scout - Background Service Worker
// Handles eBay API calls (avoids CORS issues from content script)

const EBAY_API_BASE = 'https://api.ebay.com';
const GRADING_FEES = {
  economy: 35,    // 65+ business day
  value: 75,      // 45 business day  
  regular: 150,   // 20 business day
  express: 300,   // 10 business day
  super_express: 600 // 5 business day
};

// Get OAuth token using client credentials
async function getEbayToken() {
  const config = await chrome.storage.sync.get(['ebayClientId', 'ebayClientSecret']);
  if (!config.ebayClientId || !config.ebayClientSecret) {
    throw new Error('eBay API credentials not configured. Click the Slab Scout icon to set up.');
  }

  // Check cached token
  const cached = await chrome.storage.local.get(['ebayToken', 'ebayTokenExpiry']);
  if (cached.ebayToken && cached.ebayTokenExpiry && Date.now() < cached.ebayTokenExpiry) {
    return cached.ebayToken;
  }

  const credentials = btoa(`${config.ebayClientId}:${config.ebayClientSecret}`);
  const response = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`eBay auth failed: ${err}`);
  }

  const data = await response.json();
  
  // Cache token (expire 5 min early to be safe)
  await chrome.storage.local.set({
    ebayToken: data.access_token,
    ebayTokenExpiry: Date.now() + (data.expires_in - 300) * 1000
  });

  return data.access_token;
}

// Search sold items by scraping eBay's sold listings page (no API rate limits!)
async function searchSoldItems(token, query, grade, cardInfo, tier) {
  try {
    const params = new URLSearchParams({
      _nkw: query,
      LH_Complete: '1',
      LH_Sold: '1',
      _sop: '13',  // Sort: end date recent first
      _ipg: '60'
    });
    
    const url = `https://www.ebay.com/sch/i.html?${params}`;
    console.log(`[Slab Scout] Scraping sold listings: ${query}`);
    
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[Slab Scout] eBay search returned ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    // eBay uses two different HTML structures depending on layout
    // Newer: .s-card with su-styled-text spans
    // Older: .s-item with s-item__title, s-item__price
    const items = [];
    
    // Parse using regex — more reliable than DOMParser since eBay's HTML is quirky
    // Each listing starts with data-listingid=
    const listingBlocks = html.split(/(?=data-listingid=\d)/);
    
    for (const block of listingBlocks) {
      if (block.length < 100) continue;
      
      // Extract listing ID
      const idMatch = block.match(/data-listingid=(\d+)/);
      if (!idMatch) continue;
      
      // Extract title from alt tag or su-styled-text
      let title = '';
      const altMatch = block.match(/class=s-card__image[^>]*alt="([^"]+)"/);
      if (altMatch) {
        title = altMatch[1];
      } else {
        // Try su-styled-text primary
        const styledTexts = [...block.matchAll(/class="su-styled-text[^"]*primary[^"]*"[^>]*>([^<]+)</g)];
        for (const m of styledTexts) {
          const t = m[1].trim();
          if (t.length > 10 && t !== 'Shop on eBay') { title = t; break; }
        }
      }
      
      if (!title || title === 'Shop on eBay') continue;
      
      // Extract price (first dollar amount, skip shipping)
      const priceMatches = [...block.matchAll(/\$([\d,]+\.?\d*)/g)];
      let price = 0;
      if (priceMatches.length > 0) {
        price = parseFloat(priceMatches[0][1].replace(/,/g, ''));
      }
      if (price <= 0) continue;
      
      // Check if this is actually a sold item (look for "Sold" text)
      const isSold = /Sold\s+\w+\s+\d/i.test(block);
      
      // Extract sold date
      const dateMatch = block.match(/Sold\s+([\w]+\s+\d+,?\s*\d*)/i);
      const date = dateMatch ? dateMatch[1].trim() : '';
      
      // Extract URL
      const urlMatch = block.match(/href=(https:\/\/www\.ebay\.com\/itm\/\d+[^\s>'"]*)/);
      const url = urlMatch ? urlMatch[1].split('&')[0] : `https://www.ebay.com/itm/${idMatch[1]}`;
      
      // Extract image
      const imgMatch = block.match(/src=(https:\/\/i\.ebayimg\.com\/images\/[^\s>'"]+)/);
      const image = imgMatch ? imgMatch[1] : '';
      
      const titleUpper = title.toUpperCase();
      
      // Must contain PSA + grade number
      if (!/PSA\s*\d/i.test(title)) continue;
      if (grade && !titleUpper.includes(`PSA ${grade}`) && !titleUpper.includes(`PSA${grade}`)) continue;
      
      if (/\b(LOT|BUNDLE|REPRINT|REPO|CUSTOM|FANTASY)\b/i.test(title)) continue;
      
      if (tier <= 1 && cardInfo.playerName) {
        const nameParts = cardInfo.playerName.toUpperCase().split(/\s+/);
        const lastName = nameParts[nameParts.length - 1];
        if (!titleUpper.includes(lastName)) continue;
      }
      
      items.push({
        title,
        price,
        currency: 'USD',
        date,
        url,
        image,
        isSold
      });
    }
    
    console.log(`[Slab Scout] Scraped ${items.length} items (${items.filter(i => i.isSold).length} sold)`);
    return items;
  } catch (e) {
    console.warn('[Slab Scout] Scrape error:', e);
    return [];
  }
}

// Search active listings via Browse API (fallback)
async function searchActiveItems(token, query, grade, cardInfo, tier) {
  const params = new URLSearchParams({
    q: query,
    filter: [
      'buyingOptions:{FIXED_PRICE|AUCTION}',
      'priceCurrency:USD'
    ].join(','),
    sort: '-endDate',
    limit: '50'
  });

  const response = await fetch(
    `${EBAY_API_BASE}/buy/browse/v1/item_summary/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ChangeMe>'
      }
    }
  );

  if (!response.ok) return [];

  const data = await response.json();
  return (data.itemSummaries || [])
    .filter(item => {
      const title = item.title.toUpperCase();
      if (!/PSA\s*\d+/.test(title)) return false;
      if (grade && !title.includes(`PSA ${grade}`) && !title.includes(`PSA${grade}`)) return false;
      if (tier <= 1 && cardInfo.playerName) {
        const nameParts = cardInfo.playerName.toUpperCase().split(/\s+/);
        const lastName = nameParts[nameParts.length - 1];
        if (!title.includes(lastName)) return false;
      }
      if (/\b(LOT|BUNDLE|REPRINT|REPO|CUSTOM|FANTASY)\b/.test(title)) return false;
      return true;
    })
    .map(item => ({
      title: item.title,
      price: parseFloat(item.price?.value || 0),
      currency: item.price?.currency || 'USD',
      date: item.itemEndDate || item.itemCreationDate,
      url: item.itemWebUrl,
      image: item.thumbnailImages?.[0]?.imageUrl,
      isSold: false
    }))
    .filter(item => item.price > 0);
}

// Search eBay sold/completed listings for graded versions
// Strategy: ONE broad search per tier, then bucket results by grade client-side
async function searchGradedComps(cardInfo) {
  const token = await getEbayToken();
  const results = {};
  const grades = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  
  // Build tiered queries WITHOUT a specific grade (we'll filter by grade from results)
  const queries = buildBroadQueries(cardInfo);
  
  let allSoldItems = [];
  let allActiveItems = [];
  let usedTier = 0;
  
  // Try each query tier until we get decent results
  for (let tier = 0; tier < queries.length; tier++) {
    try {
      // One sold search
      const soldItems = await searchSoldItems(token, queries[tier], null, cardInfo, tier);
      console.log(`[Slab Scout] Tier ${tier} broad sold search: ${soldItems.length} items for "${queries[tier]}"`);
      
      if (soldItems.length >= 3) {
        allSoldItems = soldItems;
        usedTier = tier;
        break;
      }
      
      // Fallback: one active search
      if (tier === queries.length - 1 || soldItems.length === 0) {
        const activeItems = await searchActiveItems(token, queries[tier], null, cardInfo, tier);
        activeItems.forEach(i => i.isActive = true);
        console.log(`[Slab Scout] Tier ${tier} broad active search: ${activeItems.length} items`);
        
        if (soldItems.length + activeItems.length >= 3 || tier === queries.length - 1) {
          allSoldItems = soldItems;
          allActiveItems = activeItems;
          usedTier = tier;
          break;
        }
      }
    } catch (e) {
      console.error(`[Slab Scout] Tier ${tier} error:`, e);
    }
  }
  
  // Combine and bucket by grade
  const allItems = [...allSoldItems, ...allActiveItems];
  
  for (const grade of grades) {
    const gradeItems = allItems.filter(item => {
      const title = item.title.toUpperCase();
      return title.includes(`PSA ${grade}`) || title.includes(`PSA${grade}`);
    });
    
    if (gradeItems.length === 0) continue;
    
    // Remove outliers using IQR method
    const sorted = [...gradeItems].sort((a, b) => a.price - b.price);
    const q1 = sorted[Math.floor(sorted.length * 0.25)]?.price || sorted[0].price;
    const q3 = sorted[Math.floor(sorted.length * 0.75)]?.price || sorted[sorted.length - 1].price;
    const iqr = q3 - q1;
    const lowerBound = q1 - (iqr * 1.5);
    const upperBound = q3 + (iqr * 1.5);
    
    const filtered = gradeItems.filter(i => {
      if (gradeItems.length <= 3) return true;
      return i.price >= Math.max(lowerBound, 1) && i.price <= upperBound;
    }).slice(0, 5);
    
    if (filtered.length > 0) {
      const prices = filtered.map(i => i.price);
      const sortedPrices = [...prices].sort((a, b) => a - b);
      const median = sortedPrices.length % 2 === 0
        ? (sortedPrices[sortedPrices.length/2 - 1] + sortedPrices[sortedPrices.length/2]) / 2
        : sortedPrices[Math.floor(sortedPrices.length/2)];
      
      const hasActiveFallback = filtered.some(i => i.isActive);
      results[grade] = {
        items: filtered,
        low: Math.min(...prices),
        high: Math.max(...prices),
        avg: median,
        count: filtered.length,
        searchTier: usedTier,
        dataSource: hasActiveFallback ? 'active' : 'sold'
      };
    }
  }

  return results;
}

// Build broad search queries (no specific grade — we bucket from results)
function buildBroadQueries(cardInfo) {
  const queries = [];
  
  // Tier 0: Full specificity — name + year + set + card# + PSA
  {
    const parts = [];
    if (cardInfo.playerName) parts.push(`"${cardInfo.playerName}"`);
    if (cardInfo.year) parts.push(cardInfo.year);
    if (cardInfo.setName) parts.push(cardInfo.setName);
    if (cardInfo.cardNumber) parts.push(`#${cardInfo.cardNumber}`);
    parts.push('PSA');
    queries.push(parts.join(' '));
  }
  
  // Tier 1: Name + year + set + PSA (no card#)
  {
    const parts = [];
    if (cardInfo.playerName) parts.push(`"${cardInfo.playerName}"`);
    if (cardInfo.year) parts.push(cardInfo.year);
    if (cardInfo.setName) parts.push(cardInfo.setName);
    parts.push('PSA');
    const q = parts.join(' ');
    if (q !== queries[0]) queries.push(q);
  }
  
  // Tier 2: Name + year + PSA (no quotes)
  {
    const parts = [];
    if (cardInfo.playerName) parts.push(cardInfo.playerName);
    if (cardInfo.year) parts.push(cardInfo.year);
    parts.push('PSA');
    const q = parts.join(' ');
    if (!queries.includes(q)) queries.push(q);
  }
  
  // Tier 3: Just name + PSA (broadest)
  {
    const parts = [];
    if (cardInfo.playerName) parts.push(cardInfo.playerName);
    parts.push('PSA');
    const q = parts.join(' ');
    if (!queries.includes(q)) queries.push(q);
  }
  
  return queries;
}

// Parse card info from an eBay listing title
function parseCardTitle(title) {
  const info = { raw: title };
  
  // Extract year (4 digits, typically 1900-2029)
  const yearMatch = title.match(/\b(19[0-9]{2}|20[0-2][0-9])\b/);
  if (yearMatch) info.year = yearMatch[1];
  
  // Extract card number (various formats: #123, # 123, No. 123, Card 123)
  const numMatch = title.match(/(?:#\s*|No\.?\s*|Card\s+)(\d+[a-zA-Z]?)\b/i);
  if (numMatch) info.cardNumber = numMatch[1];
  
  // Common set/brand names — match ALL found, pick the most specific
  const sets = [
    // Multi-word sets first (more specific)
    'Topps Chrome', 'Topps Heritage', 'Topps Finest', 'Topps Update',
    'Topps Holiday', 'Topps Allen & Ginter', 'Topps Gypsy Queen',
    'Bowman Chrome', 'Bowman Draft', 'Bowman Sterling', 'Bowman 1st',
    'Upper Deck', 'SP Authentic', 'Star Co', 
    'National Treasures', 'Panini Prizm', 'Panini Select', 'Panini Mosaic',
    'Panini Optic', 'Panini Contenders', 'Panini Immaculate',
    'Fleer Ultra', 'Fleer Tradition',
    // Single-word brands
    'Topps', 'Bowman', 'Panini', 'Fleer', 'Donruss', 
    'Score', 'Prizm', 'Select', 'Mosaic', 'Optic', 'Chrome', 'Heritage',
    'Hoops', 'Skybox', 'Finest', 'Stadium Club', 'Leaf',
    'O-Pee-Chee', 'OPC'
  ];
  
  // Find the longest (most specific) matching set name
  let bestSet = '';
  for (const set of sets) {
    if (title.toLowerCase().includes(set.toLowerCase()) && set.length > bestSet.length) {
      bestSet = set;
    }
  }
  if (bestSet) info.setName = bestSet;
  
  // Extract card variants/parallels (important for pricing)
  const variants = [
    'Refractor', 'Gold', 'Silver', 'Blue', 'Red', 'Green', 'Orange', 'Purple', 'Pink', 'Black',
    'Shimmer', 'Wave', 'Holo', 'Holographic', 'Xfractor', 'Atomic',
    'Auto', 'Autograph', 'Patch', 'Jersey', 'Relic', 'Numbered', '/25', '/50', '/99', '/100', '/150', '/199', '/250', '/500',
    'Rookie', 'RC', '1st Bowman', 'Rated Rookie', 'RR'
  ];
  info.variants = [];
  for (const v of variants) {
    if (title.toLowerCase().includes(v.toLowerCase())) {
      info.variants.push(v);
    }
  }
  // Check for serial numbering (/XX)
  const serialMatch = title.match(/\/\s*(\d{1,4})\b/);
  if (serialMatch && !info.variants.some(v => v.startsWith('/'))) {
    info.variants.push(`/${serialMatch[1]}`);
  }
  
  // Extract player name more carefully
  // Strategy: remove known noise, year, set, card number, grading terms → what's left is the player name
  let cleaned = title
    .replace(/[-–—]/g, ' ')
    .replace(/\b(19|20)\d{2}(-\d{2})?\b/g, ' ')    // years
    .replace(/(?:#\s*|No\.?\s*|Card\s+)\d+[a-zA-Z]?\b/gi, ' ') // card numbers
    .replace(/\b(PSA|BGS|SGC|CGC)\s*\d*\b/gi, ' ')  // grading companies
    .replace(/\b(GEM\s*MINT?|MINT|NM|EX|VG|GOOD|FAIR|POOR|GMA|CGA)\b/gi, ' ')
    .replace(/\b(Raw|Ungraded|HOF|MVP|All.?Star|Pro.?Bowl|Rookie\s*Card)\b/gi, ' ')
    .replace(/\b(Card|Lot|Set|Pack|Box|Case|Wax|Sealed|Base|Insert|SP|SSP)\b/gi, ' ')
    .replace(/\b(Refractor|Holo|Holographic|Xfractor|Shimmer|Wave|Atomic|Prizm|Chrome|Auto|Autograph|Patch|Jersey|Relic)\b/gi, ' ')
    .replace(/\b(Gold|Silver|Blue|Red|Green|Orange|Purple|Pink|Black|Numbered)\b/gi, ' ')
    .replace(/\b(Rookie|RC|Break|Set.?Break|Basketball|Baseball|Football|Hockey|Soccer|Sport|Sports)\b/gi, ' ')
    .replace(/\b(Chicago|Bulls|Lakers|Yankees|Dodgers|Celtics|Giants|Mets|Red\s*Sox|Warriors|Nets|Heat)\b/gi, ' ') // team names
    .replace(/\/\s*\d+\b/g, ' ')  // serial numbers
    .replace(/\b[A-Z]{2,3}\d{2,4}\b/g, ' ') // codes like RC123
    .replace(/[^a-zA-Z\s'.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Remove set/brand names from cleaned string
  if (bestSet) {
    cleaned = cleaned.replace(new RegExp(bestSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ').trim();
  }
  // Remove common brand words that might remain
  cleaned = cleaned.replace(/\b(Topps|Bowman|Panini|Upper\s*Deck|Fleer|Donruss|Score|Star|Leaf|Hoops|Skybox|Stadium\s*Club|Finest|Heritage|Select|Mosaic|Optic|Contenders|Immaculate|O.?Pee.?Chee|OPC)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  
  // Filter out short noise words and emoji artifacts
  const words = cleaned.split(/\s+/).filter(w => w.length > 1 && /^[a-zA-Z'.]+$/.test(w));
  
  // Take first 2-3 words as player name
  if (words.length >= 2) {
    const nameLen = words.length >= 3 && /^(Jr|Sr|II|III|IV)$/i.test(words[2]) ? 3 : Math.min(words.length, 3);
    info.playerName = words.slice(0, nameLen).join(' ');
  } else if (words.length === 1) {
    info.playerName = words[0];
  }
  
  return info;
}

// Calculate profit scenarios with real costs
function calculateProfit(rawPrice, gradedComps, gradingFee = GRADING_FEES.regular, salesTaxRate = 0.08, ebayFeeRate = 0.15) {
  const scenarios = {};
  
  for (const [grade, data] of Object.entries(gradedComps)) {
    const avgGraded = data.avg;
    
    // Total cost: purchase + sales tax + grading fee
    const totalCost = (rawPrice * (1 + salesTaxRate)) + gradingFee;
    
    // Net revenue: sale price minus eBay fees (13.25% final value + payment processing ≈ 15%)
    const netRevenue = avgGraded * (1 - ebayFeeRate);
    
    const profit = netRevenue - totalCost;
    const roi = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    
    scenarios[grade] = {
      gradedAvg: avgGraded,
      gradedRange: `$${data.low.toLocaleString()} - $${data.high.toLocaleString()}`,
      totalCost: totalCost,
      netRevenue: netRevenue,
      profit: profit,
      roi: roi,
      verdict: profit > 0 ? '✅' : '❌'
    };
  }
  
  return scenarios;
}

// AI Title Parsing
async function aiParseTitle(title, apiKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      temperature: 0,
      messages: [{
        role: 'system',
        content: `Extract card details from an eBay listing title. Return JSON only:
{
  "playerName": "First Last" (or "First Last Jr." etc),
  "year": "YYYY" or null,
  "setName": "Brand Set" (e.g. "Topps Chrome", "Panini Prizm", "Star Co") or null,
  "cardNumber": "number" or null,
  "variants": ["Rookie", "RC", "Refractor", "Auto", "/99", etc] or []
}
Be precise. "1986 Star" set = "Star Co". Include parallel/insert names in variants. Card number without #.`
      }, {
        role: 'user',
        content: title
      }]
    })
  });

  if (!response.ok) throw new Error(`OpenAI: ${response.status}`);
  const data = await response.json();
  const content = data.choices[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');
  return JSON.parse(jsonMatch[0]);
}

// AI Card Grading via OpenAI Vision
async function aiGradeCard(imageUrls, cardInfo) {
  const config = await chrome.storage.sync.get(['openaiApiKey']);
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured. Click the Slab Scout icon to add it.');
  }

  // Build image content array (up to 4 images to keep costs down)
  const imageContent = imageUrls.slice(0, 4).map(url => ({
    type: 'image_url',
    image_url: { url, detail: 'high' }
  }));

  const cardDesc = [
    cardInfo.playerName,
    cardInfo.year,
    cardInfo.setName,
    cardInfo.cardNumber ? `#${cardInfo.cardNumber}` : ''
  ].filter(Boolean).join(' ');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 800,
      messages: [{
        role: 'system',
        content: `You are an expert PSA card grader. Analyze card images and estimate a PSA grade range. Be realistic and conservative — collectors trust accuracy over optimism.

Grade based on these PSA criteria:
- **Centering**: Measure left/right and top/bottom border ratios. PSA 10 needs 55/45 or better on front, 75/25 on back. PSA 9 needs 60/40 front, 90/10 back.
- **Corners**: Look for rounding, fraying, dinged corners, whitening. All 4 corners matter.
- **Edges**: Check for chipping, rough cuts, whitening along edges.
- **Surface**: Look for scratches, print lines, staining, wax marks, creases, indentations.

Respond in this exact JSON format:
{
  "grade_low": <number 1-10>,
  "grade_high": <number 1-10>,
  "grade_likely": <number 1-10, your best single estimate>,
  "confidence": "<low|medium|high>",
  "centering": { "score": "<off-center|slightly off|well-centered|gem>", "detail": "<brief note>" },
  "corners": { "score": "<worn|light wear|sharp|gem mint>", "detail": "<brief note>" },
  "edges": { "score": "<rough|light wear|clean|gem mint>", "detail": "<brief note>" },
  "surface": { "score": "<damaged|light issues|clean|gem mint>", "detail": "<brief note>" },
  "summary": "<one sentence overall assessment>"
}`
      }, {
        role: 'user',
        content: [
          { type: 'text', text: `Grade this raw card: ${cardDesc || 'Unknown card'}. Analyze the images for centering, corners, edges, and surface condition. Give me a PSA grade range estimate.` },
          ...imageContent
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content || '';
  
  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse AI grading response');
  
  return JSON.parse(jsonMatch[0]);
}

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_COMPS') {
    (async () => {
      try {
        const config = await chrome.storage.sync.get(['gradingFee', 'salesTaxRate', 'ebayFeeRate']);
        // Prefer listing's grading fee > user setting > default
        const fee = message.listingGradingFee || config.gradingFee || GRADING_FEES.regular;
        const feeSource = message.listingGradingFee ? 'listing' : 'settings';
        const salesTax = config.salesTaxRate ?? 0.08;
        const ebayFee = config.ebayFeeRate ?? 0.15;
        const comps = await searchGradedComps(message.cardInfo);
        const profit = calculateProfit(message.rawPrice, comps, fee, salesTax, ebayFee);
        sendResponse({ success: true, comps, profit, gradingFee: fee, feeSource, salesTaxRate: salesTax, ebayFeeRate: ebayFee });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // async response
  }
  
  if (message.type === 'PARSE_TITLE') {
    (async () => {
      // Try AI parsing first, fall back to regex
      const config = await chrome.storage.sync.get(['openaiApiKey']);
      if (config.openaiApiKey) {
        try {
          const aiParsed = await aiParseTitle(message.title, config.openaiApiKey);
          sendResponse({ success: true, cardInfo: { ...aiParsed, raw: message.title } });
          return;
        } catch (e) {
          console.warn('AI parse failed, falling back to regex:', e);
        }
      }
      const cardInfo = parseCardTitle(message.title);
      sendResponse({ success: true, cardInfo });
    })();
    return true;
  }

  if (message.type === 'AI_GRADE') {
    (async () => {
      try {
        const result = await aiGradeCard(message.imageUrls, message.cardInfo);
        sendResponse({ success: true, grading: result });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'CHECK_CONFIG') {
    (async () => {
      const config = await chrome.storage.sync.get(['ebayClientId', 'ebayClientSecret', 'openaiApiKey']);
      sendResponse({ 
        configured: !!(config.ebayClientId && config.ebayClientSecret),
        hasOpenAI: !!config.openaiApiKey
      });
    })();
    return true;
  }
});
