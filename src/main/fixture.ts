import { createServer } from "node:http";
export async function startFixture(port: number) {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
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
