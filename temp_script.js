const fs = require('fs');
const path = require('path');
const { passesPreFilter } = require('./src/lib/jobFiltering');

// We have to mock or compile if it uses ES modules but let's see if we can use ts-node properly with script
