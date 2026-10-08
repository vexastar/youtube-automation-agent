(async () => {
  require('dotenv').config();
  process.env.DATA_SOURCE_MODE = 'api';
  const ProductHunterAgent = require('./agents/product-hunter-agent');
  const fs = require('fs');
  const path = require('path');

  const localPath = path.resolve(__dirname, 'productos_locales.json');
  let products = [];
  try {
    products = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  } catch (e) {
    console.error('No pude leer productos_locales.json:', e.message);
    process.exit(2);
  }

  // Use first 3 products for a quick API simulation
  const sample = products.slice(0, 3).map(p => ({ id: p.id, filename: p.filename, nombre: p.product_name, searchTermEn: p.filename.replace(/\.mp4$/, '') }));
  const hunter = new ProductHunterAgent();
  try {
    const results = await hunter.huntMultipleGadgets(sample);
    console.log('\n=== Resultados de simulación API (primeros 3) ===');
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('Simulación API falló:', e.message);
    process.exit(1);
  }
})();
