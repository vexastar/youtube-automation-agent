(async () => {
  process.env.DATA_SOURCE_MODE = 'local';
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

  // Use first 5 products for a quick simulation
  const sample = products.slice(0, 5).map(p => ({ id: p.id, filename: p.filename, nombre: p.product_name }));
  const hunter = new ProductHunterAgent();
  try {
    const results = await hunter.huntMultipleGadgets(sample);
    console.log('\n=== Resultados de simulación (primeros 5) ===');
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('Simulación falló:', e.message);
    process.exit(1);
  }
})();
