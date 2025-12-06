const fs = require('fs');
const path = require('path');

console.log('Running EAS pre-install hook...');

// For production/preview builds
if (process.env.GOOGLE_SERVICES_JSON_BASE64) {
  console.log('Decoding GOOGLE_SERVICES_JSON_BASE64...');
  const decoded = Buffer.from(process.env.GOOGLE_SERVICES_JSON_BASE64, 'base64').toString('utf-8');
  fs.writeFileSync(path.join(process.cwd(), 'google-services.json'), decoded);
  console.log('Created google-services.json');
}

// For development builds
if (process.env.GOOGLE_SERVICES_DEV_JSON_BASE64) {
  console.log('Decoding GOOGLE_SERVICES_DEV_JSON_BASE64...');
  const decoded = Buffer.from(process.env.GOOGLE_SERVICES_DEV_JSON_BASE64, 'base64').toString('utf-8');
  fs.writeFileSync(path.join(process.cwd(), 'google-services-dev.json'), decoded);
  console.log('Created google-services-dev.json');
}

console.log('Pre-install hook complete.');
