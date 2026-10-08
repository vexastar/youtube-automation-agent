const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');

class BRollProvider {
  constructor() {
    this.logger = new Logger('BRollProvider');
    this.uploadDir = path.resolve(__dirname, '../uploads');
  }

  /**
   * Lee los videos .mp4 de la carpeta uploads/ (ya descargados por el Cazador).
   * Los devuelve ordenados por nombre (item_1, item_2, ...) para que cada
   * video coincida con su producto en el listicle.
   */
  async searchVideos(query, options = {}) {
    try {
      const files = await fs.readdir(this.uploadDir);

      const videoFiles = files
        .filter(file => ['.mp4', '.mov', '.avi'].includes(path.extname(file).toLowerCase()))
        .sort(); // item_1 < item_2 < item_3 ...

      if (videoFiles.length === 0) {
        this.logger.warn(`No encontré videos en la carpeta: ${this.uploadDir}`);
        return [];
      }

      this.logger.info(`Encontrados ${videoFiles.length} videos locales para B-Roll.`);

      return videoFiles.map(file => ({
        link: path.join(this.uploadDir, file),
        file_type: 'video/mp4'
      }));

    } catch (error) {
      this.logger.error(`Error leyendo videos locales: ${error.message}`);
      return [];
    }
  }
}

module.exports = BRollProvider;