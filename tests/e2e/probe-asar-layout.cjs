'use strict';

// Read-only probe: locate the DSH layout logic that decides drawer vs docked
// sidebar, plus the attributes the web UI writes onto its frame. Used by the
// t12 verification report; never writes to the asar.

const fs = require('fs');

const asar = process.env.DSH_ASAR || 'D:/deepseek/resources/app.asar';
const buf = fs.readFileSync(asar).toString('latin1');
const needles = ['sidebar-drawer', 'data-sidebar-drawer', 'sidebarDrawer', 'windowsTitlebar', 'data-windows-titlebar'];

for (const needle of needles) {
  let i = -1;
  let n = 0;
  console.log(`=== ${needle}`);
  while ((i = buf.indexOf(needle, i + 1)) >= 0 && n < 6) {
    const ctx = buf.slice(Math.max(0, i - 260), i + 300).toString('utf8');
    if (/drawer|titlebar|viewport|768/i.test(ctx)) {
      console.log(`OFFSET ${i} ${JSON.stringify(ctx)}`);
      n += 1;
    }
  }
  console.log(`shown ${n}`);
}
