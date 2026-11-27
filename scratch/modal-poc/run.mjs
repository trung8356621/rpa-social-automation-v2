import sharp from 'sharp';
import { copyFile, mkdtemp, readFile, mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import Tesseract from 'tesseract.js';

const here = dirname(fileURLToPath(import.meta.url));
const [instance, output = join(here, 'results'), ocrFlag] = process.argv.slice(2);
if (!instance) throw new Error('Usage: node run.mjs <QA instance directory> [output directory] [--ocr]');
const cvPath = fileURLToPath(new URL('../../experiments/visual-match-lab/public/opencv.js', import.meta.url));
const module = { exports: {} };
compileFunction(await readFile(cvPath, 'utf8'), ['module', 'exports', 'require', '__filename', '__dirname'], { filename: cvPath })(
  module, module.exports, createRequire(cvPath), cvPath, dirname(cvPath),
);
const cv = await module.exports;
const area = ([,,w,h]) => w * h;
const center = ([x,y,w,h]) => [x + Math.floor(w / 2), y + Math.floor(h / 2)];
const contains = ([x,y,w,h], [px,py], inset = 0) =>
  px >= x + inset && px < x + w - inset && py >= y + inset && py < y + h - inset;
const intersection = ([x,y,w,h], [u,v,a,b]) =>
  Math.max(0, Math.min(x+w,u+a)-Math.max(x,u)) * Math.max(0, Math.min(y+h,v+b)-Math.max(y,v));
const iou = (a,b) => intersection(a,b)/(area(a)+area(b)-intersection(a,b));

function contours(mask, mode) {
  const vector = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(mask, vector, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);
    const result = [];
    for (let i = 0; i < vector.size(); i++) {
      const contour = vector.get(i);
      try {
        const { x, y, width, height } = cv.boundingRect(contour);
        const bbox = [x, y, width, height];
        result.push({ bbox, fill: Math.abs(cv.contourArea(contour)) / area(bbox) });
      } finally {
        contour.delete();
      }
    }
    return result;
  } finally {
    vector.delete();
    hierarchy.delete();
  }
}

function detect(gray) {
  const mask = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  try {
    cv.threshold(gray, mask, 170, 255, cv.THRESH_BINARY);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    const panels = contours(mask, cv.RETR_EXTERNAL).filter(({bbox, fill}) =>
      bbox[2] >= gray.cols * 0.18 && bbox[3] >= gray.rows * 0.17 &&
      area(bbox) < gray.rows * gray.cols * 0.75 && fill >= 0.8,
    ).sort((a,b) => area(b.bbox) - area(a.bbox));
    const panel = panels[0];
    if (!panel) return { modal_bbox: null, modal_confidence: null, buttons: [] };
    const [x,y,w,h] = panel.bbox;
    const roi = gray.roi(new cv.Rect(x,y,w,h));
    try {
      cv.Canny(roi, edges, 22, 55);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
      const candidates = contours(edges, cv.RETR_LIST).filter(({bbox: [u,v,bw,bh], fill}) =>
        u >= 3 && v >= 3 && u+bw <= w-3 && v+bh <= h-3 &&
        bh >= h*0.105 && bh <= h*0.24 && bw >= bh && bw <= w*0.65 && fill >= 0.78,
      ).sort((a,b) => area(b.bbox)-area(a.bbox));
      const buttons = [];
      for (const { bbox: [u,v,bw,bh], fill } of candidates) {
        const bbox = [x+u,y+v,bw,bh];
        if (buttons.some(button => iou(button.bbox,bbox) > 0.5)) continue;
        const cross = bw/bh < 1.45 ? crossScore(gray,bbox) : 0;
        if (process.env.MODAL_POC_DEBUG) console.log(bbox, fill, cross);
        if (cross < 0.55 && v+bh/2 < h*0.62) continue;
        buttons.push({ bbox, center: center(bbox), kind: cross >= 0.55 ? 'x' : 'confirmation',
          confidence: Number((0.56 + 0.35 * fill + 0.08 * cross).toFixed(3)) });
      }
      return { modal_bbox: panel.bbox, modal_confidence: Number(panel.fill.toFixed(3)), buttons };
    } finally {
      roi.delete();
    }
  } finally {
    mask.delete();
    edges.delete();
    kernel.delete();
  }
}

// Compare both dark diagonal strokes and the empty space around them.
function crossScore(gray, bbox) {
  const [x,y] = center(bbox);
  const radius = Math.round(bbox[3] * 0.18);
  let best = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      let on = 0, off = 0, onCount = 0, offCount = 0;
      for (let v = -radius; v <= radius; v++) {
        for (let u = -radius; u <= radius; u++) {
          const dark = gray.ucharAt(y+v+dy,x+u+dx) < 170;
          const distance = Math.min(Math.abs(u-v), Math.abs(u+v));
          if (distance <= 1) {
            on += Number(dark);
            onCount++;
          } else if (distance >= 3) {
            off += Number(dark);
            offCount++;
          }
        }
      }
      best = Math.max(best, on/onCount - off/offCount);
    }
  }
  return best;
}

