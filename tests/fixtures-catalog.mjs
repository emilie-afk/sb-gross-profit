/**
 * Synthetic cost sheets for C6 tests. Every SKU, name and cost is invented.
 * The shapes follow build.py / vendor_sheets.py: title rows, group headers,
 * repeated columns, merged product cells, BOMs, CRLF, quoted newlines.
 *
 * syntheticSheets({ scale: true }) pads the vendor tabs to the Revision 5
 * minimums so validateCatalog() accepts the catalog.
 */
const pad = (n, mk) => Array.from({ length: n }, (_, i) => mk(i)).join('');

export function syntheticSheets({ scale = false, vendorScale = 1 } = {}) {
  const extra = (vendor, n) => (scale ? pad(Math.ceil(n * vendorScale), i => `Synthetic ${vendor} ${i},${vendor.slice(0, 3).toUpperCase()}-PAD-${i},${(3 + (i % 17) * 0.25).toFixed(2)}\n`) : '');
  return {
    MCG_SHEET_URL: '\ufeffSKU,Description,Cost Per Item\r\n'
      + 'S2KY2965,"S2KY2965 Frizzle Sizzle Albuca - 2 inch / Dormant",$4.50\r\n'
      + 's2ky1111,S2KY1111 Echeveria Synthetic,"1,234.00"\r\n'
      + 'S2KY2965,S2KY2965 Frizzle Sizzle Albuca - 2 inch,4.75\r\n'
      + 'S2KY2222,"Echeveria\nsecond line",1_0\r\n'
      + 'S2KY3333,S2KY3333 Echeveria Synthetic,5\r\n'
      + 'S2KY4444,nan desc,nan\r\n'
      + ' S2KY5555 ,S2KY5555 Haworthia,  6.25 \r\n'
      + '12345,12345 Number Like,2.00\r\n'
      + 'S2KY6666\r\n'
      + ',no sku,3\r\n'
      + 'EEZZ7680,manual overlap,9.99\r\n',
    MCG_POTS_SHEET_URL: 'MCG Product Calulator,,\n,,\nPot SKU,Pot Cost,Notes\nEEZZ7620.BR-1,$3.00,x\nEEZZ7620.WH-1,$3.50,\n\nEEZZ9000,0,\nEEZZ9100,2.25\n',
    SB_SKU_ALIAS_URL: 'Alias sheet,\nSB SKU,Amazon SKU,Notes\ns2ky1111,amz-1111,\nS2KY3333,S2KY3333,same\n,AMZ-EMPTY,\nS2KY5555,AMZ-5555,\n',
    SB_SKU_ALIAS_URL_2: 'Internal SKU,Seller SKU\nHPX-2,SELLER-HPX-2\n',
    AS_SHEET_URL: 'SKU ,Fullfilled Price,Retail\nAS-001,$7.00,14\nas-002,8.5,\nAS-003,,\nHPX-1,6.00,\n',
    L2G_SHEET_URL: 'Live to Give products,,\nShopify Name,SKUs,Dropship Price (60% of retail price)\n'
      + '"Internal Pray\n\nPrayer Gift Box",Pray DLX,29.99\n,Pray STD,19.99\n'
      + 'Hope Box,L2G-DUP,12.00\n,L2G-DUP,12.00\nConflict Box,L2G-CONFLICT,10\n,L2G-CONFLICT,11\n,,\nBlank,,5\n'
      + extra('Live to Give', 30),
    LIVELY_GOOD_SHEET_URL: ',,,,,Listing Shopify\nTitle,SKU,Cost per item,SKU,Cost per item,\n'
      + 'Good Candle,LG-1,5.00,SB-LG-1,9.00,TRUE\nGood Soap,LG-2,4.00,SB-LG-2,8,FALSE\nGood Mug,LG-3,$6.10,,,x\n'
      + (scale ? pad(Math.ceil(171 * vendorScale), i => `Good ${i},LG-PAD-${i},${(2 + (i % 11) * 0.5).toFixed(2)},,,TRUE\n`) : ''),
    CALATHEA_COLLECTIVE_SHEET_URL: 'Product,SKU,Cost (what Calathea Collective receives),Weight\n'
      + 'Calathea A,1-00,5.00,1\n,100,6.00,1\nCalathea Tie,CC-TIE,0.03125,1\nCalathea Five,CC-5DP,2.00005,1\n'
      + extra('Calathea Collective', 462),
    SURFSIDE_ARRANGEMENT_SHEET_URL: 'Product,SB SKU,Cost (what Surfside Succulents receives),Shipping note\n'
      + 'Surf Bowl,SS-1,22.00,"ships free\nnot COGS"\n,SS-2,24\n'
      + extra('Surfside Arrangement', 11),
    LINDAMAKES_SHEET_URL: 'Product,SKU,Cost (what LindaMakess receives)\nLinda Pot,LM-1,7.25\n,LM-2,7.25\nLinda Vase,lm-3,0\n'
      + extra('LindaMakes', 396),
    HP_SHEET_URL: 'SKU,Cost,WeightLb\nHPX-1,3.00,1.2\nHPX-2,4.00,\nHPX-1,3.25,1.3\nHPX-3,,2\n',
    MCG_EXTRA_SHEET_URL: '\ufeffSKU,Description,Cost per item\nS9ZZ0001,S9ZZ0001 Extra Plant / 2in,1.50\nS9ZZ0002,,0\n',
    productExport: { name: 'products_export_2026-09-20.csv', text: 'Handle,Title,Vendor,Variant SKU,Cost per item,Body (HTML)\n'
      + 'sb-thing,SB Thing,Succulents Box,SB-1,2.00,"<p>line\nline</p>"\nsb-thing,,,SB-2,2.50,\n'
      + 'hp-fern,Boston Fern!,House Plant Dropship,HPF-1,9.00,\nhp-fern,,,HPF-2,11.00,\nhp-fern,,,,12.00,\n'
      + 'hp-ivy,Ivy,House Plant Shop,,7.00,\nother,Other,Someone Else,OT-1,1.00,\n' },
  };
}

/**
 * A synthetic Products Master "Lively Root" tab: LR SKU in column E, LR cost in
 * G, the Listing Shopify checkbox in Q. By default the listed rows are exactly
 * build.py's MANUAL_LR_COSTS; `change` edits costs, `extra` adds listed rows.
 */
export function livelyRootTab(manualEntries, { change = {}, extra = [], drop = [] } = {}) {
  const row = (cells) => { const r = Array(17).fill(''); for (const [i, v] of Object.entries(cells)) r[i] = v; return r.join(','); };
  const lines = [row({ 0: 'Lively Root products' }), row({ 0: 'Product', 4: 'LR SKU', 5: 'LR Price', 6: 'LR Cost', 16: 'Listing Shopify' })];
  for (const [sku, cost] of manualEntries) if (!drop.includes(sku)) lines.push(row({ 0: 'Synthetic plant', 4: sku, 5: '99.00', 6: (change[sku] ?? cost).toFixed(2), 16: 'TRUE' }));
  for (const [sku, cost] of extra) lines.push(row({ 0: 'Synthetic extra', 4: sku, 6: cost.toFixed(2), 16: 'TRUE' }));
  lines.push(row({ 0: 'Not listed', 4: 'PL_SYN_NOTLISTED', 6: '12.00', 16: 'FALSE' }));
  return lines.join('\n') + '\n';
}
