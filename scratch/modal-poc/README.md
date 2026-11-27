# Offline modal and button detection POC

OpenCV found all seven modal panels and returned 12 click proposals. Each proposal fell inside a visually marked control with a 2 px safety inset. The seven annotated PNGs and the contact sheet are in `results/`. Cyan marks the modal, green marks candidate bounds, and pink marks proposed centers.

## Existing components

- **Creator and Client OCR.** Creator `src/main/ocr.ts` and Client `src/main/orc/ocr.ts` use Tesseract.js LSTM with locally bundled English and Vietnamese data. Both support grayscale 2× preprocessing, sparse text segmentation, overlapping crops for tall images and a second pass on tight chromatic button crops. They map OCR boxes back by dividing out the preprocessing scale and adding crop offsets. OCR text layout and boxes are reusable evidence through `LocalOcr.recognize`.
- **Template matching and ROI.** Creator `src/main/visual.ts` and Client `src/main/orc/visual.ts` implement Sharp-based bounded RGB template search from a recorded ROI, with optional expanded search and ambiguity checks. Client `src/main/orc/visual-executor.ts` checks screenshot and viewport dimensions and rejects mismatches. The Creator Visual Match Lab supports grayscale and edge pipelines, connected components, and OpenCV normalized template correlation with a JavaScript fallback. Its vendored asset reports OpenCV.js 5.0.0. The Client matching path inspected uses Sharp and JavaScript.
- **POC reuse.** `run.mjs` loads the existing OpenCV.js asset in Node and uses Sharp for decoding, crops and markup. OpenCV thresholds and closes the bright panel mask, ranks connected panels and detects closed button contours within the selected ROI. A two-diagonal shape score identifies an X anywhere inside the ROI. Other rectangular candidates are accepted in the lower modal region. ROI offsets are added once and all output is in native screenshot pixels. Optional OCR uses the installed worker and trained data on tight candidate crops. It supplies text-presence evidence only.

## Inputs and scoring

The seven job/attempt pairs in `ground-truth.json` are the captured failures in the QA instance logged navigating with `chaos=hell` from 11:27 to 11:48 Bangkok time on November 27, 2026. The last two have explicit X-close seeds. The log and attempt journal corroborate the job/attempt IDs and failure capture. The supplied campaign UUID is absent from those local records, so the campaign association is inferred from the matching run and dataset. All seven PNGs are 1024×560. The harness checks each against the SHA-256 in the journal.

Reference rectangles were marked from the original captures before scoring. A modal passes at bounding-box intersection over union of at least 0.90. A control passes when its proposed center is inside the manually marked rectangle by at least 2 px and its control type matches. An extra candidate is any proposal left unmatched. The reference describes visible controls from the static screenshots. Confidence is a heuristic from contour geometry and X-shape evidence, with no statistical calibration.

## Per-screenshot results

Every modal was detected. Every case had zero unmatched candidates, zero centers outside the reference modal and no scoring failures. The full boxes, centers, confidence and evaluations are in `results/results.json`. The requested accuracy table is `results/accuracy.csv`.

- **5c4a6cbf, Japanese.** Modal IoU 0.9931, modal confidence 0.990. Both confirmation controls hit at (752, 214) and (684, 214), confidence 0.900 and 0.901.
- **75cf440e, Vietnamese.** Modal IoU 0.9894, modal confidence 0.990. Both confirmation controls hit at (255, 214) and (175, 214), confidence 0.892 and 0.902.
- **745fe592, German.** Modal IoU 0.9895, modal confidence 0.991. Both confirmation controls hit at (751, 507) and (817, 507), confidence 0.893 and 0.901.
- **dd549ac9, Thai.** Modal IoU 0.9910, modal confidence 0.991. Both confirmation controls hit at (81, 507) and (171, 507), confidence 0.892 and 0.889.
- **e4cf6917, German.** Modal IoU 0.9885, modal confidence 0.992. Both stacked confirmation controls hit at (142, 247) and (142, 191), confidence 0.898 for each.
- **37b07128, French.** Modal IoU 0.9853, modal confidence 0.992. X hit at (438, 339), confidence 0.941.
- **f99394ff, Korean.** Modal IoU 0.9679, modal confidence 0.994. X hit at (962, 428), confidence 0.941. The bright mask omitted part of the dark left accent border.

## Limits and next step

Existing OCR and OpenCV are sufficient for this batch. All confirmation controls had visible outlines. The fixed brightness cutoff assumes a panel brighter than the dimmed background, and the contour stage needs a discernible boundary. Dark or undimmed panels, borderless or very low-contrast controls, controls clipped by the viewport, and different viewport/DPI settings are unverified. The lower-modal rule reflects the confirmation layouts in this run. The seven images also served as development examples, so the measured rates describe this batch only. OCR produced nonempty output on five of the ten confirmation crops, with no label-accuracy requirement.

For Add Error Tag, the smallest next step is a screenshot-only preview with editable target rectangles and explicit operator confirmation of the target. Validate it against a fresh set of captured failures that includes dark and borderless cases before connecting it to execution.

## Reproduce

From the reference repository, using the existing Node dependencies:

```powershell
node scratch/modal-poc/run.mjs 'D:/workspace-2026/rpa-sosial-automation-client/.local/instances/client-QA_SANDBOX_FACEBOOK' scratch/modal-poc/results --ocr
```

Omit `--ocr` for a geometry-only run. The harness reads local files and writes annotated screenshots, JSON and CSV.
