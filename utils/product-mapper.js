const productosLocales = require('../productos_locales.json');
const catalog = require('../uploads/catalog.json');

// Function to validate and map products to videos
function mapProductsToVideos() {
    const mappedProducts = productosLocales.map(product => {
        const video = catalog.products.find(item => item.file === product.filename);
        if (video) {
            return {
                ...product,
                videoPath: video.file
            };
        } else {
            console.log(`Producto sin video: ${product.product_name}`);
            return {
                ...product,
                videoPath: "SIN VIDEO"
            };
        }
    });
    return mappedProducts;
}

module.exports = { mapProductsToVideos };