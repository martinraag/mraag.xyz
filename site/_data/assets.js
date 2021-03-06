const fs = require('fs');
const path = require('path');

function mapAsset(route, asset) {
  const data = fs.readFileSync(path.join('site', route, 'rev-manifest.json'));
  const manifest = JSON.parse(data);
  const revision = manifest[asset];
  if (!revision) {
    throw new Error(`No revision found for asset /${route}/${asset}`);
  }
  return `/${route}/${revision}`;
}

module.exports = {
  css: {
    main: mapAsset('css', 'main.css'),
    prism: mapAsset('css', 'prism.css'),
  },
  js: {
    main: mapAsset('js', 'main.js'),
  },
};
