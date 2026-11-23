const fs = require('node:fs');
const path = require('node:path');
const destination = path.resolve(__dirname, '../dist');
fs.mkdirSync(destination, {recursive:true});
const html = fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8')
 .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '')
 .replace('<script src="renderer.js"></script>','<script src="native-layout.js"></script>\n<script src="tauri-adapter.js"></script>\n<script src="renderer.js"></script>');
fs.writeFileSync(path.join(destination,'index.html'),html);
for(const [source,target] of [['renderer.js','renderer.js'],['src/native-layout.js','native-layout.js'],['src/tauri-adapter.js','tauri-adapter.js']])
 fs.copyFileSync(path.resolve(__dirname,'..',source),path.join(destination,target));
