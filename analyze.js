// analyze.js — Ovi Deals Amazon AU Daily Analysis
// Runs on GitHub Actions, saves results to Supabase

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const MARKETPLACE_ID = 'A39IBJ37TRP1C6'; // Amazon AU
const SP_API_HOST = 'https://sellingpartnerapi-fe.amazon.com';
const SELLER_NAME = 'ovi deals';
const MY_SELLER_ID = 'A3HU5LWFBPZMQE';

const {
  AMAZON_CLIENT_ID,
  AMAZON_CLIENT_SECRET,
  AMAZON_REFRESH_TOKEN,
  CLOUDFLARE_WORKER_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  MS_TENANT_ID,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_USER_EMAIL
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
  const reportAsins = [], activePrices = {}, activeSkus = {}, activeAllSkus = {}, activeTitles = {}, activeQtys = {}, activeStatuses = {};

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
            // Include ALL listings — active, inactive, zero stock everything
            const status = sti >= 0 ? c[sti]?.trim() : '';
            reportAsins.push(asin);
            const price = pi >= 0 ? parseFloat(c[pi]) || null : null;
            const sku = si >= 0 ? c[si]?.trim() : '';
            const title = ti >= 0 ? c[ti]?.trim() : '';
            const qty = qi >= 0 ? parseInt(c[qi]) : NaN;
            if (price && !activePrices[asin]) activePrices[asin] = price; // keep first price
            if (sku) {
              activeSkus[asin] = sku; // keep last SKU for single lookup
              if (!activeAllSkus[asin]) activeAllSkus[asin] = [];
              if (!activeAllSkus[asin].includes(sku)) activeAllSkus[asin].push(sku);
            }
            if (title && !activeTitles[asin]) activeTitles[asin] = title; // keep first title
            // Sum quantities across all SKUs for same ASIN
            if (!isNaN(qty) && qty >= 0) {
              activeQtys[asin] = (activeQtys[asin] || 0) + qty;
            }
            if (status) activeStatuses[asin] = status;
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

  return { reportAsins, activePrices, activeSkus, activeAllSkus, activeTitles, activeQtys, activeStatuses };
}

// ── Step 2: Fetch FBM quantities from Listings Items API ─────────────────────
async function fetchFBMQuantities(token, asins, activeAllSkus) {
  console.log(`Fetching FBM quantities for ${asins.length} products...`);
  const qtyMap = {};
  const MY_SELLER_ID = 'A3HU5LWFBPZMQE';

  for (let idx = 0; idx < asins.length; idx++) {
    const asin = asins[idx];
    // Get ALL skus for this ASIN (may be array or single string)
    const skus = Array.isArray(activeAllSkus[asin])
      ? activeAllSkus[asin]
      : (activeAllSkus[asin] ? [activeAllSkus[asin]] : []);
    if (!skus.length) continue;

    let totalQty = 0;
    let foundAny = false;

    for (const sku of skus) {
      try {
        const d = await spApiCall(token, `/listings/2021-08-01/items/${MY_SELLER_ID}/${encodeURIComponent(sku)}`, {
          marketplaceIds: MARKETPLACE_ID,
          includedData: 'attributes,fulfillmentAvailability'
        });

        // Amazon returns: fulfillmentAvailability: [{"fulfillmentChannelCode":"DEFAULT","quantity":N}]
        const fa = d.fulfillmentAvailability;
        if (Array.isArray(fa) && fa.length > 0) {
          const fbm = fa.find(f => f.fulfillmentChannelCode === 'DEFAULT') || fa[0];
          const qty = fbm.quantity;
          if (qty !== undefined && qty !== null) {
            totalQty += parseInt(qty);
            foundAny = true;
          }
        }

        // Fallback: attributes
        if (!foundAny) {
          const attrFa = d.attributes?.fulfillment_availability;
          if (Array.isArray(attrFa) && attrFa.length > 0) {
            const fbm = attrFa.find(f => f.fulfillment_channel_code === 'DEFAULT') || attrFa[0];
            const qty = fbm?.quantity;
            if (qty !== undefined && qty !== null) {
              totalQty += parseInt(qty);
              foundAny = true;
            }
          }
        }

        await new Promise(r => setTimeout(r, 80));
      } catch (e) { /* silent */ }
    }

    if (foundAny) {
      qtyMap[asin] = totalQty;
      if (skus.length > 1) console.log(`  Multi-SKU ${asin}: ${skus.length} SKUs → total qty ${totalQty}`);
    }

    if (idx > 0 && idx % 100 === 0) console.log(`Qty fetch: ${idx}/${asins.length}...`);
    await new Promise(r => setTimeout(r, 80));
  }

  const found = Object.keys(qtyMap).length;
  const zeros = Object.values(qtyMap).filter(q => q === 0).length;
  console.log(`✓ FBM quantities: ${found}/${asins.length} — Zero: ${zeros}, With stock: ${found - zeros}`);
  const samples = Object.entries(qtyMap).slice(0, 5);
  samples.forEach(([asin, qty]) => console.log(`  ${asin}: ${qty}`));
  return qtyMap;
}

