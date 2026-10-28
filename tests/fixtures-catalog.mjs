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
    // Older two-column sheet. S2KY0001 has no alias of its own; S2KY0002 lists it as an alias (a conflict).
    SB_SKU_ALIAS_URL: 'Alias sheet,\nSB SKU,Amazon SKU,Notes\ns2ky1111,amz-1111,\nS2KY3333,S2KY3333,same\n,AMZ-EMPTY,\nS2KY5555,AMZ-5555,\nS2KY0001,,\nS2KY0002,S2KY0001,\n',
    // The Products Master product tabs (explicit alias layouts): one row per product, every Amazon alias of it in one
    // cell, one per line. Row 5 conflicts with row 4 (9003-2) and has a token with a space inside; row 6 lists itself
    // and another product's SKU as aliases; row 7 has no SKU.
    SB_SKU_ALIAS_URL_2: 'STT,Plant Name,Plant Size,Style/Pot,MCG SKU,POT SKU,SB Bundles SKU,Weight (oz),Cost,Shopify,,,AMZ SB Alias SKUs,Amazon\r\n'
      + '1,Synthetic Echeveria,2in,,S2KY1111,,S2KY1111,1,$2.00,Y,,,"9001-2-var\n 2inColor-S2KY1111",Y\r\n'
      + '2,Synthetic Echeveria,2in,Pot,S2KY1111,EEZZ7620.BR-1,S2KY1111+EEZZ7620.BR-1,2,$4.00,Y,,,"9001-2p\r\n E9001-2p ",Y\r\n'
      + '3,Synthetic Haworthia,2in,,s2ky5555,,,1,$2.00,,,,9002-2,\r\n'
      + '4,Synthetic Conflict A,2in,,S2KY3333,,S2KY3333,1,$2.00,,,,9003-2,\r\n'
      + '5,Synthetic Conflict B,2in,,S2KY6666,,S2KY6666,1,$2.00,,,,"9003-2\nbad token",\r\n'
      + '6,Synthetic Self,2in,,S2KY4444,,S2KY4444,1,$2.00,,,,"S2KY4444\nS2KY1111",\r\n'
      + '7,No SKU,,,,,,,,,,,9009-2,\r\n'
      // Product A (S2KY7777) lists no aliases; product B lists A's SKU as its alias (a conflict). S2KY9999 lists only
      // itself; S2KY9898 lists S2KY9999 (a conflict) and one alias of its own.
      + '8,Synthetic Product A,2in,,S2KY7777,,S2KY7777,1,$2.00,,,,,\r\n'
      + '9,Synthetic Product B,2in,,S2KY8888,,S2KY8888,1,$2.00,,,,S2KY7777,\r\n'
      + '10,Synthetic Self Only,2in,,S2KY9999,,S2KY9999,1,$2.00,,,,s2ky9999 ,\r\n'
      + '11,Synthetic Points At Self Only,2in,,S2KY9898,,S2KY9898,1,$2.00,,,,"S2KY9999\n9011-2",\r\n',
    HP_SKU_ALIAS_URL: 'No.,Plant Name,Size,HD SKU,Weight (oz),Cost,Shopify Uploaded Listing,AMZ SB Alias SKUs\n'
      + '1,Synthetic Hoya,4,4_HOYA_SYNTH,8,$5.00,Y,"7001-4-pl\nH7001-4-pl-BPF"\n'
      + '2,Synthetic Pothos,4,4_POTHOS_SYNTH,8,$5.00,Y,7002-4-pl\n'
      + '3,Synthetic Pothos large,6,6_POTHOS_SYNTH,8,$5.00,Y,"7002-4-pl\n7003-6-pl"\n'
      + '4,Synthetic Fern,4,4_FERN_SYNTH,8,$5.00,Y,\n'
      + '5,Synthetic Fern large,6,6_FERN_SYNTH,8,$5.00,Y,4_fern_synth\n',
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
    // The MCG succulent-pack tab's shape: a title row holding "SKU", then the row holding "Total Cost/pack";
    // the selling price beside it; $0.00 and blank costs; a conflicting duplicate; a lowercase SKU; a note column.
    MCG_PACK_SHEET_URL: 'No,Pack,SKU,,,,,Shopify,,note\n'
      + ',,,Packs,Cost per plant,Total Cost/pack,Price,Uploaded Listing,,"pack <20 -> $4\npack >=100 -> $2"\n'
      + '1,"Synthetic Assorted Pack (10-30 Plants, 2"" Pots)",RAZZ9001-10,10,$1.00,$10.00,$20.00,TRUE,,\n'
      + ',,RAZZ9001-30,30,,$0.00,$0.00,TRUE,,\n'
      + '2,Synthetic Bulk Pack,TAZZ9002-25,25,$1.65,"$1,041.25",$82.50,TRUE,,\n'
      + ',,TAZZ9002-50,50,,,,FALSE,,\n'
      + ',,razz9003-6, 6 ,$2.00, $12.00 ,$24.00,TRUE,,\n'
      + ',,RAZZ9004-6,6,$2.00,$12.00,$24.00,TRUE,,\n,,RAZZ9004-6,6,$2.10,$12.60,$25.20,TRUE,,\n'
      + '3,Mystery Synthetic,S2ZZ9005,1,$2.00,$2.00,$4.00,TRUE,,\n,,,,,$0.00,$0.00,FALSE,,\n',
    productExport: { name: 'products_export_2026-09-20.csv', text: 'Handle,Title,Vendor,Variant SKU,Cost per item,Body (HTML)\n'
      + 'sb-thing,SB Thing,Succulents Box,SB-1,2.00,"<p>line\nline</p>"\nsb-thing,,,SB-2,2.50,\n'
      + 'hp-fern,Boston Fern!,House Plant Dropship,HPF-1,9.00,\nhp-fern,,,HPF-2,11.00,\nhp-fern,,,,12.00,\n'
      + 'hp-ivy,Ivy,House Plant Shop,,7.00,\nother,Other,Someone Else,OT-1,1.00,\n' },
  };
}

