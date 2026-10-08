const path = require('path');
const fs = require('fs');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');

(async () => {
  const db = {
    saveScript: async (s) => {
      const out = path.resolve(__dirname, 'last_script.json');
      fs.writeFileSync(out, JSON.stringify(s, null, 2), 'utf8');
      return true;
    }
  };

  const credentials = {}; // stub
  const agent = new ScriptWriterAgent(db, credentials);
  await agent.initialize();

  // Read local catalog to build realistic fake GPT response
  const catalogPath = path.resolve(__dirname, '..', 'productos_locales.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const numProductos = 6;
  const strategy = {
    topic: `Top ${numProductos} Gadgets de Cocina que se Agotan`,
    productos: catalog.slice(0, numProductos).map(p => ({ nombre: p.product_name, id: p.id, filename: p.filename })),
    numProductos
  };

  // Build fake GPT response matching the contract
  const fakeProductos = catalog.slice(0, numProductos).map(p => {
    const narr = `Breve narración sobre ${p.product_name} destacando su mejor característica.`;
    const words = narr.split(/\s+/).filter(Boolean).length;
    const salesCta = `Su precio actual en Amazon ronda los... ${p.price} dólares. ¡Link en el primer comentario!`;
    const dur = Math.ceil((words + 12) / 2.5);
    return {
      asin: p.id,
      video_file: p.filename,
      title: p.product_name,
      narracion: narr,
      sales_cta: salesCta,
      duracion_estimada_segundos: dur
    };
  });

  const fakeResponse = {
    title: strategy.topic,
    hook: "Vista rápida de gadgets en acción. Teaser 2. Teaser 3.",
    introduccion: "Suscríbete. Los links están en el primer comentario.",
    productos: fakeProductos,
    cierre: "Dale like y recuerda que los links están en el primer comentario."
  };

  // Inject a fake OpenAI client
  agent.openai = {
    chat: {
      completions: {
        create: async (opts) => {
          return { choices: [ { message: { content: JSON.stringify(fakeResponse) } } ] };
        }
      }
    }
  };

  try {
    const script = await agent._generateListicleScript(strategy, []);
    const secs = (script.mainContent && script.mainContent.sections) || [];
    console.log(`TEST RESULT: generated sections=${secs.length}`);
    secs.forEach((s, i) => {
      console.log(`${i + 1}. ${s.title}  | filename=${s.filename} | productId=${s.productId}`);
    });
    process.exit(0);
  } catch (e) {
    console.error('TEST ERROR:', e);
    process.exit(2);
  }
})();