const truth = JSON.parse(await readFile(join(here, 'ground-truth.json'), 'utf8'));
const records = JSON.parse(await readFile(join(instance, 'campaign-job-attempts.json'), 'utf8')).records;
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const languages = ['eng', 'vie'];
const langPath = ocrFlag === '--ocr' ? await mkdtemp(join(tmpdir(), 'modal-poc-ocr-')) : null;
let worker;

async function startOcr(folder) {
  for (const lang of languages) {
    const source = dirname(require.resolve('@tesseract.js-data/' + lang + '/package.json'));
    const name = lang + '.traineddata.gz';
    await copyFile(join(source, '4.0.0_best_int', name), join(folder, name));
  }
  const ocr = await Tesseract.createWorker(languages, Tesseract.OEM.LSTM_ONLY, {
    langPath: folder, cacheMethod: 'none',
  });
  return ocr;
}

function grade(detection, expected) {
  const overlap = detection.modal_bbox ? iou(detection.modal_bbox, expected.modal) : 0;
  const matches = expected.controls.map(control => detection.buttons.findIndex(button =>
    button.kind === expected.kind && contains(control, button.center, 2),
  ));
  const outside = detection.buttons.filter(button => !contains(expected.modal, button.center)).length;
  const correct = matches.filter(index => index >= 0).length;
  const falsePositives = detection.buttons.length - new Set(matches.filter(index => index >= 0)).size;
  const reasons = [];
  if (overlap < 0.9) reasons.push('Modal IoU below 0.90');
  if (correct < matches.length) reasons.push('Missing or misplaced controls');
  if (falsePositives) reasons.push('Extra candidates');
  return { modal_detected: Boolean(detection.modal_bbox), modal_iou: Number(overlap.toFixed(4)),
    correct, expected: matches.length, outside, false_positives: falsePositives, matches, reasons };
}

function annotation(width, height, result) {
  const rect = ([x,y,w,h], color) =>
    '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="none" stroke="'+color+'" stroke-width="2"/>';
  const boxes = result.modal_bbox ? [rect(result.modal_bbox, '#00cbff')] : [];
  for (const button of result.buttons) {
    const [x,y] = button.center;
    boxes.push(rect(button.bbox, '#36d659'), '<circle cx="'+x+'" cy="'+y+'" r="5" fill="#ff315b" stroke="white"/>');
  }
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'">'+boxes.join('')+'</svg>');
}

const results = [];
try {
  if (langPath) worker = await startOcr(langPath);
  for (const expected of truth) {
    const record = records.find(record => record.jobId === expected.job && record.attemptId === expected.attempt);
    const artifact = record?.localScreenshotArtifact;
    if (record?.status !== 'failed' || artifact?.screenshot_role !== 'failure' || artifact.status !== 'captured') {
      throw new Error('Missing captured failure for '+expected.job);
    }
    const image = basename(artifact.local_path);
    const input = await readFile(join(instance, 'artifacts', 'campaign-jobs', image));
    const hash = createHash('sha256').update(input).digest('hex');
    if (hash !== artifact.sha256) throw new Error('Screenshot hash mismatch for '+image);
    const { data, info } = await sharp(input).greyscale().raw().toBuffer({ resolveWithObject: true });
    const gray = cv.matFromArray(info.height, info.width, cv.CV_8UC1, data);
    let detection;
    try {
      detection = detect(gray);
    } finally {
      gray.delete();
    }
    if (worker) {
      for (const button of detection.buttons.filter(button => button.kind === 'confirmation')) {
        const [left,top,width,height] = button.bbox;
        const crop = await sharp(input).extract({ left,top,width,height }).resize(width*2).greyscale().png().toBuffer();
        const { data } = await worker.recognize(crop);
        button.ocr_support = { has_text: Boolean(data.text.trim()), confidence: data.confidence };
      }
    }
    const result = { image, sha256: hash, language: expected.language, layout: expected.kind,
      method: worker ? 'opencv+ocr-evidence' : 'opencv', ...detection, evaluation: grade(detection,expected) };
    await sharp(input).composite([{ input: annotation(info.width,info.height,result) }]).png().toFile(join(output,image));
    results.push(result);
  }
} finally {
  try {
    await worker?.terminate();
  } finally {
    if (langPath) {
      for (const lang of languages) {
        await unlink(join(langPath, lang + '.traineddata.gz')).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      await rmdir(langPath);
    }
  }
}
await writeFile(join(output,'results.json'), JSON.stringify(results,null,2)+'\n');
const rows = [['metric','correct','total']];
rows.push(['Modal IoU >= 0.90',results.filter(result => result.evaluation.modal_iou >= 0.9).length,results.length]);
for (const kind of ['x', 'confirmation']) {
  const cases = results.filter(result => result.layout === kind);
  rows.push([kind+' control centers', cases.reduce((sum,result) => sum+result.evaluation.correct,0),
    cases.reduce((sum,result) => sum+result.evaluation.expected,0)]);
}
await writeFile(join(output,'accuracy.csv'), rows.map(row => row.join(',')).join('\n')+'\n');
console.log(rows);
