'use strict';

const fs = require('fs');
const path = require('path');

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const timestamp = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}, ${pad(now.getHours())}:${pad(now.getMinutes())}`;

const info = { buildDate: timestamp };
const outPath = path.join(__dirname, '..', 'build-info.json');
fs.writeFileSync(outPath, JSON.stringify(info, null, 2));
console.log(`Build info generated: ${timestamp}`);
