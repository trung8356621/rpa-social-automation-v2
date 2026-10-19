import { createServer } from "node:http";
export async function startFixture(port: number) {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/typing")) {
      res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f4f6f9;font:20px Arial}button{position:absolute;left:120px;top:100px;width:360px;height:64px;background:#123d72;color:white;border:3px solid #709eca;font:28px Arial}#editor{display:none;position:absolute;left:120px;top:220px;width:650px;min-height:200px;border:3px solid #123d72;background:white;padding:15px;white-space:pre-wrap}</style><button id="open">Open composer</button><div id="editor" contenteditable="true" role="textbox" aria-label="Draft"></div><script>
      window.typingProbe={clicks:0,events:[]};const editor=document.querySelector('#editor');document.querySelector('#open').onclick=()=>{typingProbe.clicks++;setTimeout(()=>{editor.style.display='block';if(!location.search.includes('no-caret'))editor.focus()},200)};
      for(const type of ['beforeinput','input','paste','keydown'])editor.addEventListener(type,e=>typingProbe.events.push({type,inputType:e.inputType||'',trusted:e.isTrusted}));
      window.typingRead=()=>({text:editor.innerText.replace(/\\r/g,''),active:document.activeElement.id,...typingProbe});</script>`);
      return;
    }
    if (req.url?.startsWith("/ocr")) {
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>OCR fixture</title><style>
      body{margin:0;background:#f4f6f9;font:18px Arial}button{position:absolute;left:100px;width:360px;height:64px;background:white;color:#111;border:2px solid #333;font:32px Arial}#vi{top:110px}#en{top:260px}#icon{left:550px;top:110px;width:80px;height:80px;background:#173d82;border:0}#icon:before{content:'';position:absolute;left:20px;top:20px;width:36px;height:36px;border:6px solid white;border-radius:50%}#output{position:absolute;top:420px;left:100px}</style></head><body>
      <button id="vi">Tạo bài viết</button><button id="en">Create post</button><button id="icon" aria-label="icon"></button><div id="output"></div>
      <script>window.ocrProbe={clicks:0,id:'',x:0,y:0};for(const b of document.querySelectorAll('button'))b.onclick=e=>{ocrProbe.clicks++;ocrProbe.id=b.id;ocrProbe.x=e.clientX;ocrProbe.y=e.clientY;document.querySelector('#output').innerHTML='Draft opened <textarea id=live-draft></textarea>';document.querySelector('#live-draft').focus();};</script></body></html>`);
      return;
    }
    res.end(`<!doctype html><html><head><title>Browser calibration</title><style>
    *{box-sizing:border-box}body{margin:0;background:#edf2f9;font:18px Arial;color:#15253d}header{height:70px;padding:20px;background:#163963;color:white}
    #composer{position:absolute;left:120px;top:120px;width:300px;height:64px;background:#df2848;color:white;border:0;border-radius:8px;font-size:20px}
    #draft{position:absolute;left:120px;top:230px;width:620px;height:150px;padding:16px;background:white;border:2px solid #163963;font:20px Arial}
    #out{position:absolute;left:120px;top:410px}footer{margin-top:1500px;padding:30px;background:#b9d8a9}
    </style></head><body><header>WebContentsView · trang kiểm chuẩn nội bộ</header><button id="composer">Mở bản nháp · 120,120</button>
    <textarea id="draft" placeholder="Click vào đây để test TYPE_ONLY"></textarea><div id="out">Chưa click composer</div><footer>Scroll checkpoint</footer>
    <script>window.probe={clicks:0,x:0,y:0};document.querySelector('#composer').onclick=e=>{probe.clicks++;probe.x=e.clientX;probe.y=e.clientY;document.querySelector('#out').textContent='Composer opened '+probe.clicks};
    window.fixtureRead=()=>({ ...probe,text:document.querySelector('#draft').value,focus:document.activeElement.id,scrollY, width:innerWidth,height:innerHeight,dpr:devicePixelRatio,local:localStorage.getItem('poc-session'),cookie:document.cookie });</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
