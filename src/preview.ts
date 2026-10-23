// The preview window: a tiny page on localhost that shows every open document zoomed, plays its animation, and
// redraws on every change pushed over server-sent events. It has no tools and edits nothing.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import type { Doc } from "./doc.ts";
import { flatten } from "./doc.ts";
import { rgbaToHex } from "./palette.ts";

export interface Preview { url: string; changed(): void; close(): void; open(): void }

const PAGE = `<!doctype html><meta charset="utf-8"><title>tenten</title>
<style>body{margin:0;background:#1b1d1a;color:#d3dcc2;font:13px/1.4 system-ui,sans-serif}header{padding:8px 12px;background:#11140d;display:flex;gap:16px;align-items:center}main{padding:12px;display:flex;flex-wrap:wrap;gap:16px}section{background:#11140d;padding:8px;border-radius:6px}h2{margin:0 0 6px;font-size:13px;font-weight:600}canvas{image-rendering:pixelated;display:block;background:repeating-conic-gradient(#222 0 25%,#2a2a2a 0 50%) 0 0/16px 16px}.meta{color:#8a9480;margin-top:4px}input{width:60px}</style>
<header><strong>tenten</strong><label>zoom <input id="zoom" type="number" min="1" max="32" value="8"></label><label><input id="play" type="checkbox" checked> play</label><span id="status"></span></header><main id="main"></main>
<script>
const main=document.getElementById('main'),zoomEl=document.getElementById('zoom'),playEl=document.getElementById('play'),status=document.getElementById('status');
let docs=[],t0=performance.now();
function draw(){const z=+zoomEl.value||8;main.replaceChildren(...docs.map(d=>{const s=document.createElement('section');s.innerHTML='<h2></h2>';s.querySelector('h2').textContent=d.name+' '+d.width+'x'+d.height+', '+d.frames.length+' frames';
const row=document.createElement('div');row.style.display='flex';row.style.gap='8px';
const all=document.createElement('canvas');all.width=d.width*d.frames.length+d.frames.length-1;all.height=d.height;all.style.width=all.width*z+'px';all.style.height=all.height*z+'px';const ctx=all.getContext('2d');
d.frames.forEach((f,i)=>{ctx.putImageData(toImage(d,f),i*(d.width+1),0)});row.append(all);
if(d.frames.length>1){const anim=document.createElement('canvas');anim.width=d.width;anim.height=d.height;anim.style.width=d.width*z+'px';anim.style.height=d.height*z+'px';anim.dataset.doc=d.name;row.append(anim)}
s.append(row);const m=document.createElement('div');m.className='meta';m.textContent='palette '+d.palette.join(' ')+(d.tags.length?' | tags '+d.tags.map(t=>t.name+' '+t.from+'-'+t.to).join(', '):'');s.append(m);return s}))}
function toImage(d,f){const img=new ImageData(d.width,d.height);for(let i=0;i<f.length;i++){const c=d.rgba[f[i]]||[0,0,0,0];img.data.set(c,i*4)}return img}
function tick(){if(playEl.checked)for(const c of document.querySelectorAll('canvas[data-doc]')){const d=docs.find(x=>x.name===c.dataset.doc);if(!d)continue;const total=d.durations.reduce((a,b)=>a+b,0);let t=(performance.now()-t0)%total,i=0;while(t>=d.durations[i]){t-=d.durations[i];i++}c.getContext('2d').putImageData(toImage(d,d.frames[i]),0,0)}requestAnimationFrame(tick)}
zoomEl.oninput=draw;
const es=new EventSource('/events');es.onmessage=e=>{docs=JSON.parse(e.data);status.textContent=new Date().toLocaleTimeString();draw()};es.onerror=()=>{status.textContent='disconnected'};
tick();
</script>`;

export function startPreview(getDocs: () => Doc[]): Promise<Preview> {
  const clients = new Set<import("node:http").ServerResponse>();
  const snapshot = () => JSON.stringify(getDocs().map((d) => ({ name: d.name, width: d.width, height: d.height, palette: d.palette.map(rgbaToHex), rgba: d.palette, durations: d.frames.map((f) => f.durationMs), tags: d.tags, frames: d.frames.map((f) => Array.from(flatten(d, f))) })));
  const server: Server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${snapshot()}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    resolve({
      url,
      changed() { const data = `data: ${snapshot()}\n\n`; for (const c of clients) c.write(data); },
      close() { for (const c of clients) c.end(); server.close(); },
      open() {
        const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] as const : process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
        spawn(cmd[0], [...cmd[1]], { detached: true, stdio: "ignore" }).unref();
      },
    });
  }));
}
