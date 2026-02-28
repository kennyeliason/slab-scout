# 🔍 Slab Scout

**Know the grading gap before you buy.**

A Chrome extension that shows PSA graded card comps while browsing raw card listings on eBay. Instantly see what a raw card could be worth graded — and whether it's worth the investment.

## Features

- 🃏 Auto-detects card details from eBay listing titles
- 📊 Shows last 5 sold comps for PSA grades 1-10
- 💰 Calculates profit/loss after grading fees
- 🏆 Highlights the best grading opportunity
- 🖱️ Draggable overlay — move it anywhere on the page
- ⚡ Fast — uses eBay's Browse API for real-time data

## Setup

### 1. Get eBay API Credentials
1. Go to [developer.ebay.com](https://developer.ebay.com/my/keys)
2. Sign in or create a developer account
3. Create a new **Production** application
4. Copy your **Client ID** (App ID) and **Client Secret** (Cert ID)

### 2. Install the Extension
1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `slab-scout` folder

### 3. Configure
1. Click the Slab Scout icon in your Chrome toolbar
2. Enter your eBay Client ID and Client Secret
3. Click **Save Credentials**

### 4. Use It
1. Browse to any raw card listing on eBay
2. Slab Scout panel appears automatically
3. See graded comps and profit potential instantly

## How Profit Is Calculated

```
Profit = Average Graded Sold Price - Raw Card Price - PSA Grading Fee ($150)
```

Default grading fee is PSA Regular ($150). The extension shows comps for all grades where sold data exists.

## Built By

Kenny Eliason

## License

Personal use.