/**
 * A synthetic Products Master "Lively Root" tab (the LIVELY_GOOD_SHEET_URL
 * source), laid out like the real one: group headers on row 1 ("Lively Root" at
 * A, "Succulents Box" at I, "Listing Shopify" at Q), column headers on row 2
 * (SKU at E, Cost per item at G, repeated for the Succulents Box block).
 * By default the listed rows are exactly build.py's MANUAL_LR_COSTS.
 */
export function livelyRootTab(manualEntries, { change = {}, extra = [], drop = [] } = {}) {
  const row = (cells) => { const r = Array(17).fill(''); for (const [i, v] of Object.entries(cells)) r[i] = v; return r.join(','); };
  const hdr = ['Title', 'Size', 'Pot', 'Pot Color', 'SKU', 'Retail Price', 'Cost per item', 'Est. Profit'];
  const lines = [row({ 0: 'Lively Root', 8: 'Succulents Box', 16: 'Listing Shopify' }), row(Object.fromEntries([...hdr, ...hdr].map((h, i) => [i, h])))];
  for (const [sku, cost] of manualEntries) if (!drop.includes(sku)) lines.push(row({ 0: 'Synthetic plant', 4: sku, 5: '99.00', 6: (change[sku] ?? cost).toFixed(2), 12: `SB-${sku}`, 14: '120.00', 16: 'TRUE' }));
  for (const [sku, cost] of extra) lines.push(row({ 0: 'Synthetic extra', 4: sku, 6: cost.toFixed(2), 16: 'TRUE' }));
  lines.push(row({ 0: 'Not listed', 4: 'PL_SYN_NOTLISTED', 6: '12.00', 16: 'FALSE' }));
  return lines.join('\n') + '\n';
}
