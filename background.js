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

// Search eBay sold/completed listings for graded versions
async function searchGradedComps(cardInfo) {
  const token = await getEbayToken();
  const results = {};
  
  // Search for each PSA grade 1-10
  const grades = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  
  for (const grade of grades) {
    const query = buildGradedQuery(cardInfo, grade);
    
    try {
      const params = new URLSearchParams({
        q: query,
        filter: [
          'buyingOptions:{FIXED_PRICE|AUCTION}',
          'conditionIds:{2750}', // Used for graded cards
          'priceCurrency:USD'
        ].join(','),
        sort: '-endDate',
        limit: '5'
      });

      // Use Browse API - item_summary/search with COMPLETED filter
      const response = await fetch(
        `${EBAY_API_BASE}/buy/browse/v1/item_summary/search?${params}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ChangeMe>'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        const items = (data.itemSummaries || [])
          .filter(item => {
            const title = item.title.toUpperCase();
            return title.includes(`PSA ${grade}`) || title.includes(`PSA${grade}`);
          })
          .slice(0, 5)
          .map(item => ({
            title: item.title,
            price: parseFloat(item.price?.value || 0),
            currency: item.price?.currency || 'USD',
            date: item.itemEndDate || item.itemCreationDate,
            url: item.itemWebUrl,
            image: item.thumbnailImages?.[0]?.imageUrl
          }));
        
        if (items.length > 0) {
          const prices = items.map(i => i.price);
          results[grade] = {
            items,
            low: Math.min(...prices),
            high: Math.max(...prices),
            avg: prices.reduce((a, b) => a + b, 0) / prices.length,
            count: items.length
          };
        }
      }
    } catch (e) {
      console.error(`Error fetching PSA ${grade} comps:`, e);
    }
  }

  return results;
}

// Build search query for a specific grade
function buildGradedQuery(cardInfo, grade) {
  const parts = [];
  if (cardInfo.playerName) parts.push(cardInfo.playerName);
  if (cardInfo.year) parts.push(cardInfo.year);
  if (cardInfo.setName) parts.push(cardInfo.setName);
  if (cardInfo.cardNumber) parts.push(`#${cardInfo.cardNumber}`);
  parts.push(`PSA ${grade}`);
  return parts.join(' ');
}

// Parse card info from an eBay listing title
function parseCardTitle(title) {
  const info = { raw: title };
  
  // Extract year (4 digits, typically 1900-2029)
  const yearMatch = title.match(/\b(19[0-9]{2}|20[0-2][0-9])\b/);
  if (yearMatch) info.year = yearMatch[1];
  
  // Extract card number
  const numMatch = title.match(/#\s*(\d+)/);
  if (numMatch) info.cardNumber = numMatch[1];
  
  // Common set names
  const sets = [
    'Topps', 'Bowman', 'Panini', 'Upper Deck', 'Fleer', 'Donruss', 
    'Score', 'Prizm', 'Select', 'Mosaic', 'Optic', 'Chrome', 'Heritage',
    'Star', 'Star Co', 'Hoops', 'Skybox', 'SP Authentic', 'Finest',
    'National Treasures', 'Immaculate', 'Contenders', 'Playoff',
    'Rookie', 'RC', 'Refractor', 'Auto', 'Patch', 'Numbered'
  ];
  
  for (const set of sets) {
    if (title.toLowerCase().includes(set.toLowerCase())) {
      info.setName = set;
      break;
    }
  }
  
  // Try to extract player name (usually first major words before year/set)
  // Remove common non-name words
  let cleaned = title
    .replace(/\b(19|20)\d{2}\b/, '')
    .replace(/#\d+/, '')
    .replace(/\b(PSA|BGS|SGC|CGC|Raw|Mint|NM|EX|VG|Good|Fair|Poor)\b/gi, '')
    .replace(/\b(Card|Lot|Set|Pack|Box|Case|Wax|Sealed)\b/gi, '')
    .replace(/[^a-zA-Z\s'-]/g, ' ')
    .trim();
  
  // Take first 2-3 words as likely player name
  const words = cleaned.split(/\s+/).filter(w => w.length > 1);
  if (words.length >= 2) {
    info.playerName = words.slice(0, 3).join(' ');
  }
  
  return info;
}

// Calculate profit scenarios
function calculateProfit(rawPrice, gradedComps, gradingFee = GRADING_FEES.regular) {
  const scenarios = {};
  
  for (const [grade, data] of Object.entries(gradedComps)) {
    const avgGraded = data.avg;
    const profit = avgGraded - rawPrice - gradingFee;
    const roi = rawPrice > 0 ? (profit / (rawPrice + gradingFee)) * 100 : 0;
    
    scenarios[grade] = {
      gradedAvg: avgGraded,
      gradedRange: `$${data.low.toLocaleString()} - $${data.high.toLocaleString()}`,
      profit: profit,
      roi: roi,
      verdict: profit > 0 ? '✅' : '❌'
    };
  }
  
  return scenarios;
}

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_COMPS') {
    (async () => {
      try {
        const config = await chrome.storage.sync.get(['gradingFee']);
        const fee = config.gradingFee || GRADING_FEES.regular;
        const comps = await searchGradedComps(message.cardInfo);
        const profit = calculateProfit(message.rawPrice, comps, fee);
        sendResponse({ success: true, comps, profit, gradingFee: fee });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // async response
  }
  
  if (message.type === 'PARSE_TITLE') {
    const cardInfo = parseCardTitle(message.title);
    sendResponse({ success: true, cardInfo });
    return false;
  }

  if (message.type === 'CHECK_CONFIG') {
    (async () => {
      const config = await chrome.storage.sync.get(['ebayClientId', 'ebayClientSecret']);
      sendResponse({ 
        configured: !!(config.ebayClientId && config.ebayClientSecret) 
      });
    })();
    return true;
  }
});
