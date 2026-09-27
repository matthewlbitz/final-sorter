const express = require('express');
const path = require('path');
const {openStore} = require('./workflow');
function createApp(filename = process.env.KTRU_DB || path.join(__dirname, 'masterAlbums.db')) {
  const store = openStore(filename);
  const app = express();
  app.use(express.json({limit:'32kb'}));
  app.use('/api', (_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/api/state', (_req,res)=>res.json(store.state()));
  app.get('/api/search', (req,res)=>res.json(store.search(req.query.q)));
  app.post('/api/action', (req,res)=>{try{res.json(store.action(req.body));}catch(e){res.status(409).json({error:e.message});}});
  app.get('/api/lookup/:barcode', (req,res)=>{
    const album=store.db.prepare('SELECT * FROM rainbow_albums WHERE barcode=? LIMIT 1').get(req.params.barcode.trim());
    album?res.json(album):res.status(404).json({error:'Barcode not found'});
  });
  app.use(express.static(path.join(__dirname,'public')));
  return {app,store};
}
if(require.main===module){const {app}=createApp();const port=process.env.PORT||3000;app.listen(port,'127.0.0.1',error=>{if(error){console.error(error.message);process.exitCode=1;}else console.log(`KTRU Final Sorter: http://localhost:${port}`);});}
module.exports={createApp};
