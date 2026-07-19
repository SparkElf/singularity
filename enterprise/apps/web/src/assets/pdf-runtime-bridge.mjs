import * as pdfJs from "/stage/protyle/js/pdf/pdf.min.mjs";

pdfJs.GlobalWorkerOptions.workerSrc = "/stage/protyle/js/pdf/pdf.worker.min.mjs";

globalThis.dispatchEvent(new CustomEvent("singularity:pdfjs-ready", {
  detail: pdfJs,
}));
