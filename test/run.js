'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runAll } = require('./runner');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const f of files) require(path.join(__dirname, f));

runAll();