// ── Step 4b: Fetch product catalog data for model number matching ─────────────
async function fetchProductCatalogData(token, asins) {
  console.log(`Fetching catalog model numbers for ${asins.length} products...`);
  const catalogMap = {}; // asin → { modelNumbers: [], description: '' }

  for (let idx = 0; idx < asins.length; idx++) {
    const asin = asins[idx];
    try {
      const d = await spApiCall(token, `/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: MARKETPLACE_ID,
        includedData: 'attributes,summaries,images'
      });

      const attrs = d.attributes || {};

      // Extract all possible model/part number fields Amazon stores
      const modelNumbers = [];

      const addAttr = key => {
        const val = attrs[key];
        if (!val) return;
        const arr = Array.isArray(val) ? val : [val];
        arr.forEach(v => {
          const s = String(v?.value || v || '').trim();
          if (!s || s.length < 3) return;
          const norm = s.toUpperCase().replace(/[\s\-_]/g,'');
          // Filter out ASINs (10 chars starting with B0), generic words, and numbers-only
          if (/^B0[A-Z0-9]{8}$/.test(norm)) return; // looks like ASIN
          if (/^\d+$/.test(norm)) return; // numbers only
          if (['NEW','USED','STANDARD','DEFAULT','NA','N/A','NONE','NULL'].includes(norm)) return;
          modelNumbers.push(norm);
        });
      };

      addAttr('model_number');
      addAttr('part_number');
      addAttr('manufacturer_part_number');
      addAttr('model_name');
      addAttr('item_model_number');
      addAttr('mpn');
      addAttr('style_name');

      // Grab description text
      const bullets = attrs.bullet_point?.map(b => b.value).filter(Boolean) || [];
      const desc = attrs.product_description?.[0]?.value || '';
      const descText = [desc, ...bullets].join(' ');

      // Grab image URLs for vision fallback
      const images = d.images?.[0]?.images || [];
      const imageUrls = images
        .filter(img => ['MAIN','PT01','PT02'].includes(img.variant))
        .map(img => img.link).filter(Boolean).slice(0, 2);

      if (modelNumbers.length > 0 || descText || imageUrls.length > 0) {
        catalogMap[asin] = { modelNumbers: [...new Set(modelNumbers)], descText, imageUrls };
      }
    } catch {}

    if (idx > 0 && idx % 50 === 0) console.log(`Catalog fetch: ${idx}/${asins.length}...`);
    await new Promise(r => setTimeout(r, 150));
  }

  const withModels = Object.values(catalogMap).filter(c => c.modelNumbers.length > 0).length;
  console.log(`✓ Catalog data: ${Object.keys(catalogMap).length} products, ${withModels} have model numbers`);
  return catalogMap;
}

// ── Tier 6: Claude vision — extract model from product images ─────────────────
async function extractModelFromImages(imageUrls, candidateModels) {
  if (!imageUrls || imageUrls.length === 0 || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const imageContent = await Promise.all(imageUrls.slice(0, 2).map(async url => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const b64 = Buffer.from(buf).toString('base64');
        const ct = resp.headers.get('content-type') || 'image/jpeg';
        return { type: 'image', source: { type: 'base64', media_type: ct, data: b64 } };
      } catch { return null; }
    }));
    const validImages = imageContent.filter(Boolean);
    if (!validImages.length) return null;
    const modelList = candidateModels.slice(0, 30).join(', ');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: [
            ...validImages,
            { type: 'text', text: `Does any of these model numbers appear on this product, packaging or label: ${modelList}\n\nReply with ONLY the matching model number, or "NONE". No other text.` }
          ]
        }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const result = data.content?.[0]?.text?.trim();
    if (result && result !== 'NONE' && result.length >= 2) {
      return result.toUpperCase().replace(/[\s\-_]/g, '');
    }
    return null;
  } catch { return null; }
}

async function fetchPricingData(token, asins, activePrices, activeTitles, activeQtys, activeSkus, fbmQtys, activeStatuses) {
  console.log(`Fetching pricing for ${asins.length} products...`);
  // Debug: log qty values for first 5 ASINs
  asins.slice(0,5).forEach(a => console.log(`  QTY DEBUG ${a}: fbmQtys=${fbmQtys[a]} activeQtys=${activeQtys[a]} → final=${fbmQtys[a]!==undefined?fbmQtys[a]:(activeQtys[a]??null)}`));
  const results = [];

  for (let idx = 0; idx < asins.length; idx++) {
    const asin = asins[idx];
    const title = activeTitles[asin] || asin;
    const yourPrice = activePrices[asin] || null;
    // Use FBM qty first, fall back to report qty
    const amazonQty = fbmQtys[asin] !== undefined ? fbmQtys[asin] : (activeQtys[asin] ?? null);

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
      amazonQty, sku: activeSkus[asin] || null,
      listingStatus: activeStatuses[asin] || 'Active'
    });

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

// ── Save to Supabase ──────────────────────────────────────────────────────────
async function saveToSupabase(results, hasExcel = false, excelMatched = 0) {
  const wins = results.filter(d => d.isBuyBoxWinner || d.isOnlyOffer).length;
  const lost = results.filter(d => !d.isBuyBoxWinner && !d.isOnlyOffer && d.buyBoxPrice !== null).length;
  const solos = results.filter(d => d.isOnlyOffer).length;
  const zeroStock = results.filter(d => d.amazonQty === 0).length;
  const lowStock = results.filter(d => d.amazonQty !== null && d.amazonQty > 0 && d.amazonQty <= 10).length;
  const profitCount = results.filter(d => d.profit !== null).length;
  const lossCount = results.filter(d => d.profit !== null && d.profit < 0).length;

  const summary = {
    total: results.length,
    buyBoxWins: wins,
    buyBoxLost: lost,
    soleseller: solos,
    zeroStock,
    lowStock,
    winRate: results.length ? Math.round(wins / results.length * 100) : 0,
    hasExcel,
    excelMatched,
    profitCount,
    lossCount
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

// ── Microsoft Graph — Fetch Excel from Outlook ────────────────────────────────
async function getMSAccessToken() {
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    console.log('⚠ MS credentials not set — skipping Excel fetch from email');
    return null;
  }
  const resp = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default'
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('MS auth failed: ' + JSON.stringify(data));
  console.log('✓ Microsoft Graph token obtained');
  return data.access_token;
}

async function fetchExcelFromOutlook() {
  try {
    const msToken = await getMSAccessToken();
    if (!msToken) return null;

    const userEmail = MS_USER_EMAIL;
    console.log(`Searching Outlook for "Stock List" email for ${userEmail}...`);

    // First test - check if we can access the mailbox at all
    const testResp = await fetch(`https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/inbox`, {
      headers: { 'Authorization': `Bearer ${msToken}` }
    });
    const testData = await testResp.json();
    if (!testResp.ok) {
      console.log('⚠ Cannot access mailbox:', JSON.stringify(testData));
      return null;
    }
    console.log(`✓ Mailbox accessible. Inbox has ${testData.totalItemCount} total items`);

    // Use $search with case-insensitive subject match
    // Note: Graph API $search is case insensitive by default
    const searchUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages?` +
      `$search="subject:Stock list"` +
      `&$top=5&$select=id,subject,receivedDateTime,hasAttachments`;

    const msgResp = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${msToken}`,
        'ConsistencyLevel': 'eventual'
      }
    });
    const msgData = await msgResp.json();
    console.log(`Email search result: ${msgData.value?.length || 0} emails found`);

    if (msgData.value?.length > 0) {
      msgData.value.forEach(m => console.log(`  - "${m.subject}" received ${m.receivedDateTime} hasAttachments=${m.hasAttachments}`));
    } else {
      console.log('Search response:', JSON.stringify(msgData).slice(0, 300));

      // Try searching all mail folders including shared mailboxes
      console.log('Trying search across all folders...');
      const allFoldersUrl = `https://graph.microsoft.com/v1.0/users/${userEmail}/messages?` +
        `$search="subject:Stock"&$top=10&$select=id,subject,receivedDateTime,hasAttachments`;
      const allResp = await fetch(allFoldersUrl, {
        headers: { 'Authorization': `Bearer ${msToken}`, 'ConsistencyLevel': 'eventual' }
      });
      const allData = await allResp.json();
      console.log(`Broader search found: ${allData.value?.length || 0} emails`);
      allData.value?.forEach(m => console.log(`  - "${m.subject}" ${m.receivedDateTime} attach=${m.hasAttachments}`));

      // Also try the ORAA Sales shared mailbox directly if different from user email
      const sharedEmail = 'sales@oraa.au';
      if (sharedEmail !== userEmail) {
        console.log(`Trying shared mailbox: ${sharedEmail}...`);
        const sharedUrl = `https://graph.microsoft.com/v1.0/users/${sharedEmail}/messages?` +
          `$search="subject:Stock"&$top=5&$select=id,subject,receivedDateTime,hasAttachments`;
        try {
          const sharedResp = await fetch(sharedUrl, {
            headers: { 'Authorization': `Bearer ${msToken}`, 'ConsistencyLevel': 'eventual' }
          });
          const sharedData = await sharedResp.json();
          console.log(`Shared mailbox found: ${sharedData.value?.length || 0} emails`);
          sharedData.value?.forEach(m => console.log(`  - "${m.subject}" ${m.receivedDateTime}`));
          // If found in shared mailbox, use those results
          if (sharedData.value?.length > 0) {
            msgData.value = sharedData.value;
          }
        } catch(e) { console.log('Shared mailbox access error:', e.message); }
      }
    }

    if (!msgData.value || msgData.value.length === 0) {
      console.log('⚠ No "Stock list" email found');
      return null;
    }

    // Sort by date descending and find one with attachment
    const sorted = msgData.value.sort((a,b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    const msg = sorted.find(m => m.hasAttachments) || sorted[0];
    console.log(`Found email: "${msg.subject}" received ${msg.receivedDateTime}`);

    // Get attachments
    const attResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${msg.id}/attachments`,
      { headers: { 'Authorization': `Bearer ${msToken}` } }
    );
    const attData = await attResp.json();

    // Find Excel attachment
    const excelAtt = attData.value?.find(a =>
      a.name?.match(/\.(xlsx|xls|csv)$/i) ||
      a.contentType?.includes('spreadsheet') ||
      a.contentType?.includes('excel')
    );

    if (!excelAtt) {
      console.log('⚠ No Excel attachment found in Stock List email');
      return null;
    }

    console.log(`✓ Found attachment: ${excelAtt.name} (${Math.round(excelAtt.size/1024)}KB)`);

    // Decode base64 content
    const fileBuffer = Buffer.from(excelAtt.contentBytes, 'base64');

    // Parse Excel
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    console.log(`✓ Excel parsed: ${rows.length} rows, ${workbook.SheetNames[0]} sheet`);
    if (rows.length > 0) {
      console.log(`  Columns: ${Object.keys(rows[0]).join(', ')}`);
    }

    return rows;
  } catch (e) {
    console.log('⚠ Excel fetch error:', e.message);
    return null;
  }
}

function parseExcelData(rows) {
  if (!rows || rows.length === 0) return { barcodeMap: {}, skuMap: {}, modelMap: {} };

  const sample = rows[0];
  const keys = Object.keys(sample);

  const findCol = (...names) => keys.find(k =>
    names.some(n => k.toLowerCase().includes(n.toLowerCase()))
  );

  const barcodeCol  = findCol('barcode','ean','upc','gtin','isbn');
  const qtyCol      = findCol('quantity on hand','qty on hand','quantity','qty','stock','available');
  const priceCol    = findCol('sales price','sale price','price','cost');
  const skuCol      = findCol('sku','item code','product code','code');
  const nameCol     = findCol('name','description','product','title','item');
  const modelCol    = findCol('internal reference','model number','model no','model','reference','ref','part number','part no','mpn');

  console.log(`Excel columns: barcode=${barcodeCol} qty=${qtyCol} price=${priceCol} sku=${skuCol} name=${nameCol} model=${modelCol}`);
  if (!modelCol) console.log('⚠ No "Internal Reference" column found — model matching disabled');

  const barcodeMap = {}; // barcode → data
  const skuMap     = {}; // sku → data
  const modelMap   = {}; // model number → data (for internal reference matching)

  for (const row of rows) {
    const barcode     = String(row[barcodeCol] || '').trim().replace(/\D/g, '');
    const sku         = String(row[skuCol]     || '').trim();
    const qty         = parseInt(row[qtyCol])  || 0;
    const salesPrice  = parseFloat(row[priceCol]) || null;
    const name        = String(row[nameCol]    || '').trim();
    const model       = modelCol ? String(row[modelCol] || '').trim() : '';

    const data = { qty, salesPrice, sku, name, barcode, model };

    if (barcode && barcode.length >= 8) {
      barcodeMap[barcode] = data;
    }
    if (sku) {
      skuMap[sku] = data;
    }
    // Store model number for lookup — normalised to uppercase, no spaces/brackets
    if (model && model.length >= 3) {
      // Strip square brackets e.g. [CIF24G] → CIF24G
      const cleanModel = model.replace(/[\[\](){}]/g, '').trim();
      const normModel = cleanModel.toUpperCase().replace(/[\s\-_]/g, '');
      // Skip generic words that aren't real model numbers
      const genericWords = ['HANDLE','LID','BASE','BODY','PART','PIECE','SET','KIT',
        'ACCESSORY','ACCESSORIES','SPARE','SPARES','UNIT','ITEM','PRODUCT','GENERIC'];
      if (normModel.length >= 4 && !genericWords.includes(normModel)) {
        modelMap[normModel] = data;
        // Also store with brackets stripped version as key
        if (cleanModel !== model) {
          modelMap[cleanModel.toUpperCase().replace(/[\s\-_]/g,'')] = data;
        }
      }
    }
  }

  console.log(`✓ Excel parsed: ${Object.keys(barcodeMap).length} barcodes, ${Object.keys(modelMap).length} model numbers`);
  return { barcodeMap, skuMap, modelMap };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Ovi Deals Amazon AU Analysis ===');
  console.log('Started:', new Date().toISOString());

  try {
    const token = await getAccessToken();

    // Step 1: Fetch Excel from Outlook email
    console.log('\n--- Step 1: Fetching Excel from Outlook ---');
    const excelRows = await fetchExcelFromOutlook();
    const { barcodeMap, skuMap, modelMap } = parseExcelData(excelRows);
    const hasExcel = Object.keys(barcodeMap).length > 0 || Object.keys(modelMap).length > 0;
    console.log(hasExcel ? '✓ Excel data ready for matching' : '⚠ No Excel data — running Amazon-only analysis');

    // Step 2: Get Amazon listings
    console.log('\n--- Step 2: Fetching Amazon listings ---');
    const { reportAsins, activePrices, activeSkus, activeAllSkus, activeTitles, activeQtys, activeStatuses } =
      await fetchListingsReport(token);

    if (reportAsins.length === 0) {
      throw new Error('No listings found. Check SP-API Reports permission.');
    }

    const uniqueAsins = [...new Set(reportAsins)].filter(Boolean);
    console.log(`Total unique ASINs: ${uniqueAsins.length}`);

    // Step 3: Fetch FBM quantities — sum across all SKUs per ASIN
    console.log('\n--- Step 3: Fetching FBM quantities ---');
    const fbmQtys = await fetchFBMQuantities(token, uniqueAsins, activeAllSkus);

    // Step 4: Get pricing and buy box data
    console.log('\n--- Step 4: Fetching buy box and pricing ---');
    const results = await fetchPricingData(
      token, uniqueAsins, activePrices, activeTitles, activeQtys, activeSkus, fbmQtys, activeStatuses
    );

    // Step 5: Merge Excel data into results
    console.log('\n--- Step 5: Merging Excel data ---');
    let matchCount = 0, barcodeMatches = 0, modelMatches = 0, descMatches = 0, imageMatches = 0;

    // Helper: normalise model number for comparison
    const normModel = s => String(s||'').toUpperCase().replace(/[\s\-_]/g,'');

    // Helper: normalise description for exact match
    const normDesc = s => String(s||'').toLowerCase().replace(/\s+/g,' ').trim();

    // Build exact description lookup from Excel
    const descMap = {};
    for (const [barcode, data] of Object.entries(barcodeMap)) {
      if (data.name) {
        const key = normDesc(data.name);
        if (key.length > 5) descMap[key] = data;
      }
    }

    // Step 5a: Fetch catalog data for ALL unmatched products upfront
    // (only fetch if we have model numbers to search for)
    let catalogData = {};
    if (Object.keys(modelMap).length > 0) {
      console.log('Fetching catalog data for model/image matching...');
      catalogData = await fetchProductCatalogData(token, results.map(r => r.asin));
    }

    for (const item of results) {
      let excelData = null;
      let matchType = 'none';

      // ── Tier 1: SKU match ────────────────────────────────────────────────
      if (!excelData && item.sku && skuMap[item.sku]) {
        excelData = skuMap[item.sku];
        matchType = 'barcode';
        barcodeMatches++;
      }

      // ── Tier 1b: Barcode match ───────────────────────────────────────────
      if (!excelData && item.barcode) {
        const cleanBarcode = String(item.barcode).replace(/\D/g, '');
        if (cleanBarcode && barcodeMap[cleanBarcode]) {
          excelData = barcodeMap[cleanBarcode];
          matchType = 'barcode';
          barcodeMatches++;
        }
      }

      // ── Tier 2: Internal Reference / Model Number in title ───────────────
      if (!excelData && item.title && Object.keys(modelMap).length > 0) {
        const titleUpper = item.title.toUpperCase().replace(/[\s\-_]/g,'');
        for (const [model, data] of Object.entries(modelMap)) {
          if (model.length >= 5 && titleUpper.includes(model)) {
            excelData = data;
            matchType = 'model';
            modelMatches++;
            break;
          }
        }
      }

      // ── Tier 3: Exact description match (100% only) ──────────────────────
      if (!excelData && item.title) {
        const normTitle = normDesc(item.title);
        if (descMap[normTitle]) {
          excelData = descMap[normTitle];
          matchType = 'desc';
          descMatches++;
        }
      }

      // ── Tier 4: Amazon catalog model number fields ───────────────────────
      // Checks model_number, part_number, manufacturer_part_number etc.
      if (!excelData && catalogData[item.asin]?.modelNumbers?.length > 0) {
        for (const amazonModel of catalogData[item.asin].modelNumbers) {
          // Exact match first
          if (modelMap[amazonModel]) {
            excelData = modelMap[amazonModel];
            matchType = 'model';
            modelMatches++;
            console.log(`  Catalog model match: Amazon="${amazonModel}" → Excel="${excelData.name?.slice(0,40)}"`);
            break;
          }
          // Partial match — only if both are at least 5 chars and one contains the other
          // AND the shorter one is at least 60% of the longer (avoids short false matches)
          for (const [excelModel, data] of Object.entries(modelMap)) {
            if (excelModel.length < 5 || amazonModel.length < 5) continue;
            const shorter = Math.min(excelModel.length, amazonModel.length);
            const longer = Math.max(excelModel.length, amazonModel.length);
            if (shorter / longer < 0.6) continue; // too different in length
            if (amazonModel.includes(excelModel) || excelModel.includes(amazonModel)) {
              excelData = data;
              matchType = 'model';
              modelMatches++;
              console.log(`  Catalog partial model: Amazon="${amazonModel}" ~ Excel="${excelModel}"`);
              break;
            }
          }
          if (excelData) break;
        }
      }

      // ── Tier 5: Model number in catalog description/bullets ──────────────
      if (!excelData && catalogData[item.asin]?.descText) {
        const descUpper = catalogData[item.asin].descText.toUpperCase().replace(/[\s\-_]/g,'');
        for (const [model, data] of Object.entries(modelMap)) {
          if (model.length >= 5 && descUpper.includes(model)) {
            excelData = data;
            matchType = 'model';
            modelMatches++;
            console.log(`  Desc model match: "${model}" in description of ${item.asin}`);
            break;
          }
        }
      }

      // ── Tier 6: Claude vision — scan product images (last resort) ─────────
      if (!excelData && catalogData[item.asin]?.imageUrls?.length > 0 && process.env.ANTHROPIC_API_KEY) {
        const candidateModels = Object.keys(modelMap);
        const foundModel = await extractModelFromImages(catalogData[item.asin].imageUrls, candidateModels);
        if (foundModel && modelMap[foundModel]) {
          excelData = modelMap[foundModel];
          matchType = 'image';
          imageMatches++;
          console.log(`  Image match: "${foundModel}" → "${excelData.name?.slice(0,40)}" (${item.asin})`);
        }
      }

      // ── Apply matched data ───────────────────────────────────────────────
      if (excelData) {
        item.excelQty         = excelData.qty;
        item.salesPrice       = excelData.salesPrice;
        item.costPrice        = excelData.salesPrice ? excelData.salesPrice * 0.8 : null;
        item.excelDescription = excelData.name || null;
        item.excelModel       = excelData.model ? excelData.model.replace(/[\[\](){}]/g,'').trim() : null;
        item.matchType        = matchType;
        item.qtyDiff          = item.excelQty - (item.amazonQty || 0);
        matchCount++;
      } else {
        item.excelQty         = null;
        item.salesPrice       = null;
        item.costPrice        = null;
        item.excelDescription = null;
        item.excelModel       = null;
        item.matchType        = 'none';
        item.qtyDiff          = null;
      }

      // ── Profit calculation ───────────────────────────────────────────────
      const sp = item.yourPrice || item.buyBoxPrice || null;
      const cp = item.costPrice;
      if (sp && cp) {
        const fee = sp * 0.15;
        const postage = 8.50;
        item.profit = sp - cp - fee - postage;
        item.margin = sp > 0 ? (item.profit / sp * 100) : 0;
      } else {
        item.profit = null;
        item.margin = null;
      }
    }

    console.log(`✓ Matched: ${matchCount}/${results.length} — Barcode: ${barcodeMatches}, Model: ${modelMatches}, Description: ${descMatches}, Image: ${imageMatches}, No match: ${results.length - matchCount}`);

    // Step 6: Save to Supabase
    console.log('\n--- Step 6: Saving to Supabase ---');
    const summary = await saveToSupabase(results, hasExcel, matchCount);

    console.log('\n=== Analysis Complete ===');
    console.log(`✓ ${summary.total} products`);
    console.log(`✓ Buy box wins: ${summary.buyBoxWins} (${summary.winRate}%)`);
    console.log(`✓ Buy box lost: ${summary.buyBoxLost}`);
    console.log(`✓ Zero stock: ${summary.zeroStock}`);
    console.log(`✓ Excel matched: ${matchCount} products`);

  } catch (err) {
    console.error('Analysis failed:', err.message);
    process.exit(1);
  }
}

main();
