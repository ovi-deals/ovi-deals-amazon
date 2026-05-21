// analyze.js — Ovi Deals Amazon AU Daily Analysis
// Runs on GitHub Actions, saves results to Supabase

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const MARKETPLACE_ID = 'A39IBJ37TRP1C6'; // Amazon AU
const SP_API_HOST = 'https://sellingpartnerapi-fe.amazon.com';
const SELLER_NAME = 'ovi deals';

const {
  AMAZON_CLIENT_ID,
  AMAZON_CLIENT_SECRET,
  AMAZON_REFRESH_TOKEN,
  CLOUDFLARE_WORKER_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
} = process.env;

// Validate environment
const missing = ['AMAZON_CLIENT_ID','AMAZON_CLIENT_SECRET','AMAZON_REFRESH_TOKEN',
  'CLOUDFLARE_WORKER_URL','SUPABASE_URL','SUPABASE_SERVICE_KEY'].filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing secrets:', missing.join(', '));
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const resp = await fetch(`${CLOUDFLARE_WORKER_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: AMAZON_REFRESH_TOKEN,
      client_id: AMAZON_CLIENT_ID,
      client_secret: AMAZON_CLIENT_SECRET
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
  console.log('✓ Access token obtained');
  return data.access_token;
}

// ── SP-API proxy through Cloudflare Worker ────────────────────────────────────
async function spApiCall(token, path, params = {}) {
  const url = new URL(SP_API_HOST + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(CLOUDFLARE_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spapi: true, url: url.toString(), token })
  });
  if (!resp.ok) throw new Error(`SP-API error ${resp.status} on ${path}`);
  return resp.json();
}

async function spApiPost(token, path, body) {
  const resp = await fetch(CLOUDFLARE_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spapi: true, method: 'POST', url: SP_API_HOST + path, token, body })
  });
  if (!resp.ok) throw new Error(`SP-API POST error ${resp.status}`);
  return resp.json();
}

// ── Step 1: Get listings report ───────────────────────────────────────────────
async function fetchListingsReport(token) {
  console.log('Requesting listings report...');
  const reportAsins = [], activePrices = {}, activeSkus = {}, activeTitles = {}, activeQtys = {};

  try {
    const rr = await spApiPost(token, '/reports/2021-06-30/reports', {
      reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
      marketplaceIds: [MARKETPLACE_ID]
    });

    const reportId = rr.reportId;
    if (!reportId) throw new Error('No reportId returned');
    console.log('Report created:', reportId);

    // Poll up to 3 minutes
    let doc = null;
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await spApiCall(token, `/reports/2021-06-30/reports/${reportId}`);
      if (st.processingStatus === 'DONE') {
        doc = await spApiCall(token, `/reports/2021-06-30/documents/${st.reportDocumentId}`);
        console.log('Report ready');
        break;
      }
      if (st.processingStatus === 'FATAL') throw new Error('Report failed');
      if (i % 6 === 0) console.log(`Report ${st.processingStatus}... ${(i+1)*5}s`);
    }

    if (doc?.url) {
      // Download directly from S3 — Node.js handles gzip decompression natively
      console.log('Downloading report from S3...');
      const tr = await fetch(doc.url, {
        headers: { 'Accept-Encoding': 'gzip, deflate' }
      });

      // Get raw buffer and decompress if needed
      const buf = await tr.arrayBuffer();
      const bytes = new Uint8Array(buf);

      let tsv = '';
      // Check for gzip magic bytes (0x1f 0x8b)
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        console.log('Report is gzip compressed — decompressing...');
        const { gunzipSync } = await import('zlib');
        const decompressed = gunzipSync(Buffer.from(buf));
        tsv = decompressed.toString('utf-8');
      } else {
        tsv = new TextDecoder('utf-8').decode(bytes);
      }

      console.log(`Report downloaded: ${tsv.length} chars, starts with: ${tsv.slice(0, 60)}`);

      if (tsv.includes('\t')) {
        const lines = tsv.split('\n').filter(l => l.trim());
        if (lines.length > 1) {
          const hdrs = lines[0].split('\t').map(h => h.trim().toLowerCase());
          const ai = hdrs.findIndex(h => h.includes('asin'));
          const pi = hdrs.findIndex(h => h === 'price' || h.includes('your price'));
          const si = hdrs.findIndex(h => h === 'seller-sku' || h === 'sku');
          const sti = hdrs.findIndex(h => h.includes('status'));
          const ti = hdrs.findIndex(h => h === 'item-name' || h.includes('item name'));
          const qi = hdrs.findIndex(h => h === 'quantity' || h === 'available' || h.includes('quantity'));
          console.log(`Report headers: ASIN=${ai} Price=${pi} SKU=${si} Status=${sti} Title=${ti} Qty=${qi}`);
          console.log(`Header row: ${hdrs.slice(0,10).join(' | ')}`);

          for (let i = 1; i < lines.length; i++) {
            const c = lines[i].split('\t');
            const asin = c[ai]?.trim();
            if (!asin) continue;
            const status = sti >= 0 ? c[sti]?.trim().toLowerCase() : '';
            if (status && status !== 'active') continue;
            reportAsins.push(asin);
            const price = pi >= 0 ? parseFloat(c[pi]) || null : null;
            const sku = si >= 0 ? c[si]?.trim() : '';
            const title = ti >= 0 ? c[ti]?.trim() : '';
            const qty = qi >= 0 ? parseInt(c[qi]) : NaN;
            if (price) activePrices[asin] = price;
            if (sku) activeSkus[asin] = sku;
            if (title) activeTitles[asin] = title;
            if (!isNaN(qty) && qty >= 0) activeQtys[asin] = qty;
          }
          console.log(`✓ Report: ${reportAsins.length} listings, ${Object.keys(activeTitles).length} with titles`);
        }
      } else {
        console.log('Report does not contain tab-separated data — first 200 chars:', tsv.slice(0, 200));
      }
    }
  } catch (e) {
    console.log('Report error:', e.message);
  }

  // Fallback: if report gave 0 listings, try GET_FLAT_FILE_OPEN_LISTINGS_DATA report type
  if (reportAsins.length === 0) {
    console.log('Report gave 0 listings — trying alternative report type...');
    try {
      const rr2 = await spApiPost(token, '/reports/2021-06-30/reports', {
        reportType: 'GET_FLAT_FILE_OPEN_LISTINGS_DATA',
        marketplaceIds: [MARKETPLACE_ID]
      });
      const reportId2 = rr2.reportId;
      if (reportId2) {
        console.log('Alternative report created:', reportId2);
        let doc2 = null;
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const st = await spApiCall(token, `/reports/2021-06-30/reports/${reportId2}`);
          if (st.processingStatus === 'DONE') {
            doc2 = await spApiCall(token, `/reports/2021-06-30/documents/${st.reportDocumentId}`);
            break;
          }
          if (st.processingStatus === 'FATAL') break;
          if (i % 6 === 0) console.log(`Alt report ${st.processingStatus}... ${(i+1)*5}s`);
        }
        if (doc2?.url) {
          const tr2 = await fetch(doc2.url, { headers: { 'Accept-Encoding': 'gzip, deflate' } });
          const buf2 = await tr2.arrayBuffer();
          const bytes2 = new Uint8Array(buf2);
          let tsv2 = '';
          if (bytes2[0] === 0x1f && bytes2[1] === 0x8b) {
            const { gunzipSync } = await import('zlib');
            tsv2 = gunzipSync(Buffer.from(buf2)).toString('utf-8');
          } else {
            tsv2 = new TextDecoder('utf-8').decode(bytes2);
          }
          console.log(`Alt report: ${tsv2.length} chars, starts: ${tsv2.slice(0,80)}`);
          if (tsv2.includes('\t')) {
            const lines = tsv2.split('\n').filter(l => l.trim());
            const hdrs = lines[0].split('\t').map(h => h.trim().toLowerCase());
            const ai = hdrs.findIndex(h => h.includes('asin'));
            const pi = hdrs.findIndex(h => h.includes('price'));
            const si = hdrs.findIndex(h => h.includes('sku'));
            const ti = hdrs.findIndex(h => h.includes('item-name') || h.includes('item name'));
            for (let i = 1; i < lines.length; i++) {
              const c = lines[i].split('\t');
              const asin = c[ai]?.trim();
              if (!asin) continue;
              reportAsins.push(asin);
              const price = pi >= 0 ? parseFloat(c[pi]) || null : null;
              const sku = si >= 0 ? c[si]?.trim() : '';
              const title = ti >= 0 ? c[ti]?.trim() : '';
              if (price) activePrices[asin] = price;
              if (sku) activeSkus[asin] = sku;
              if (title) activeTitles[asin] = title;
            }
            console.log(`✓ Alt report: ${reportAsins.length} listings`);
          }
        }
      }
    } catch (e2) {
      console.log('Alt report error:', e2.message);
    }
  }

  return { reportAsins, activePrices, activeSkus, activeTitles, activeQtys };
}

// ── Step 2: Buy box + competitive pricing ─────────────────────────────────────
async function fetchPricingData(token, asins, activePrices, activeTitles, activeQtys, activeSkus) {
  console.log(`Fetching pricing for ${asins.length} products...`);
  const results = [];

  for (let idx = 0; idx < asins.length; idx++) {
    const asin = asins[idx];
    const title = activeTitles[asin] || asin;
    const yourPrice = activePrices[asin] || null;
    const amazonQty = activeQtys[asin] ?? null;

    if (idx > 0 && idx % 50 === 0) console.log(`Progress: ${idx}/${asins.length}...`);

    let buyBoxPrice = null, lowestOffer = null, isBuyBoxWinner = false;
    let competitorCount = 0, isOnlyOffer = false;

    // Competitive pricing API
    try {
      const d = await spApiCall(token, '/products/pricing/v0/competitivePrice', {
        Asin: asin, MarketplaceId: MARKETPLACE_ID, ItemType: 'Asin'
      });
      const cp = d.payload?.[0]?.Product?.CompetitivePricing;
      const bb = cp?.CompetitivePrices?.find(p => p.CompetitivePriceId === '1');
      const lo = cp?.CompetitivePrices?.find(p => p.CompetitivePriceId === '2');
      buyBoxPrice = bb?.Price?.LandedPrice?.Amount || bb?.Price?.ListingPrice?.Amount || null;
      lowestOffer = lo?.Price?.LandedPrice?.Amount || null;
      isBuyBoxWinner = bb?.belongsToRequester || false;
      const totalSellers = cp?.NumberOfOfferListings?.reduce((s, o) => s + (parseInt(o.Count) || 0), 0) || 0;
      competitorCount = Math.max(0, totalSellers - 1);
      isOnlyOffer = totalSellers <= 1;
    } catch {}

    // Item Offers API for accurate competitor count + seller identification
    try {
      const offData = await spApiCall(token, `/products/pricing/v0/items/${asin}/offers`, {
        MarketplaceId: MARKETPLACE_ID, ItemCondition: 'New', CustomerType: 'Consumer'
      });
      const offers = offData.payload?.Offers || [];
      const totalOffers = offers.length;

      if (totalOffers > 0) {
        const MY_SELLER_ID = 'A3HU5LWFBPZMQE'; // Ovi Deals seller ID
        const ourOffer = offers.find(o => {
          if (o.MyOffer === true) return true;
          if (o.SellerId === MY_SELLER_ID) return true;
          const name = (o.SellerFeedbackRating?.SellerDisplayName || o.SellerName || '').toLowerCase();
          return name.includes(SELLER_NAME);
        });

        competitorCount = ourOffer ? totalOffers - 1 : totalOffers;
        isOnlyOffer = totalOffers === 1 && !!ourOffer;

        const bbOffer = offers.find(o => o.IsBuyBoxWinner === true);
        if (ourOffer?.IsBuyBoxWinner === true) isBuyBoxWinner = true;
        if (ourOffer?.SellerId === MY_SELLER_ID && ourOffer?.IsBuyBoxWinner) isBuyBoxWinner = true;
        if (bbOffer) {
          if (bbOffer.SellerId === MY_SELLER_ID) isBuyBoxWinner = true;
          const bbName = (bbOffer.SellerFeedbackRating?.SellerDisplayName || bbOffer.SellerName || '').toLowerCase();
          if (bbName.includes(SELLER_NAME)) isBuyBoxWinner = true;
        }
        if (isOnlyOffer) isBuyBoxWinner = true;

        const competitorOffers = offers.filter(o => o !== ourOffer)
          .sort((a, b) => (a.ListingPrice?.Amount || 999) - (b.ListingPrice?.Amount || 999));

        if (isBuyBoxWinner && ourOffer) buyBoxPrice = ourOffer.ListingPrice?.Amount || buyBoxPrice;
        else if (!isBuyBoxWinner && bbOffer) buyBoxPrice = bbOffer.ListingPrice?.Amount || buyBoxPrice;
        if (competitorOffers.length > 0 && !lowestOffer) lowestOffer = competitorOffers[0].ListingPrice?.Amount || null;
      }
    } catch {}

    // Sole seller always wins
    if (isOnlyOffer) isBuyBoxWinner = true;

    results.push({
      asin, title, yourPrice, buyBoxPrice, lowestOffer,
      isBuyBoxWinner, competitorCount, isOnlyOffer,
      amazonQty, sku: activeSkus[asin] || null
    });

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

// ── Save to Supabase ──────────────────────────────────────────────────────────
async function saveToSupabase(results) {
  const wins = results.filter(d => d.isBuyBoxWinner || d.isOnlyOffer).length;
  const lost = results.filter(d => !d.isBuyBoxWinner && !d.isOnlyOffer && d.buyBoxPrice !== null).length;
  const solos = results.filter(d => d.isOnlyOffer).length;
  const zeroStock = results.filter(d => d.amazonQty === 0).length;
  const lowStock = results.filter(d => d.amazonQty !== null && d.amazonQty > 0 && d.amazonQty <= 10).length;

  const summary = {
    total: results.length,
    buyBoxWins: wins,
    buyBoxLost: lost,
    soleseller: solos,
    zeroStock,
    lowStock,
    winRate: results.length ? Math.round(wins / results.length * 100) : 0
  };

  const { error } = await supabase
    .from('amazon_analysis')
    .insert({
      run_date: new Date().toISOString().split('T')[0],
      run_time: new Date().toISOString(),
      data: results,
      summary
    });

  if (error) throw new Error('Supabase insert failed: ' + error.message);
  console.log('✓ Saved to Supabase:', summary);
  return summary;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Ovi Deals Amazon AU Analysis ===');
  console.log('Started:', new Date().toISOString());

  try {
    const token = await getAccessToken();

    // Step 1: Get listings
    const { reportAsins, activePrices, activeSkus, activeTitles, activeQtys } =
      await fetchListingsReport(token);

    if (reportAsins.length === 0) {
      throw new Error('No listings found from report or alternative report. Check SP-API permissions for Reports role.');
    }

    const uniqueAsins = [...new Set(reportAsins)].filter(Boolean);
    console.log(`Total unique ASINs: ${uniqueAsins.length}`);

    // Step 2: Get pricing and buy box data
    const results = await fetchPricingData(
      token, uniqueAsins, activePrices, activeTitles, activeQtys, activeSkus
    );

    // Step 3: Save to Supabase
    const summary = await saveToSupabase(results);

    console.log('=== Analysis Complete ===');
    console.log(`✓ ${summary.total} products`);
    console.log(`✓ Buy box wins: ${summary.buyBoxWins} (${summary.winRate}%)`);
    console.log(`✓ Buy box lost: ${summary.buyBoxLost}`);
    console.log(`✓ Zero stock: ${summary.zeroStock}`);
    console.log(`✓ Low stock: ${summary.lowStock}`);

  } catch (err) {
    console.error('Analysis failed:', err.message);
    process.exit(1);
  }
}

main();
